import type { DatabaseSync } from 'node:sqlite'
import type { AiConfigInput, AppSettings, CounterRecItem, CounterRecOpResult } from '../../../shared/types'
import type { SettingsStore } from '../../store/settings'
import { chatCompletion } from '../ai/analyzer'
import { createManualItem } from '../items/service'
import { CognitionService } from '../jarvis/cognition'
import { todayKey, type HotlistCandidate } from '../daily/service'

/**
 * P5 反推荐引擎（Q12 升级版=价值判断的另一半）：
 * 每日 ≤1 条、与画像距离最大且来源可信、以 JARVIS 提问形式出现、答「去」则转成事项。
 * 纯 DB + AI 调用（fetch/时间源可注入），无 electron 依赖，可直接单测。
 */

/** 对话调用签名（默认走 chatCompletion；测试注入桩函数，不触网） */
export type CounterRecChatFn = (cfg: AiConfigInput, system: string, user: string, jsonMode: boolean) => Promise<string>

/** 候选抓取器：实现 = DailyService.fetchEnabledItems（测试注入桩） */
export interface CounterCandidateFetcher {
  fetchEnabledItems(limitPerSource?: number): Promise<HotlistCandidate[]>
  snapshotCandidates?(limitPerSource?: number): HotlistCandidate[]
}

const SYSTEM_PROMPT = [
  '你是 InfoAgent 的「反推荐」引擎：帮助用户打破信息茧房。',
  '',
  '任务：从候选热点列表中，挑出与用户画像/已知信息距离最大、最可能拓展其视野、且来源可信的一条。',
  '',
  '输出要求：只输出一个 JSON 对象，格式 {"index": 候选编号, "reason": "推荐理由"}，不要任何解释或 markdown 围栏。',
  '- index 必须是候选列表里的编号（从 0 开始的整数）；没有合适候选时填 -1。',
  '- reason 用中文，不超过 80 字，说明为什么这条对「这个用户」值得知道（与他的关注圈相反、值得了解的原因）。',
  '',
  'JSON 字段名固定为：index, reason。'
].join('\n')

interface GateOpen {
  ok: true
  cfg: AiConfigInput
  settings: AppSettings
}
interface GateClosed {
  ok: false
  error: string
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch { /* 继续 */ }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* 落入下方抛错 */ }
  }
  throw new Error('反推荐模型未返回合法 JSON')
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

interface CounterRecRow {
  id: number
  date_key: string
  title: string
  source_label: string
  url: string | null
  reason: string
  status: string
  item_id: number | null
  created_at: string
}

export class CounterRecService {
  private generating = false

  constructor(
    private db: DatabaseSync,
    private store: SettingsStore,
    private fetcher: CounterCandidateFetcher,
    private chatFn: CounterRecChatFn = (cfg, system, user) => chatCompletion(cfg, system, user, true),
    /** 时间源注入（测试用），默认取系统时钟 */
    private now: () => Date = () => new Date()
  ) {}

  /** 与 M6/JARVIS 同一道门：配置 + 端点授权（A2） */
  private async gate(): Promise<GateOpen | GateClosed> {
    const s = await this.store.get()
    const policy=new CognitionService(this.db,this.now).agentPolicyGet()
    if(!policy.backgroundEnabled||!policy.readDomains.includes('daily')||!policy.readDomains.includes('article')) return {ok:false,error:'后台处理或日报数据权限已暂停，未生成反推荐'}
    if (!s.aiProvider || !s.aiBaseURL || !s.aiModel || (!s.aiIsLocal && !s.aiApiKey)) {
      return { ok: false, error: '尚未配置 AI 服务商，无法生成反推荐' }
    }
    if (!s.aiAuthorizedFor || s.aiAuthorizedFor !== s.aiProvider + '|' + s.aiBaseURL) {
      return { ok: false, error: 'AI 尚未授权，无法生成反推荐' }
    }
    return {
      ok: true,
      cfg: { provider: s.aiProvider, baseURL: s.aiBaseURL, model: s.aiModel, apiKey: s.aiApiKey },
      settings: s
    }
  }

  private buildPrompt(_s: AppSettings, candidates: HotlistCandidate[]): string {
    const lines: string[] = ['候选来自已落库日报快照；通常只有热榜标题，不等于新闻全文。反推荐是独立旧策略，不是新版固定关注/动态发现。']
    const memories = new CognitionService(this.db,this.now).relevantMemories(candidates.map(c=>c.title).join(' ')).fresh.filter(m=>m.lastConfirmedAt!==null)
    if (memories.length) {
      lines.push('已记住的用户信息：')
      for (const m of memories) lines.push('- ' + m.content)
    }
    lines.push('候选热点（编号从 0 开始）：')
    candidates.forEach((c, i) => {
      lines.push(i + '. ' + c.title + '（来源：' + c.sourceLabel + (c.score !== null ? '，热度 ' + Math.round(c.score) : '') + '）')
    })
    return lines.join('\n')
  }

