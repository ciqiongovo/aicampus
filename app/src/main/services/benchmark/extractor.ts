/**
 * 把一篇推文抽成结构化活动记录。
 *
 * 分工：先让模型判断「这是不是一篇活动通知」，是才让它填字段。
 * 不这么做的话，招生简章、成绩通报、党建学习都会被硬塞进七个字段里，
 * 反而污染对标库。
 *
 * 两条纪律：
 * - 模型没写的东西一律留空，不许它「根据常识补全」。时间地点补错一次，
 *   对标结论就全错了，而且错得很像对的。
 * - confidence 低于阈值由调用方标成待核对，不直接进统计。
 */

import type { AiConfigInput } from '../../../shared/types'
import type { BenchMigrationFit, BenchNoticeKind } from '../../../shared/benchmark'
import { chatCompletion } from '../ai/analyzer'

export interface ExtractedActivity {
  isActivity: boolean
  kind: string
  organizer: string
  startAt: string | null
  endAt: string | null
  weekNo: number | null
  location: string
  audience: string
  orgForm: string
  joinMethod: string
  coOrganizer: string
  duration: string
  scale: string
  promoChannels: string[]
  agenda: string[]
  highlights: string[]
  isSecondNotice: boolean
  noticeKind: BenchNoticeKind
  migrationFit: BenchMigrationFit
  migrationNote: string
  confidence: number
}

/**
 * 提示词模板。
 *
 * 本校条件由调用方传入（来自设置页）。写死在代码里看着能用，其实是坑：
 * 模型会按「一般大学」的想象去评可迁移性，而真正卡人的往往是具体条件——
 * 场地要提前几天申请、单场预算多少、有没有能容纳八百人的厅。
 * 这些只有本校的人知道，所以必须可改。
 */
export function buildSystemPrompt(ourContext: string): string {
  const context = ourContext.trim() || '（未填写本校条件）'
  return `你是高校学生活动信息的整理助手。给你一篇高校公众号推文，判断它是不是一篇「学生活动」的通知（晚会、比赛、讲座、沙龙、招新、志愿服务、运动会、展览等），如果是，抽出结构化字段。

本校情况（用于判断可迁移性）：${context}

只输出 JSON，不要任何解释文字。字段如下：
{
  "is_activity": true/false,
  "kind": "活动类型，从这些里选最贴近的一个：迎新晚会、毕业季活动、文艺演出、体育赛事、学术讲座、沙龙分享、竞赛、招新、志愿服务、展览、社会实践、全体大会、其他",
  "organizer": "主办单位，原文怎么写就怎么填，不要改写",
  "start_at": "开始时间，格式 YYYY-MM-DD HH:mm；只到日就写 YYYY-MM-DD；原文没写就 null",
  "end_at": "结束时间，同上；没写就 null",
  "week_no": "原文若明确写了「第 X 周」或「学期第 X 周」，填那个整数；没写就 null。不要自己拿日期推算",
  "location": "地点，原文写法；没写就空字符串",
  "audience": "面向对象，如 全校学生、本院学生、2026级新生、毕业生；没写就空字符串",
  "org_form": "组织方式，挑最贴切的短语组合，如 线下独办、线上线下结合、与学院合办、与社团合办、需报名筛选、自由参加",
  "join_method": "参与方式，如 线上报名、抢票、扫码进群、无需报名、直接到场；没写就空字符串",
  "co_organizer": "协办、承办、支持单位，原文怎么写就怎么填；没写就空字符串",
  "duration": "活动时长或起止范围，如 19:00–21:30、为期两天、持续一周；原文没写就空字符串",
  "scale": "规模，如 预计 800 人、覆盖 30 个班级、20 支队伍；只有原文写了数字才填，没写就空字符串",
  "promo_channels": ["文中提到的宣传或参与形式，如 直播、抽奖、海报、短视频、集赞、线上问卷；没有就给空数组"],
  "agenda": ["活动流程，按先后顺序逐个列出，如 开场致辞、颁奖、节目表演、合影；原文没写就空数组"],
  "highlights": ["这个活动里最不一样、最值得别人学的几处，如 用校园地标做打卡点、毕业生手写寄语墙、跨院系混编组队；原文没写就空数组"],
  "is_second_notice": true/false,
  "notice_kind": "is_second_notice 为 true 时填：reschedule（改期）/ venue_change（场地变更）/ cancel（取消）/ other；否则空字符串",
  "migration_fit": "结合上面本校情况，判断这件事搬到本校做不做得到：easy（现成条件就能办）/ possible（要协调场地或经费但可行）/ hard（需要大额经费或跨校资源）/ unsuitable（学制、规模或学科特点决定搬不过来）；判断不了就填空字符串",
  "migration_note": "一句话说明理由，必须指向原文里的具体做法，如「需百人以上场地与专业灯光，预算门槛高」；不要写空话",
  "confidence": 0 到 1 之间的小数，表示你对以上判断的整体把握
}

判定规则：
1. 只在原文明确写了的情况下填时间和地点。原文说「详见后续通知」「地点待定」就留空，不要推测，不要用「某教学楼」这类泛称填空。
2. 招生简章、成绩公示、人事任免、理论学习、纯图片推送不算活动，is_activity 填 false。
3. 二次通知指这件事之前已经通知过、这次是变更或补充（改期、换场地、取消、加场）。首次通知不算。
4. 一篇文章里有多个活动时，只抽最主要那一个。
5. agenda 只抽原文真正写出来的流程。原文没说议程就留空数组，不要按「一般晚会都有开场致辞」补。
6. highlights 与 agenda 不重复：agenda 是流程，highlights 是这套流程里别人没有的那几处。找不到就留空数组，不要拿「氛围热烈」「反响良好」这类宣传语凑数。
7. scale 只写原文给出的数量。写「数百人」「千余人」就照抄，不要换算成一个具体数字。`
}

/** 正文过长时截取首尾：活动要素通常出现在开头，变更说明常在文末 */
function trimBody(body: string, head = 2600, tail = 900): string {
  const text = body.replace(/\n{2,}/g, '\n').trim()
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n…（中略）…\n${text.slice(-tail)}`
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNullableDate(value: unknown): string | null {
  const text = asString(value)
  if (!text || /^(null|none|待定|未知)$/i.test(text)) return null
  // 只认形如 2026-09-05 或 2026-09-05 19:00 的写法，其它一律丢掉，
  // 免得把「九月中旬」这种模糊说法当日期入库
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text) ? text.replace('T', ' ') : null
}

function asNoticeKind(value: unknown, isSecond: boolean): BenchNoticeKind {
  if (!isSecond) return ''
  const text = asString(value)
  return text === 'reschedule' || text === 'venue_change' || text === 'cancel' || text === 'other'
    ? text
    : 'other'
}

const MIGRATION_FITS: BenchMigrationFit[] = ['easy', 'possible', 'hard', 'unsuitable', '']

function asMigrationFit(value: unknown): BenchMigrationFit {
  const text = asString(value)
  return (MIGRATION_FITS.find((f) => f === text) ?? '') as BenchMigrationFit
}

/** 周次只认 1-30 的整数；原文写「第三周」这种中文数字，模型一般已转成阿拉伯数字 */
function asWeekNo(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(asString(value))
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : null
}

function asStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
        .map(asString)
        .filter(Boolean)
        .slice(0, limit)
    : []
}

export interface ExtractInput {
  title: string
  body: string
}

/** 抽出活动；模型不可用或返回不可解析时抛错，由调用方决定重试 */
export async function extractActivity(
  cfg: AiConfigInput,
  input: ExtractInput,
  /** 本校条件，来自设置页；空串表示没填，提示词里会写明「未填写」 */
  ourContext = ''
): Promise<ExtractedActivity> {
  const user = `标题：${input.title}\n\n正文：\n${trimBody(input.body)}`
  const raw = await chatCompletion(cfg, buildSystemPrompt(ourContext), user, true)

  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // 有些模型会裹一层 ```json，剥掉再试一次
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('模型返回不是 JSON')
    data = JSON.parse(match[0]) as Record<string, unknown>
  }

  const isActivity = data.is_activity === true
  const isSecondNotice = data.is_second_notice === true
  const channels = asStringArray(data.promo_channels, 8)
  const agenda = asStringArray(data.agenda, 12)
  const highlights = asStringArray(data.highlights, 8)
  const rawConfidence = typeof data.confidence === 'number' ? data.confidence : 0

  return {
    isActivity,
    kind: isActivity ? asString(data.kind) : '',
    organizer: isActivity ? asString(data.organizer) : '',
    startAt: isActivity ? asNullableDate(data.start_at) : null,
    endAt: isActivity ? asNullableDate(data.end_at) : null,
    weekNo: isActivity ? asWeekNo(data.week_no) : null,
    location: isActivity ? asString(data.location) : '',
    audience: isActivity ? asString(data.audience) : '',
    orgForm: isActivity ? asString(data.org_form) : '',
    joinMethod: isActivity ? asString(data.join_method) : '',
    coOrganizer: isActivity ? asString(data.co_organizer) : '',
    duration: isActivity ? asString(data.duration) : '',
    scale: isActivity ? asString(data.scale) : '',
    promoChannels: isActivity ? channels : [],
    agenda: isActivity ? agenda : [],
    highlights: isActivity ? highlights : [],
    isSecondNotice: isActivity && isSecondNotice,
    noticeKind: asNoticeKind(data.notice_kind, isActivity && isSecondNotice),
    migrationFit: isActivity ? asMigrationFit(data.migration_fit) : '',
    migrationNote: isActivity ? asString(data.migration_note) : '',
    confidence: Number.isFinite(rawConfidence) ? Math.min(Math.max(rawConfidence, 0), 1) : 0
  }
}