  private rowToItem(row: CounterRecRow): CounterRecItem {
    const status = row.status === 'done' || row.status === 'ignored' ? row.status : 'pending'
    return {
      id: row.id,
      dateKey: row.date_key,
      title: row.title,
      sourceLabel: row.source_label,
      url: row.url,
      reason: row.reason,
      status,
      itemId: row.item_id,
      createdAt: row.created_at
    }
  }

  private rowByDate(key: string): CounterRecItem | null {
    const row = this.db.prepare('SELECT * FROM counter_rec WHERE date_key = ?').get(key) as CounterRecRow | undefined
    return row ? this.rowToItem(row) : null
  }

  private rowById(id: number): CounterRecItem | null {
    const row = this.db.prepare('SELECT * FROM counter_rec WHERE id = ?').get(id) as CounterRecRow | undefined
    return row ? this.rowToItem(row) : null
  }

  /** 今天的反推荐条目（无则 null）——JARVIS 据此渲染提问卡片 */
  today(): CounterRecItem | null {
    return this.rowByDate(todayKey(this.now()))
  }

  /**
   * 生成今天的反推荐（幂等）：已有且非 force 直接返回；force 刷新内容并重置为待处理。
   * AI 门禁、候选抓取、模型挑选（与画像距离最大且来源可信）三步全过才落库。
   */
  async generate(force = false): Promise<CounterRecOpResult> {
    const key = todayKey(this.now())
    const existing = this.rowByDate(key)
    if (existing && !force) return { ok: true, message: '今天的反推荐已生成', item: existing }
    if (this.generating) return { ok: false, message: '反推荐正在生成中，请稍候' }
    const gate = await this.gate()
    if (!gate.ok) return { ok: false, message: gate.error }
    this.generating = true
    try {
      const candidates = this.fetcher.snapshotCandidates ? this.fetcher.snapshotCandidates(8) : await this.fetcher.fetchEnabledItems(8)
      if (candidates.length === 0) return { ok: false, message: '没有可用的热点条目，无法生成反推荐' }
      const raw = await this.chatFn(gate.cfg, SYSTEM_PROMPT, this.buildPrompt(gate.settings, candidates), true)
      const parsed = safeJsonParse(raw) as Record<string, unknown>
      const index = typeof parsed.index === 'number' && Number.isInteger(parsed.index) ? parsed.index : -1
      if (index < 0 || index >= candidates.length) return { ok: false, message: '模型未选出有效候选，已放弃本次反推荐' }
      const reason = asString(parsed.reason).trim().slice(0, 200) || '这条热点离你的关注圈最远，但值得知道。'
      const pick = candidates[index]
      if (existing) {
        this.db
          .prepare("UPDATE counter_rec SET title = ?, source_label = ?, url = ?, reason = ?, status = 'pending', item_id = NULL, acted_at = NULL WHERE id = ?")
          .run(pick.title, pick.sourceLabel, pick.url, reason, existing.id)
        return { ok: true, message: '反推荐已刷新', item: this.rowById(existing.id) }
      }
      this.db
        .prepare('INSERT INTO counter_rec (date_key, title, source_label, url, reason) VALUES (?, ?, ?, ?, ?)')
        .run(key, pick.title, pick.sourceLabel, pick.url, reason)
      return { ok: true, message: '反推荐已生成', item: this.rowByDate(key) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.generating = false
    }
  }

  /** 处理反推荐：go=转成事项（有限执行，等同 JARVIS 建事项），ignore=忽略 */
  act(id: number, action: 'go' | 'ignore'): CounterRecOpResult {
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: '无效的反推荐条目' }
    if (action !== 'go' && action !== 'ignore') return { ok: false, message: '无效的操作' }
    const row = this.db.prepare('SELECT * FROM counter_rec WHERE id = ?').get(id) as CounterRecRow | undefined
    if (!row) return { ok: false, message: '反推荐条目不存在' }
    if (row.status !== 'pending') return { ok: false, message: row.status === 'done' ? '这条反推荐已转成事项' : '这条反推荐已忽略' }
    if (action === 'go') {
      const settings = this.store.peek()
      const res = createManualItem(
        this.db,
        { title: row.title, notes: '反推荐来源：' + row.source_label + '。' + row.reason, category: '可选机会' },
        settings.reminderEnabled ? settings.reminderAdvanceMinutes : null
      )
      if (!res.ok || res.id === undefined) return { ok: false, message: res.message }
      this.db
        .prepare("UPDATE counter_rec SET status = 'done', item_id = ?, acted_at = datetime('now','localtime') WHERE id = ?")
        .run(res.id, id)
      return { ok: true, message: '已转成事项，可到信息面板查看', item: this.rowById(id) }
    }
    this.db.prepare("UPDATE counter_rec SET status = 'ignored', acted_at = datetime('now','localtime') WHERE id = ?").run(id)
    return { ok: true, message: '已忽略这条反推荐', item: this.rowById(id) }
  }
}
