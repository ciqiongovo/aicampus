import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  BookOutlined,
  CloudDownloadOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UserSwitchOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ModuleManifest } from './types'
import { PREF } from '../prefs'
import type {
  BenchArticleDetail,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchArticleStatus,
  BenchAuditResult,
  BenchBrief,
  BenchCompareTopic,
  BenchProgressEvent,
  BenchProspectInfo,
  BenchSchoolInfo,
  BenchSourceCategory,
  BenchSourceInfo,
  BenchStats
} from '../../../shared/benchmark'
import './benchmark.css'

const STATUS_TEXT: Record<BenchArticleStatus, { text: string; color: string }> = {
  new: { text: '待采集', color: 'default' },
  fetched: { text: '已取正文', color: 'blue' },
  parsed: { text: '已抽取', color: 'green' },
  deleted: { text: '原文已删', color: 'red' },
  unreachable: { text: '暂不可见', color: 'orange' }
}

const NOTICE_TEXT: Record<string, string> = {
  reschedule: '改期',
  venue_change: '换场地',
  cancel: '取消',
  other: '二次通知'
}

/** 可迁移性四档的说法。用词要能直接念给人听，不要写 high/medium */
const MIGRATION_TEXT: Record<string, string> = {
  easy: '现成条件可办',
  possible: '协调后可行',
  hard: '门槛较高',
  unsuitable: '不适合搬',
  '': ''
}

const PROSPECT_TEXT: Record<string, { text: string; cls: string }> = {
  untried: { text: '未找', cls: '' },
  found: { text: '找到了', cls: 'bench-prospect-found' },
  empty: { text: '没找到', cls: '' },
  blocked: { text: '被拦', cls: 'bench-prospect-blocked' }
}

function shortDate(value: string | null): string {
  if (!value) return '—'
  return value.slice(0, 16)
}

/** 本地日期 YYYY-MM-DD；用本地时间而不是 toISOString，否则晚上 8 点后会少一天 */
function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function BenchmarkPage(): JSX.Element {
  const { message, modal } = AntApp.useApp()

  const [stats, setStats] = useState<BenchStats | null>(null)
  const [rows, setRows] = useState<BenchArticleInfo[]>([])
  const [schoolOptions, setSchoolOptions] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [schoolList, setSchoolList] = useState<BenchSchoolInfo[]>([])
  const [sources, setSources] = useState<BenchSourceInfo[]>([])

  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<BenchProgressEvent | null>(null)
  /** 批量补采跑到第几所。为 null 表示这不是一次批量 */
  const [batchInfo, setBatchInfo] = useState<{ i: number; total: number } | null>(null)

  const [detail, setDetail] = useState<BenchArticleDetail | null>(null)
  const [peers, setPeers] = useState<BenchArticleDetail[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [brief, setBrief] = useState<BenchBrief | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const [compare, setCompare] = useState<BenchArticleDetail[] | null>(null)

  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSchool, setNewSchool] = useState('')
  const [newCategory, setNewCategory] = useState<BenchSourceCategory>('student_union')

  /**
   * 数据体检结果。
   *
   * 一开始只在打开抽屉时拉，后来改了：里面「有 20 条不像活动」这件事
   * 恰恰是必须先让人看见的——藏进抽屉，用户会拿被污染的 50 条去做判断。
   * 两张小表各扫一遍，代价可以忽略。
   */
  const [audit, setAudit] = useState<BenchAuditResult | null>(null)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgePicked, setPurgePicked] = useState<number[]>([])
  /** 待剔除的「不像活动」条目（articleId） */
  const [offPicked, setOffPicked] = useState<number[]>([])

  /** 账号清单抽屉：看某所学校打算找哪些号、哪些找着了 */
  const [accountsSchool, setAccountsSchool] = useState<BenchSchoolInfo | null>(null)
  const [prospects, setProspects] = useState<BenchProspectInfo[]>([])
  const [extraAccount, setExtraAccount] = useState('')

  /**
   * 搜完要不要接着采正文、抽字段。
   *
   * 默认开。第一次用的人点「找文章」之后，界面会回到安静状态，
   * 他还得自己发现下面第 2 步要再点两次——这个坎多数人过不去。
   * 关掉它则保留「只搜不采」的用法：搜索有配额，想先囤链接时有用。
   */
  const [autoChain, setAutoChain] = useState(
    () => window.localStorage.getItem('zhishu.bench.autoChain') !== '0'
  )

  const [school, setSchool] = useState('')
  const [kind, setKind] = useState('')
  const [keyword, setKeyword] = useState('')
  const [secondOnly, setSecondOnly] = useState(false)
  /**
   * 时间窗口。默认「全部」：库里这 39 场是跨年份采的，默认给近一年只剩 7 场，
   * 简报一下就薄了。想看一年自己切，切过之后记住，不必每次重开都再点一遍。
   */
  const [range, setRange] = useState<'all' | 'half' | 'year'>(() => {
    const saved = window.localStorage.getItem(PREF.benchRange)
    return saved === 'all' || saved === 'half' || saved === 'year' ? saved : 'all'
  })
  useEffect(() => {
    window.localStorage.setItem(PREF.benchRange, range)
  }, [range])

  const homeSchool = useMemo(() => schoolList.find((s) => s.isHome) ?? null, [schoolList])
  /** 源表里改归属用的下拉项：只给清单里的全称，别让人敲错字 */
  const schoolNames = useMemo(() => schoolList.map((s) => s.name), [schoolList])
  const withData = useMemo(() => schoolList.filter((s) => s.articleCount > 0), [schoolList])

  /**
   * 当前筛选结果里的活动条数。
   *
   * 列表已经被时间窗筛过一遍，所以这个数就是「眼前这一屏有多少场」，
   * 和生成简报用的是同一批条目。列表还没加载完时给 null，免得闪一下 0。
   */
  const filteredActivities = useMemo(
    () => (rows.length ? rows.filter((r) => r.isActivity === true).length : null),
    [rows]
  )
  /**
   * 默认只摆出「已经采到东西的」和本校。
   * 28 张卡片一次铺开会把第一步撑满整屏，而第一次打开的人真正要看的是
   * 「哪些学校我已经有数据了」，不是「理论上能采多少所」。
   */
  const [showAllSchools, setShowAllSchools] = useState(false)
  const visibleSchools = useMemo(
    () => (showAllSchools ? schoolList : schoolList.filter((s) => s.isHome || s.articleCount > 0)),
    [schoolList, showAllSchools]
  )

  /** 当前筛选条件。列表和简报共用同一份，保证「看到什么就导出什么」 */
  const currentFilter = useCallback(
    (): BenchArticleFilter => ({
      school: school || undefined,
      kind: kind || undefined,
      keyword: keyword || undefined,
      secondNoticeOnly: secondOnly || undefined,
      from: range === 'all' ? undefined : daysAgo(range === 'year' ? 365 : 180),
      limit: 200
    }),
    [school, kind, keyword, secondOnly, range]
  )

  const load = useCallback(async () => {
    const filter = currentFilter()
    const [nextStats, nextRows, nextSchools, nextKinds, nextSchoolList, nextSources] =
      await Promise.all([
        window.api.benchStats(),
        window.api.benchArticles(filter),
        window.api.benchSchools(),
        window.api.benchKinds(),
        window.api.benchSchoolList(),
        window.api.benchSources()
      ])
    setStats(nextStats)
    setRows(nextRows)
    setSchoolOptions(nextSchools)
    setKinds(nextKinds)
    setSchoolList(nextSchoolList)
    setSources(nextSources)
  }, [currentFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void window.api
      .benchAudit()
      .then((a) => {
        setAudit(a)
        // 默认全选：二十条一条条点太累了，而这里列出来的都是规则已经否掉的
        // （人物报道、候选人公示、月度汇总），看着不对的可以手工取消
        setOffPicked(a.offTopic.map((x) => x.articleId))
      })
      .catch(() => undefined)
    // stats.activities 变化意味着库里的活动变了（采集、抽取、剔除），要重判
  }, [sourcesOpen, stats?.activities])

  // 查找进度由主进程推过来：一次查找要跑几十秒，没有反馈用户会以为卡死
  useEffect(() => {
    return window.api.benchOnProgress((e) => setProgress(e))
  }, [])

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setBusy(label)
    try {
      const tip = await action()
      await load()
      if (tip) message.success(tip)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
      setProgress(null)
    }
  }

  // ---------------- 第一步：按学校找 ----------------

  /**
   * 去一所学校找文章。
   *
   * 这一步慢是常态：每个账号之间要停三五秒，不然搜索引擎立刻要求验证码。
   * 所以按钮上直接写「约 1 分钟」，而不是让人对着转圈猜。
   */
  /**
   * 把「待采集」和「待抽取」两个队列往前推，直到空了或撞上验证。
   *
   * 为什么要有上限：库里的积压可能是三百条，一个点下去永远不结束的按钮
   * 比没这个按钮更糟。四轮、每轮十五篇，单次最多推六十篇，
   * 推不完会在提示里说还剩多少，让人再点一次。
   */
  const drainQueue = async (): Promise<{
    fetched: number
    activities: number
    blocked: boolean
    rest: number
  }> => {
    let fetched = 0
    let activities = 0
    let blocked = false
    // 一次推 13 轮、每轮 15 篇，约 200 篇。
    // 全量导入之后队列常有几百上千条，按原来的 60 篇截断，用户得点十几次；
    // 但也别无限跑——中途撞上验证，跑得越久浪费越多。
    for (let round = 0; round < 13; round++) {
      const s = await window.api.benchStats()
      // unreachable 也要算活：它们在主进程里会被放回队列重试，
      // 如果只看 pending，剩下一条打不开的死链就永远轮不到重试
      if (s.pending <= 0 && s.unreachable <= 0) break
      const r = await window.api.benchFetch(15)
      fetched += r.fetched
      if (r.blocked) {
        blocked = true
        break
      }
      // 本来就没有待采的，这一轮也没采到东西 —— 那是在重试旧的失败项，
      // 再跑第二轮只会拿同一条链再撞一次墙
      if (s.pending <= 0 && r.fetched === 0) break
    }
    // 被拦了就别接着抽：抽的是已经采到的正文，跟搜索无关，但这时候
    // 整条链路都该停下来让人歇一会儿，免得连着两条红字
    for (let round = 0; round < 13 && !blocked; round++) {
      if ((await window.api.benchStats()).unparsed <= 0) break
      const r = await window.api.benchExtract(15)
      activities += r.activities
    }
    const after = await window.api.benchStats()
    return { fetched, activities, blocked, rest: after.pending + after.unparsed }
  }

  const discover = (target: BenchSchoolInfo): void => {
    if (busy) {
      message.info('上一个动作还没跑完，等它结束再点')
      return
    }
    setProgress({ school: target.name, current: 0, total: 0, account: '', note: '准备中' })
    void run(`discover:${target.name}`, async () => {
      const r = await window.api.benchDiscover(target.name)
      if (r.blocked) {
        // 被拦不是「没找到」，是「现在别再试了」，两种说法要分开
        message.warning(r.message)
        return ''
      }
      if (!r.accepted) {
        message.info(r.message)
        return ''
      }
      if (!autoChain) return `${target.name}：${r.message}`

      const d = await drainQueue()
      if (d.blocked) {
        message.warning('采集中途撞上微信验证，先停下。过 20–30 分钟再点「跑完队列」')
      }
      return [
        `${target.name}：${r.message}`,
        d.fetched ? `采到正文 ${d.fetched} 篇` : '',
        d.activities ? `抽出活动 ${d.activities} 场` : '',
        d.rest > 0 ? `还剩 ${d.rest} 篇，再点一次「跑完队列」` : '已全部入库'
      ]
        .filter(Boolean)
        .join('，')
    })
  }

  const doDrain = (): void => {
    void run('drain', async () => {
      const d = await drainQueue()
      if (d.blocked) {
        message.warning('采集又撞上验证了，歇 20–30 分钟再来')
      }
      if (!d.fetched && !d.activities) {
        return d.rest > 0 ? `队列里还剩 ${d.rest} 篇，这次一篇没动` : '队列已经是空的'
      }
      return [
        d.fetched ? `采到正文 ${d.fetched} 篇` : '',
        d.activities ? `抽出活动 ${d.activities} 场` : '',
        d.rest > 0 ? `还剩 ${d.rest} 篇，再点一次` : '队列已清空'
      ]
        .filter(Boolean)
        .join('，')
    })
  }

  /**
   * 一次补几所「几乎没数据」的学校。
   *
   * 为什么要有这个：库里 13 所学校、有 5 所只有一两篇，凑在一起没法比。
   * 一所一所点，每次都得等十几秒再找下一张卡片——真正想做的是「把空的那几所填一下」，
   * 这个动作该有一个按钮。
   *
   * 为什么不放在主进程做：每所学校的搜索各自有配额与节流，串行调用现成的
   * benchDiscover 就能继承那套保护（连续两次被拦就收工）。再写一条批量通道，
   * 等于把同一套节流复制一遍，两处迟早不一致。
   */
  const discoverBatch = (): void => {
    if (busy) {
      message.info('上一个动作还没跑完，等它结束再点')
      return
    }
    /*
     * 按「活动」挑，不按「文章」挑。
     *
     * 上科大名下有 27 篇文章，但只有 4 场活动——它那几个号本来就不怎么发活动。
     * 按文章数排队，它永远排不进「最缺」，而真正缺的是活动不足 2 场、
     * 连对比表都进不去的那几所。文章数加个上限，是防止反复去搜同一所：
     * 搜过一轮之后文章数会明显上涨，自然就不在候选里了。
     */
    const targets = schoolList
      .filter((s) => s.activityCount < 2 && s.articleCount < 6)
      .sort(
        (a, b) =>
          a.activityCount - b.activityCount ||
          a.articleCount - b.articleCount ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 5)
    if (!targets.length) {
      message.info('每所学校都有 2 场以上活动了，暂时不用补')
      return
    }

    void run('batch', async () => {
      const gained: string[] = []
      const failed: string[] = []
      let blocked = ''
      for (const [i, t] of targets.entries()) {
        setBatchInfo({ i: i + 1, total: targets.length })
        try {
          const r = await window.api.benchDiscover(t.name)
          if (r.blocked) {
            blocked = r.message
            break
          }
          if (r.accepted) gained.push(`${t.name} +${r.accepted}`)
          else failed.push(t.name)
        } catch (error) {
          failed.push(t.name)
        }
      }
      if (blocked) {
        return `补到一半被拦下（${blocked}）。已入队：${gained.join('、') || '无'}。过 20–30 分钟再点一次`
      }
      if (!gained.length) {
        return `这 ${targets.length} 所都没搜到新文章，换几个账号名再试（点学校卡片上的「账号」）`
      }
      return `补了 ${gained.length} 所：${gained.join('、')}。${
        failed.length ? `没搜到：${failed.join('、')}。` : ''
      }接着点「跑完队列」把正文和字段补上`
    }).finally(() => setBatchInfo(null))
  }

  const setHome = (name: string): void => {
    void run('home', async () => {
      await window.api.benchSchoolHome(name)
      return `本校已设为「${name}」`
    })
  }

  const importSeeds = (): void => {
    void run('seed', async () => {
      const r = await window.api.benchSeedImport()
      if (!r.accepted) return '内置样本都已经在库里了'
      return `已导入内置样本 ${r.accepted} 篇（重复 ${r.duplicated} 篇），接着点「采集正文」`
    })
  }

  const openAccounts = (target: BenchSchoolInfo): void => {
    setAccountsSchool(target)
    setExtraAccount('')
    void window.api.benchProspects(target.name).then(setProspects)
  }

  const addAccountAndDiscover = (): void => {
    const target = accountsSchool
    const name = extraAccount.trim()
    if (!target || !name) return
    void run('discover', async () => {
      const r = await window.api.benchDiscover(target.name, [name])
      const next = await window.api.benchProspects(target.name)
      setProspects(next)
      return r.accepted ? `${name}：${r.message}` : `${name}：${r.message}`
    })
  }

  // ---------------- 第二步：采内容 ----------------

  const doImport = (): void => {
    void run('import', async () => {
      const r = await window.api.benchImportLinks(importText)
      setImportOpen(false)
      setImportText('')
      const parts = [`新增 ${r.accepted} 篇`]
      if (r.duplicated) parts.push(`重复 ${r.duplicated} 篇`)
      if (r.invalid) parts.push(`无法识别 ${r.invalid} 条`)
      return `已入队：${parts.join('，')}`
    })
  }

  /**
   * 整份文件导入。
   *
   * 一个号的历史列表动辄几百上千条，粘贴框放不下，也不该让人手动复制。
   * 文件里如果有标题和时间（工具导出的 CSV 都有），会一起落库——
   * 这样正文还没抓的时候，列表也能先显出「这个号有多少篇」。
   */
  const doImportFile = (): void => {
    void run('import', async () => {
      const r = await window.api.benchImportFile()
      if (r.canceled) return ''
      const name = r.file.split(/[\\/]/).pop() ?? '文件'
      const parts = [`新增 ${r.accepted} 篇`]
      if (r.duplicated) parts.push(`重复 ${r.duplicated} 篇`)
      if (r.invalid) parts.push(`无法识别 ${r.invalid} 条`)
      setImportOpen(false)
      setImportText('')
      return `${name}：${parts.join('，')}`
    })
  }

  const doFetch = (): void => {
    void run('fetch', async () => {
      const r = await window.api.benchFetch(20)
      const parts = [`正文可抽 ${r.fetched}`]
      if (r.imageOnly) parts.push(`纯图 ${r.imageOnly}`)
      if (r.deleted) parts.push(`原文已删 ${r.deleted}`)
      if (r.unreachable) parts.push(`暂不可见 ${r.unreachable}`)
      // 撞验证时要说清楚是怎么回事，否则用户只会看到一串失败反复重试
      if (r.blocked) parts.push('连续撞上微信验证，已提前停止，过 20–30 分钟再试')
      // 一次只跑 20 篇。不说还剩多少，用户会以为「采集完成」= 全采完了
      const after = await window.api.benchStats()
      if (after.pending > 0) parts.push(`队列还剩 ${after.pending} 篇，再点一次接着采`)
      return `采集完成：${parts.join('，')}`
    })
  }

  const doExtract = (): void => {
    void run('extract', async () => {
      const r = await window.api.benchExtract(20)
      const byRule = r.mode === 'rule' ? '（未配模型，按规则抽取，细节字段会少一些）' : ''
      const after = await window.api.benchStats()
      const rest = after.unparsed > 0 ? `，还有 ${after.unparsed} 篇待抽取` : ''
      return `抽取完成${byRule}：活动 ${r.activities}，非活动 ${r.skipped}，失败 ${r.failed}${rest}`
    })
  }

  // ---------------- 第三步：看结果 ----------------

  const openDetail = (id: number): void => {
    void window.api.benchArticle(id).then((d) => {
      setDetail(d)
      setPeers([])
      // 本校做法随手带上：看完外校的下一步必然是「那我们呢」
      if (d && !d.isHome) void window.api.benchHomeCompare(id).then(setPeers)
    })
  }

  /**
   * 生成简报。
   *
   * withRange 用来从简报抽屉里就地切换时间窗——抽屉打开时，下拉在身后被遮住，
   * 让人关掉抽屉、改下拉、再点一次，中间那两步纯属折腾。
   * 传了就用传的，不能先 setRange 再读 currentFilter：setState 是异步的，
   * 那一刻读到的还是旧值，生成出来仍是刚才那批。
   */
  const doBrief = (withRange?: 'all' | 'half' | 'year'): void => {
    if (withRange) setRange(withRange)
    void run('brief', async () => {
      const base = currentFilter()
      const filter: BenchArticleFilter = withRange
        ? { ...base, from: withRange === 'all' ? undefined : daysAgo(withRange === 'year' ? 365 : 180) }
        : base
      const next = await window.api.benchBrief(filter)
      setBrief(next)
      return next.activityCount
        ? `简报已生成：${next.schoolCount} 所学校、${next.activityCount} 条记录`
        : '没有符合条件的活动，可以先放宽时间范围或补采几个公众号'
    })
  }

  const saveBrief = (): void => {
    if (!brief) return
    void window.api.appSaveText(`${brief.title || '简报'}.md`, brief.markdown).then((r) => {
      // 用户自己按了取消，不该弹红条
      if (r.canceled) return
      if (r.ok) message.success(`已保存到 ${r.path}`)
      else message.error(r.message || '保存失败')
    })
  }

  const copyBrief = (): void => {
    if (!brief) return
    void navigator.clipboard
      .writeText(brief.markdown)
      .then(() => message.success('已复制，可直接粘进文档或群聊'))
      .catch(() => message.error('复制失败，可以全选下面的文字手动复制'))
  }

  /**
   * 导出 HTML 报告。
   *
   * 与「存成文件」并列而不是取代它：md 是给自己改的，html 是给别人看的。
   * 报告内容由主进程按同一份简报重算，不是把屏幕上这段 markdown 包个壳，
   * 两边的数才会永远对得上。
   */
  const saveReport = (): void => {
    if (!brief) return
    void run('report', async () => {
      const html = await window.api.benchReport(currentFilter())
      const r = await window.api.appSaveText(`${brief.title || '对标报告'}.html`, html, 'html')
      if (r.canceled) return ''
      if (!r.ok) throw new Error(r.message || '保存失败')
      return `报告已保存：${r.path}　双击可看，Ctrl+P 直接印`
    })
  }

  const addSource = (): void => {
    if (!newName.trim()) {
      message.info('先填公众号名称')
      return
    }
    void run('source', async () => {
      await window.api.benchSourceAdd({
        name: newName.trim(),
        school: newSchool.trim(),
        category: newCategory
      })
      setNewName('')
      setNewSchool('')
      return `已加入：${newSchool.trim() || '（未填学校）'} / ${newName.trim()}`
    })
  }

  const setSourceSchool = (id: number, name: string): void => {
    void run('source', async () => {
      const changed = await window.api.benchSourceSchool(id, name)
      if (!changed) return ''
      setAudit(await window.api.benchAudit())
      return name ? `已归到「${name}」` : '已清空归属'
    })
  }

  const toggleSource = (id: number, enabled: boolean): void => {
    void run('source', async () => {
      await window.api.benchSourceToggle(id, enabled)
      return ''
    })
  }

  const removeSource = (id: number, name: string): void => {
    void run('source', async () => {
      await window.api.benchSourceRemove(id)
      return `已移除「${name}」，它的历史文章留在库里`
    })
  }

  /**
   * 打开清理弹窗。
   *
   * 默认全选，让人「取消勾选要留的」而不是「勾选要删的」——这批号里绝大多数
   * 确实是跑偏带进来的，一个个点 31 下没人受得了；而真要留下某个正牌号，
   * 取消一个勾比在 31 行里找它还容易。
   */
  /**
   * 人工否决一条抽取结果。
   *
   * 规则抽取会把「院长一行访问某校」这类新闻稿当成沙龙分享。改词表永远追不上，
   * 所以给一个按钮：删掉这条活动记录，原文留着，简报不再计入。
   */
  const markNotActivity = (d: BenchArticleDetail): void => {
    modal.confirm({
      title: '这篇不是活动？',
      content: (
        <div>
          <p>会删掉这条记录的类型、时间、地点等字段，简报不再计入它。原文和链接都还在。</p>
          <p className="bench-muted">{d.title || d.url}</p>
        </div>
      ),
      okText: '确认不是',
      cancelText: '再想想',
      onOk: () =>
        run('notactivity', async () => {
          const ok = await window.api.benchMarkNotActivity(d.id)
          setDetail(null)
          return ok ? '已剔除，简报不再计入这一条' : '没改到，可能这篇本来就没有活动记录'
        })
    })
  }

  const openPurge = (): void => {
    setPurgePicked((audit?.suspicious ?? []).map((x) => x.id))
    setPurgeOpen(true)
  }

  const doPurge = (): void => {
    const rows = (audit?.suspicious ?? []).filter((x) => purgePicked.includes(x.id))
    if (!rows.length) {
      message.info('没勾任何号，什么都不会删')
      return
    }
    void run('purge', async () => {
      const r = await window.api.benchPurgeSources(rows.map((x) => x.id))
      setAudit(await window.api.benchAudit())
      setPurgeOpen(false)
      return `已删 ${r.sources} 个号、${r.articles} 篇文章`
    })
  }

  const doDropOffTopic = (): void => {
    if (!offPicked.length) {
      message.info('没勾任何条，什么都不会动')
      return
    }
    void run('offtopic', async () => {
      const n = await window.api.benchMarkNotActivityMany(offPicked)
      setOffPicked([])
      setAudit(await window.api.benchAudit())
      return n
        ? `已剔除 ${n} 条，简报和对比不再计入；原文和链接都还在库里`
        : '这几条已经不在了，可能刚清过'
    })
  }

  const doCompare = (): void => {
    if (picked.length < 2) {
      message.info('至少勾两篇才能比')
      return
    }
    void run('compare', async () => {
      const list = await Promise.all(picked.map((id) => window.api.benchArticle(id)))
      setCompare(list.filter((x): x is BenchArticleDetail => !!x))
      return ''
    })
  }

  const columns: ColumnsType<BenchArticleInfo> = [
    {
      title: '标题',
      dataIndex: 'title',
      // 标题长短差得远（有的带整串活动名，有的只有一个词）。不锁单行的话，
      // 长标题折成三四行，行高参差不齐，扫一眼看不出哪几篇是一类。
      ellipsis: true,
      render: (_v, row) => (
        <Typography.Link onClick={() => openDetail(row.id)}>
          {row.title || row.url.slice(0, 40)}
        </Typography.Link>
      )
    },
    {
      title: '学校',
      dataIndex: 'school',
      // 要放得下「上海科技大学」＋一个「本校」标签，窄了会折成两行
      width: 142,
      render: (v: string, row) =>
        v ? (
          <Space size={4}>
            <span>{v}</span>
            {row.isHome ? <Tag color="purple">本校</Tag> : null}
          </Space>
        ) : (
          <span className="bench-muted">待识别</span>
        )
    },
    { title: '公众号', dataIndex: 'sourceName', width: 112, ellipsis: true, render: (v: string) => v || '—' },
    {
      title: '发布时间',
      dataIndex: 'publishedAt',
      // 「2026-10-11 19:52」是一行放得下的最小宽度，再窄就折成两行
      width: 126,
      render: (v: string | null) => shortDate(v)
    },
    {
      // 周次前面那个「约」不能省：这个数多半是按日期和开学日推出来的，
      // 不是原文写的。各校校历不同，标成确数会被当成依据。
      title: '周次',
      dataIndex: 'weekNo',
      width: 62,
      render: (v: number | null) => (v ? `约${v}周` : '—')
    },
    { title: '类型', dataIndex: 'kind', width: 82, render: (v: string) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 76,
      render: (v: BenchArticleStatus) => <Tag color={STATUS_TEXT[v].color}>{STATUS_TEXT[v].text}</Tag>
    },
    {
      title: '标记',
      dataIndex: 'isSecondNotice',
      width: 72,
      render: (v: boolean, row) =>
        v ? (
          <Tooltip title="这篇是改期/换场地/取消之类的二次通知">
            <Tag color="volcano">{NOTICE_TEXT[row.noticeKind] ?? '二次通知'}</Tag>
          </Tooltip>
        ) : null
    }
  ]

  const discoveringSchool = busy.startsWith('discover:') ? busy.slice('discover:'.length) : ''

  /**
   * 第二步按钮旁边的一句话。
   *
   * 采集和抽取一次只跑 20 篇，走完一遍不等于全干完。不把队列余量写出来，
   * 用户看到「采集完成」就以为完事了，剩下的几十篇会一直躺在库里没人管。
   */
  const queueNote = ((): string => {
    if (!stats) return ''
    if (stats.pending > 0) return `队列里还有 ${stats.pending} 篇没采正文`
    if (stats.unparsed > 0) return `${stats.unparsed} 篇已采到正文，等抽字段`
    if (stats.unreachable > 0) return `${stats.unreachable} 篇打不开，半小时后再跑一次会重试`
    if (stats.articles > 0) {
      return stats.lastFetchAt ? `都处理完了，上次采集 ${shortDate(stats.lastFetchAt)}` : '都处理完了'
    }
    return ''
  })()

  /**
   * 进度条。找账号、采正文、抽字段三件事都慢，共用一条。
   *
   * account 在不同环节含义不同——找账号时是公众号名，采正文时是文章标题，
   * 所以统一用引号括起来，不写「正在找」这种只对某一步成立的动词。
   */
  const progressBar = progress ? (
    <div className="bench-progress">
      <Progress
        percent={progress.total ? Math.round((progress.current / progress.total) * 100) : 0}
        size="small"
        style={{ width: 180 }}
        status="active"
      />
      <span className="bench-muted">
        {batchInfo ? `批量补采 ${batchInfo.i}/${batchInfo.total} · ` : ''}
        {progress.school}
        {progress.account ? ` · 「${progress.account}」` : ''}
        {progress.total ? `（${progress.current}/${progress.total}）` : ''}
        {progress.note ? ` · ${progress.note}` : ''}
      </span>
    </div>
  ) : null

  return (
    <div className="bench">
      <div className="bench-head">
        <div className="bench-title">
          <BookOutlined /> 跨校活动对标
          <span className="bench-title-sub">
            本校：{homeSchool?.name ?? '未设置'}
            {homeSchool && homeSchool.articleCount === 0 ? '（还没采）' : ''}
          </span>
        </div>
        <div className="bench-stats">
          {stats ? (
            <>
              <span>
                学校 <b>{withData.length}</b>
              </span>
              <span>
                源 <b>{stats.sources}</b>
              </span>
              <span>
                文章 <b>{stats.articles}</b>
              </span>
              <span>
                活动 <b>{stats.activities}</b> 条
              </span>
              {/*
                全库 51 场、近一年只筛出 11 场时，如果只写「活动 51」，
                用户会奇怪下面怎么才几条；只写「11」又像是数据丢了。
                两个数并排，才说明白「库里有这么多，当前时间窗里是这么多」。
              */}
              {filteredActivities !== null && filteredActivities < stats.activities ? (
                <span className="bench-muted">
                  当前筛出 <b>{filteredActivities}</b>（
                  {range === 'year' ? '近一年' : range === 'half' ? '近半年' : '全部'}）
                </span>
              ) : null}
              {/*
                库里的活动数是「抽取成功」的数，不等于「真的是活动」的数。
                差的那部分必须当场说出来——不说，读者会拿 50 这个数字去推结论。
              */}
              {audit && audit.offTopic.length ? (
                <span className="bench-warn-link" onClick={() => setSourcesOpen(true)}>
                  其中 <b>{audit.offTopic.length}</b> 条像别的（点这里复查）
                </span>
              ) : null}
              <span className="bench-muted">原文已删 {stats.deleted}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------- 第一步：选学校 ---------- */}
      <section className="bench-step" id="bench-step-1">
        <div className="bench-step-head">
          <span className="bench-step-no">1</span>
          选学校，让软件自己去公众号里找文章
          <span className="bench-step-hint">
            点某个学校的「一键采集」，它按「校名 + 学生会 / 团委」这类常见命名去搜，
            搜到的链接顺手采正文、抽字段。只搜不采就把下面的开关关掉。
            搜的是搜索引擎收录过的公开推文，不是这个号的全部历史。
          </span>
        </div>

        {busy.startsWith('discover') ? progressBar : null}

        <div className="bench-schools">
          {visibleSchools.map((s) => (
            <div
              key={s.id}
              className={['bench-school', s.isHome ? 'bench-school-home' : '', s.articleCount ? '' : 'bench-school-idle']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="bench-school-top">
                <span className="bench-school-name" title={s.name}>
                  {s.name}
                </span>
                {s.isHome ? <Tag color="purple">本校</Tag> : null}
              </div>
              <div className="bench-school-count">
                {s.articleCount ? (
                  <>
                    <b>{s.articleCount}</b> 篇 · <b>{s.activityCount}</b> 场 · {s.sourceCount} 个号
                  </>
                ) : (
                  '还没采'
                )}
              </div>
              <div className="bench-school-actions">
                <Button
                  size="small"
                  icon={<SearchOutlined />}
                  loading={discoveringSchool === s.name}
                  disabled={!!busy && discoveringSchool !== s.name}
                  onClick={() => discover(s)}
                >
                  {autoChain ? '一键采集' : '找文章'}
                </Button>
                <Button size="small" type="text" onClick={() => openAccounts(s)}>
                  账号
                </Button>
                {!s.isHome ? (
                  <Tooltip title="把本校改成这一所：简报里会多出「本校基准」一节">
                    <Button
                      size="small"
                      type="text"
                      className="bench-school-homepick"
                      icon={<UserSwitchOutlined />}
                      onClick={() => setHome(s.name)}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="bench-step-body">
          <Button size="small" type="text" onClick={() => setShowAllSchools((v) => !v)}>
            {showAllSchools
              ? `只看已有数据的（${withData.length} 所）`
              : `显示全部 ${schoolList.length} 所`}
          </Button>
          <Tooltip title="挑出活动不足两场、连对比表都进不去的 5 所学校，依次搜一遍。每所之间会停顿，整轮约两三分钟；中途撞上验证码会自动收工">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={busy === 'batch'}
              disabled={!!busy && busy !== 'batch'}
              onClick={discoverBatch}
            >
              补齐最缺的 5 所
            </Button>
          </Tooltip>
          <Tooltip title="装好就有点东西可看。这批链接是随软件带的，不用联网去搜">
            <Button size="small" icon={<InboxOutlined />} loading={busy === 'seed'} onClick={importSeeds}>
              导入内置样本
            </Button>
          </Tooltip>
          <Tooltip title="打开：搜到链接后接着采正文、抽字段，一次点完走完三步。关掉：只把链接收进来，稍后自己决定采哪些">
            <Space size={4} className="bench-chain">
              <Switch
                size="small"
                checked={autoChain}
                onChange={(v) => {
                  setAutoChain(v)
                  window.localStorage.setItem('zhishu.bench.autoChain', v ? '1' : '0')
                }}
              />
              <span>搜完顺手采正文、抽字段</span>
            </Space>
          </Tooltip>
          <span className="bench-step-hint">
            不想按学校搜也行：下面「导入链接」可以直接粘公众号文章地址。
          </span>
        </div>
      </section>

      {/* ---------- 第二步：采内容 ---------- */}
      <section className="bench-step">
        <div className="bench-step-head">
          <span className="bench-step-no">2</span>
          把链接变成正文，再把正文抽成字段
          <span className="bench-step-hint">
            采集要真正打开文章，每篇间隔两三秒，20 篇大约一两分钟。
          </span>
        </div>
        <div className="bench-step-body">
          <Button icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            导入链接
          </Button>
          <Button
            icon={<CloudDownloadOutlined />}
            loading={busy === 'fetch'}
            disabled={!!busy && busy !== 'fetch'}
            onClick={doFetch}
          >
            采集正文{stats?.pending ? `（${stats.pending}）` : ''}
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={busy === 'extract'}
            disabled={!!busy && busy !== 'extract'}
            onClick={doExtract}
          >
            抽字段{stats?.unparsed ? `（${stats.unparsed}）` : ''}
          </Button>
          <Tooltip title="把待采集、待抽取的都推完，一次最多 200 篇；撞上验证会自动停">
            <Button
              icon={<PlayCircleOutlined />}
              loading={busy === 'drain'}
              disabled={!!busy && busy !== 'drain'}
              onClick={doDrain}
            >
              跑完队列
            </Button>
          </Tooltip>
          <Button onClick={() => void load()} icon={<ReloadOutlined />} disabled={!!busy}>
            刷新
          </Button>
          <span className="bench-queue">{queueNote}</span>
        </div>
        {busy === 'fetch' || busy === 'extract' || busy === 'drain' ? progressBar : null}
      </section>

      {/* ---------- 第三步：看结果 ---------- */}
      <section className="bench-step">
        <div className="bench-step-head">
          <span className="bench-step-no">3</span>
          按条件筛，出简报或并排看
          <span className="bench-step-hint">筛选条件同时决定简报的范围，看到什么就导出什么。</span>
        </div>

        <Space className="bench-tools" wrap>
          <Select
            style={{ width: 130 }}
            value={range}
            onChange={(v) => setRange(v)}
            options={[
              { value: 'year', label: '近一年' },
              { value: 'half', label: '近半年' },
              { value: 'all', label: '全部' }
            ]}
          />
          <Select
            style={{ width: 160 }}
            placeholder="全部学校"
            allowClear
            value={school || undefined}
            onChange={(v) => setSchool(v ?? '')}
            options={schoolOptions.map((s) => ({ value: s, label: s }))}
          />
          <Select
            style={{ width: 140 }}
            placeholder="全部类型"
            allowClear
            value={kind || undefined}
            onChange={(v) => setKind(v ?? '')}
            options={kinds.map((k) => ({ value: k, label: k }))}
          />
          <Input
            style={{ width: 160 }}
            placeholder="标题关键词"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Space size={4}>
            <Switch size="small" checked={secondOnly} onChange={setSecondOnly} />
            <span>只看二次通知</span>
          </Space>
          <Button type="primary" icon={<FileTextOutlined />} loading={busy === 'brief'} disabled={!!busy && busy !== 'brief'} onClick={() => doBrief()}>
            生成简报
          </Button>
          <Button
            icon={<SwapOutlined />}
            disabled={picked.length < 2 || (!!busy && busy !== 'compare')}
            loading={busy === 'compare'}
            onClick={doCompare}
          >
            并排对比{picked.length ? `（${picked.length}）` : ''}
          </Button>
          <Button
            danger={!!audit?.offTopic.length}
            onClick={() => setSourcesOpen(true)}
          >
            数据体检{audit?.offTopic.length ? `（${audit.offTopic.length} 条待复查）` : ''}
          </Button>
        </Space>

        {!stats?.articles ? (
          <Empty
            className="bench-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div className="bench-empty-text">
                <div className="bench-empty-title">库里还没有文章</div>
                <div className="bench-muted">
                  先导入随软件带的一批样本链接，立刻能看到长什么样；也可以回上面选一所学校，
                  去搜它最近在办什么。
                </div>
              </div>
            }
          >
            <Space>
              <Button
                type="primary"
                icon={<InboxOutlined />}
                loading={busy === 'seed'}
                onClick={importSeeds}
              >
                导入内置样本
              </Button>
              <Button
                onClick={() =>
                  document.getElementById('bench-step-1')?.scrollIntoView({ behavior: 'smooth' })
                }
              >
                去选学校
              </Button>
            </Space>
          </Empty>
        ) : (
          <Table
            className="bench-table"
            size="small"
            rowKey="id"
            // 默认的 auto 布局按内容分配宽度：公众号名长就把「标题」挤成一列竖排字，
            // width 写了也不管用。锁成 fixed，宽度才按这里写的算。
            tableLayout="fixed"
            pagination={{ pageSize: 50, showSizeChanger: false }}
            columns={columns}
            dataSource={rows}
            rowSelection={{
              selectedRowKeys: picked,
              onChange: (keys) => setPicked(keys as number[]),
              // 最多四篇：再多并排就挤成一团，读不出差异
              getCheckboxProps: (row) => ({
                disabled: picked.length >= 4 && !picked.includes(row.id)
              })
            }}
          />
        )}
      </section>

      {/* ---------- 详情 ---------- */}
      <Drawer
        open={!!detail}
        width={600}
        onClose={() => setDetail(null)}
        title={detail?.title || '文章详情'}
        extra={
          detail ? (
            <Space>
              {detail.activity ? (
                <Button size="small" danger onClick={() => markNotActivity(detail)}>
                  不是活动
                </Button>
              ) : null}
              <Button size="small" onClick={() => void window.api.appOpenExternal(detail.url)}>
                打开原文
              </Button>
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div className="bench-detail">
            <div className="bench-detail-meta">
              <span>{detail.school || '未识别学校'}</span>
              <span>{detail.sourceName || '未识别公众号'}</span>
              <span>{shortDate(detail.publishedAt)}</span>
              {detail.isHome ? <Tag color="purple">本校</Tag> : null}
              <Tag color={STATUS_TEXT[detail.status].color}>{STATUS_TEXT[detail.status].text}</Tag>
            </div>
            {detail.error ? <Alert type="warning" showIcon message={detail.error} /> : null}
            {detail.activity ? (
              <div className="bench-fields">
                <Field label="类型" value={detail.activity.kind} />
                <Field label="主办" value={detail.activity.organizer} />
                <Field label="协办" value={detail.activity.coOrganizer} />
                <Field label="时间" value={detail.activity.startAt} />
                <Field
                  label="周次"
                  value={detail.activity.weekNo ? `约第${detail.activity.weekNo}周（按日期推算）` : ''}
                />
                <Field label="时长" value={detail.activity.duration} />
                <Field label="地点" value={detail.activity.location} />
                <Field label="规模" value={detail.activity.scale} />
                <Field label="对象" value={detail.activity.audience} />
                <Field label="组织方式" value={detail.activity.orgForm} />
                <Field label="参与方式" value={detail.activity.joinMethod} />
                <Field label="宣传" value={detail.activity.promoChannels.join('、')} />
                <Field label="可迁移" value={MIGRATION_TEXT[detail.activity.migrationFit]} />
                <Field
                  label="把握"
                  value={
                    detail.activity.confidence
                      ? `${Math.round(detail.activity.confidence * 100)}%`
                      : ''
                  }
                />
                <Wide label="依据" value={detail.activity.migrationNote} />
                {detail.activity.agenda.length ? (
                  <div className="bench-wide">
                    <span className="bench-field-label">议程</span>
                    <ol>
                      {detail.activity.agenda.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {detail.activity.highlights.length ? (
                  <div className="bench-wide">
                    <span className="bench-field-label">特色</span>
                    <ul>
                      {detail.activity.highlights.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {peers.length ? (
              <div className="bench-peer">
                <div className="bench-peer-head">
                  <span>本校同类活动（{detail.activity?.kind || '同类型'}）</span>
                  <Tag>基准</Tag>
                </div>
                {peers.map((p) => (
                  <div key={p.id} className="bench-peer-item">
                    <Typography.Link onClick={() => openDetail(p.id)}>
                      {p.title || '(无标题)'}
                    </Typography.Link>
                    <span className="bench-muted">
                      {p.activity?.startAt?.slice(0, 16) || p.publishedAt?.slice(0, 10) || '时间未写'}
                      {p.activity?.location ? ` · ${p.activity.location}` : ''}
                      {p.activity?.orgForm ? ` · ${p.activity.orgForm}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : detail.isHome ? null : (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                本校还没有同类型的活动可对照。把本校加上采一次，这里就会并列出「我们是怎么做的」。
              </Typography.Paragraph>
            )}

            <Typography.Paragraph className="bench-body">
              {detail.body ? detail.body.slice(0, 3000) : '（没有正文）'}
            </Typography.Paragraph>
          </div>
        ) : null}
      </Drawer>

      {/* ---------- 清理归属不明的号 ---------- */}
      <Modal
        open={purgeOpen}
        title="清理归属不明的号"
        width={720}
        onCancel={() => setPurgeOpen(false)}
        onOk={doPurge}
        okText={`删掉选中的 ${purgePicked.length} 个`}
        okButtonProps={{ danger: true, disabled: !purgePicked.length }}
        cancelText="先留着"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          下面默认全选。看着是正经号的（附属中学、英文简称、你认识的号）取消勾选再删。
          删掉的是这些号名下的文章和已经抽好的字段，不能恢复。
        </Typography.Paragraph>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ y: 320 }}
          dataSource={audit?.suspicious ?? []}
          rowSelection={{
            selectedRowKeys: purgePicked,
            onChange: (keys) => setPurgePicked(keys as number[])
          }}
          columns={[
            { title: '公众号', dataIndex: 'name' },
            { title: '归属', dataIndex: 'school', width: 150, render: (v: string) => v || '未分学校' },
            { title: '文章', dataIndex: 'articleCount', width: 70 }
          ]}
        />
      </Modal>

      {/* ---------- 简报 ---------- */}
      <Drawer
        open={!!brief}
        width={900}
        onClose={() => setBrief(null)}
        title={brief?.title ?? '简报'}
        extra={
          brief ? (
            <Space>
              <Button size="small" onClick={saveBrief}>
                存成 Markdown
              </Button>
              <Button size="small" icon={<FileTextOutlined />} onClick={saveReport}>
                导出报告
              </Button>
              <Button type="primary" size="small" onClick={copyBrief}>
                复制全文
              </Button>
            </Space>
          ) : null
        }
      >
        {brief ? (
          <div className="bench-brief-wrap">
            {/*
              近一年只有 11 场、库里其实有 51 场时，必须说出来。
              不说的话，读者会以为采集只有这么点成果，而问题出在时间窗上。
            */}
            {stats && range !== 'all' && brief.activityCount < stats.activities ? (
              <div className="bench-brief-tip">
                当前只统计了{range === 'year' ? '近一年' : '近半年'}的活动（{brief.activityCount} 场）。
                库里共 {stats.activities} 场，
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => doBrief('all')}>
                  切到「全部」重新生成
                </Button>
                ，能多出 {stats.activities - brief.activityCount} 场。
              </div>
            ) : null}
            <div className="bench-brief-meta">
              <span>
                覆盖 <b>{brief.schoolCount}</b> 所学校
              </span>
              <span>
                共 <b>{brief.activityCount}</b> 条记录
                {brief.sessionCount < brief.activityCount ? <span className="bench-muted">（合并成 {brief.sessionCount} 场）</span> : null}
              </span>
              <span className="bench-muted">生成于 {brief.generatedAt}</span>
            </div>
            <Tabs
              size="small"
              items={[
                {
                  key: 'compare',
                  label: '横向对比',
                  children: <ComparePanel brief={brief} />
                },
                {
                  key: 'md',
                  label: '简报原文',
                  children: (
                    <>
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                        纯文本，可直接复制进 Word 或群聊。每条都带原文链接，别人追问时能当场打开。
                      </Typography.Paragraph>
                      <pre className="bench-brief">{brief.markdown}</pre>
                    </>
                  )
                }
              ]}
            />
          </div>
        ) : null}
      </Drawer>

      {/* ---------- 并排对比 ---------- */}
      <Drawer
        open={!!compare}
        width={Math.min(1180, 340 * (compare?.length ?? 2) + 160)}
        onClose={() => setCompare(null)}
        title="并排对比"
      >
        {compare && compare.length >= 2 ? <CompareTable items={compare} /> : null}
      </Drawer>

      {/* ---------- 账号清单 ---------- */}
      <Drawer
        open={!!accountsSchool}
        width={620}
        onClose={() => setAccountsSchool(null)}
        title={accountsSchool ? `${accountsSchool.name} · 要找的公众号` : '账号清单'}
      >
        {accountsSchool ? (
          <div className="bench-detail">
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              下面这些名字是按「校名/简称 + 学生会、团委、研究生会…」推出来的，不是既成事实：
              很多学校的号用的是花名（团聚上大、社彩同济），推出来的名字搜不到很正常。
              搜不到的，把你知道的真名填在下面加进去。
            </Typography.Paragraph>

            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="比如：团聚上大 / 社彩同济"
                value={extraAccount}
                onChange={(e) => setExtraAccount(e.target.value)}
                onPressEnter={addAccountAndDiscover}
              />
              <Button
                type="primary"
                icon={<SearchOutlined />}
                loading={busy === 'discover'}
                onClick={addAccountAndDiscover}
              >
                找这个号
              </Button>
            </Space.Compact>

            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={prospects}
              locale={{ emptyText: '还没找过。点学校卡片上的「找文章」就会生成一批候选。' }}
              columns={[
                { title: '账号名', dataIndex: 'accountName' },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 96,
                  render: (v: string) => (
                    <span className={PROSPECT_TEXT[v]?.cls ?? ''}>
                      {PROSPECT_TEXT[v]?.text ?? v}
                    </span>
                  )
                },
                { title: '命中', dataIndex: 'hitCount', width: 64 },
                {
                  title: '说明',
                  dataIndex: 'note',
                  render: (v: string) => <span className="bench-muted">{v || '—'}</span>
                }
              ]}
            />

            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              找到的号会在采集时按文章里的真实公众号名自动建成「源」，并归到这所学校名下。
            </Typography.Paragraph>
          </div>
        ) : null}
      </Drawer>

      {/* ---------- 数据体检 ---------- */}
      <Drawer open={sourcesOpen} width={780} onClose={() => setSourcesOpen(false)} title="数据体检">
        {audit && audit.offTopic.length ? (
          <div className="bench-off">
            <div className="bench-off-head">
              <span>
                按现在的规则复查，有 <b>{audit.offTopic.length}</b> 条已入库的条目不像一场活动
              </span>
              <Space size={6}>
                <Button
                  size="small"
                  onClick={() =>
                    setOffPicked(
                      offPicked.length === audit.offTopic.length
                        ? []
                        : audit.offTopic.map((x) => x.articleId)
                    )
                  }
                >
                  {offPicked.length === audit.offTopic.length ? '全不选' : '全选'}
                </Button>
                <Button
                  size="small"
                  danger
                  loading={busy === 'offtopic'}
                  disabled={!offPicked.length}
                  onClick={doDropOffTopic}
                >
                  剔除选中的 {offPicked.length} 条
                </Button>
              </Space>
            </div>
            <div className="bench-muted bench-off-note">
              「毕业生故事」「候选人风采展示」「一周活动预告」这类稿子标题里也有人和
              时间，抽取时被当成活动算进了库——它们一进对比表，「最常办的类型」
              和「有协办的比例」就跟着歪。剔除只删抽取结果，原文和链接都留着，
              随时能点回原文核对；拿不准的就别勾。
            </div>
            <div className="bench-audit-list">
              {audit.offTopic.map((x) => (
                <label key={x.articleId} className="bench-audit-row bench-off-row">
                  <Checkbox
                    checked={offPicked.includes(x.articleId)}
                    onChange={(e) =>
                      setOffPicked((prev) =>
                        e.target.checked
                          ? [...prev, x.articleId]
                          : prev.filter((id) => id !== x.articleId)
                      )
                    }
                  />
                  <div className="bench-audit-main">
                    <span className="bench-audit-name">{x.title}</span>
                    <span className="bench-audit-sample">
                      {x.school || '未分学校'} · 现被判为 {x.kind || '—'}
                    </span>
                  </div>
                  <Tag>{x.reason}</Tag>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="bench-off-sub">公众号源</div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这里列的是已经确认存在的公众号。名单本身不影响采集——采集的起点是链接——
          但它决定「这一篇算哪个学校的」，简报和对比都按这个分组。
        </Typography.Paragraph>

        {audit && audit.suspicious.length ? (
          <Alert
            type="warning"
            showIcon
            className="bench-audit"
            message={
              <span>
                {audit.suspicious.length} 个号不属于上海任何一所高校，名下 {audit.articleCount} 篇文章
              </span>
            }
            action={
              <Button size="small" danger onClick={openPurge}>
                挑着清理
              </Button>
            }
            description={
              <div>
                <div className="bench-muted">
                  多半是早期搜索没给账号名加引号、被拆词匹配带进来的别校稿子和营销号，
                  会让简报里的「覆盖几所学校」虚高。看着是正经号的（附属中学、英文简称）就留着。
                </div>
                <div className="bench-audit-list">
                  {audit.suspicious.map((x) => (
                    <div key={x.id} className="bench-audit-row">
                      <div className="bench-audit-main">
                        <span className="bench-audit-name">{x.name}</span>
                        {x.sample ? <span className="bench-audit-sample">{x.sample}</span> : null}
                      </div>
                      <span className="bench-muted">
                        {x.school || '未分学校'} · {x.articleCount} 篇
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            }
          />
        ) : null}
        <Space wrap style={{ marginBottom: 12 }}>
          <Input
            style={{ width: 200 }}
            placeholder="公众号名称，如 复旦大学学生会"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Input
            style={{ width: 150 }}
            placeholder="学校，如 复旦大学"
            value={newSchool}
            onChange={(e) => setNewSchool(e.target.value)}
          />
          <Select
            style={{ width: 110 }}
            value={newCategory}
            onChange={setNewCategory}
            options={[
              { value: 'student_union', label: '学生会' },
              { value: 'youth_league', label: '团委' },
              { value: 'college', label: '学院' },
              { value: 'other', label: '其他' }
            ]}
          />
          <Button type="primary" loading={busy === 'source'} onClick={addSource}>
            添加
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={sources}
          locale={{ emptyText: '还没有源。采集完成后会自动按公众号名建源，也可以在上面手动加。' }}
          columns={[
            {
              title: '学校',
              dataIndex: 'school',
              width: 168,
              // 这一列可改：号名里没有校名的（青春SUES、SIT星光化工）只能人工认，
              // 认出来就该归位，而不是被当成垃圾删掉
              render: (v: string, row) => (
                <Select
                  size="small"
                  bordered={false}
                  style={{ width: 156 }}
                  placeholder="未分学校"
                  allowClear
                  showSearch
                  value={v || undefined}
                  onChange={(next) => setSourceSchool(row.id, next ?? '')}
                  options={schoolNames.map((n) => ({ value: n, label: n }))}
                />
              )
            },
            { title: '公众号', dataIndex: 'name' },
            {
              title: '类型',
              dataIndex: 'category',
              width: 80,
              render: (v: BenchSourceCategory) =>
                ({ student_union: '学生会', youth_league: '团委', college: '学院', other: '其他' })[v]
            },
            { title: '文章', dataIndex: 'articleCount', width: 64 },
            {
              title: '最近',
              dataIndex: 'lastArticleAt',
              width: 100,
              render: (v: string | null) => (v ? v.slice(0, 10) : '—')
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 64,
              render: (v: boolean, row) => (
                <Switch size="small" checked={v} onChange={(next) => toggleSource(row.id, next)} />
              )
            },
            {
              title: '',
              width: 60,
              render: (_v, row) => (
                <Typography.Link type="danger" onClick={() => removeSource(row.id, row.name)}>
                  移除
                </Typography.Link>
              )
            }
          ]}
        />
      </Drawer>

      {/* ---------- 导入链接 ---------- */}
      <Drawer
        open={importOpen}
        width={520}
        title="导入公众号链接"
        onClose={() => setImportOpen(false)}
        extra={
          <Button type="primary" loading={busy === 'import'} onClick={doImport}>
            入队
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          一行一个链接，也可以直接粘一段带链接的文字。只会认 mp.weixin.qq.com 的文章链接，其余内容忽略。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          有工具导出的完整文章列表（CSV，一般带 title、url、time 三列）？直接选文件，标题和时间会一起进来。
          工具负责把公众号历史翻全，这里负责抓正文、抽字段。
        </Typography.Paragraph>
        <div style={{ marginBottom: 12 }}>
          <Button
            icon={<FolderOpenOutlined />}
            loading={busy === 'import'}
            disabled={!!busy && busy !== 'import'}
            onClick={doImportFile}
          >
            选 CSV / TXT 文件
          </Button>
        </div>
        <Input.TextArea
          rows={14}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=1&sn=..."
        />
      </Drawer>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div className="bench-field">
      <span className="bench-field-label">{label}</span>
      <span>{value || '—'}</span>
    </div>
  )
}

function Wide({ label, value }: { label: string; value: string | null }): JSX.Element | null {
  if (!value) return null
  return (
    <div className="bench-wide">
      <span className="bench-field-label">{label}</span>
      <span>{value}</span>
    </div>
  )
}

/**
 * 并排对比要看的字段。
 *
 * 顺序有讲究：先「是什么、什么时候、在哪」，再「花了多少本钱怎么办的」，
 * 最后才是「我们能不能照做」。这个顺序就是跟人讲这件事的顺序。
 */
const COMPARE_FIELDS: { label: string; get: (d: BenchArticleDetail) => string }[] = [
  { label: '学校', get: (d) => d.school },
  { label: '公众号', get: (d) => d.sourceName },
  { label: '活动类型', get: (d) => d.activity?.kind ?? '' },
  { label: '时间', get: (d) => (d.activity?.startAt ? d.activity.startAt.slice(0, 16) : '') },
  { label: '周次（约）', get: (d) => (d.activity?.weekNo ? `约 ${d.activity.weekNo} 周` : '') },
  { label: '时长', get: (d) => d.activity?.duration ?? '' },
  { label: '地点', get: (d) => d.activity?.location ?? '' },
  { label: '规模', get: (d) => d.activity?.scale ?? '' },
  { label: '组织方式', get: (d) => d.activity?.orgForm ?? '' },
  { label: '协办', get: (d) => d.activity?.coOrganizer ?? '' },
  { label: '面向', get: (d) => d.activity?.audience ?? '' },
  { label: '参与方式', get: (d) => d.activity?.joinMethod ?? '' },
  { label: '议程', get: (d) => (d.activity?.agenda ?? []).join(' → ') },
  { label: '特色环节', get: (d) => (d.activity?.highlights ?? []).join('；') },
  { label: '宣传', get: (d) => (d.activity?.promoChannels ?? []).join('、') },
  { label: '可迁移', get: (d) => MIGRATION_TEXT[d.activity?.migrationFit ?? ''] ?? '' },
  { label: '依据', get: (d) => d.activity?.migrationNote ?? '' },
  { label: '推文发布', get: (d) => shortDate(d.publishedAt) }
]

/**
 * 并排对比表。
 *
 * 差异行会给底色：四列摆在一起时，人眼最先要找的就是「谁和谁不一样」，
 * 不标出来得逐格读。全列相同的行不加底色，免得满屏都是强调色。
 */
function CompareTable({ items }: { items: BenchArticleDetail[] }): JSX.Element {
  return (
    <div className="bench-compare-wrap">
      <table className="bench-compare">
        <thead>
          <tr>
            <th className="bench-compare-key" />
            {items.map((d) => (
              <th key={d.id}>
                <div className="bench-compare-head">
                  <span className={d.isHome ? 'bench-compare-school bench-compare-home' : 'bench-compare-school'}>
                    {d.school || '未填学校'}
                    {d.isHome ? '（本校）' : ''}
                  </span>
                  <span className="bench-compare-title">{d.title || d.url}</span>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => void window.api.appOpenExternal(d.url)}
                  >
                    原文
                  </Button>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_FIELDS.map((field) => {
            const values = items.map((d) => field.get(d) || '—')
            const differs = new Set(values).size > 1
            return (
              <tr key={field.label} className={differs ? 'bench-compare-diff' : ''}>
                <th className="bench-compare-key">{field.label}</th>
                {values.map((v, i) => (
                  <td key={items[i].id}>{v}</td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        带底色的行表示各篇不一样。空白是原文没写或没抽到，不是「无此环节」。
      </Typography.Paragraph>
    </div>
  )
}

/**
 * 一条横向条形。
 *
 * 条长按本组最大值归一，不按百分占比：占比柱在一行里全都短，看不出谁多谁少。
 * 数字仍然写在右边，条只是帮眼睛排序用的。
 */
function BarList({
  title,
  unit,
  data
}: {
  title: string
  unit: string
  data: { label: string; count: number }[]
}): JSX.Element | null {
  const rows = data.filter((d) => d.count > 0).slice(0, 8)
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.count), 1)
  return (
    <section className="bench-cmp-bars">
      <div className="bench-cmp-h">{title}</div>
      {rows.map((r) => (
        <div className="bench-bar-row" key={r.label}>
          <span className="bench-bar-label" title={r.label}>
            {r.label}
          </span>
          <span className="bench-bar-track">
            <span
              className="bench-bar-fill"
              style={{ width: `${Math.max((r.count / max) * 100, 3)}%` }}
            />
          </span>
          <span className="bench-bar-val">
            {r.count}
            <i>{unit}</i>
          </span>
        </div>
      ))}
    </section>
  )
}

/**
 * 「同一件事，各校怎么办」。
 *
 * 各校一览按学校切，这里按活动类型切：选一个类型，把各校办的同类活动一场一行摆开。
 * 之所以用卡片不用表格：一场活动的差别分散在场地、面向、参与方式、规模、特色这几处，
 * 表格里挤成几格全是省略号，等于没给看。
 */
function TopicPanel({ topics }: { topics: BenchCompareTopic[] }): JSX.Element | null {
  const [idx, setIdx] = useState(0)
  const [showAll, setShowAll] = useState(false)
  if (!topics.length) return null
  const cur = topics[Math.min(idx, topics.length - 1)]

  // 二十场同类活动全铺开会把这个抽屉撑成一本名录；先给八场，剩下的点开看
  const LIMIT = 8
  const shown = showAll ? cur.rows : cur.rows.slice(0, LIMIT)
  const rest = cur.rows.length - shown.length

  return (
    <section className="bench-cmp-topics">
      <div className="bench-cmp-h">同类活动</div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -4 }}>
        同一类活动横着看：别人在哪办、要不要抢票、请谁一起办。少于两所学校的类型不列——一所学校的两场是它自己的重复，不是对照。
      </Typography.Paragraph>

      <div className="bench-topic-tabs">
        {topics.map((t, i) => (
          <button
            key={t.kind}
            type="button"
            className={`bench-topic-tab${i === idx ? ' is-on' : ''}`}
            onClick={() => {
              setIdx(i)
              setShowAll(false)
            }}
          >
            {t.kind}
            <i>
              {t.schools} 校 · {t.rows.length} 场
            </i>
          </button>
        ))}
      </div>

      <div className="bench-topic-sum">
        <p className="bench-topic-note">{cur.note}</p>
        <div className="bench-topic-dist">
          {cur.venues.length ? (
            <span>
              场地：{cur.venues.map((v) => `${v.label} ${v.count}`).join('、')}
            </span>
          ) : null}
          {cur.joins.length ? (
            <span>参与方式：{cur.joins.map((v) => `${v.label} ${v.count}`).join('、')}</span>
          ) : null}
        </div>
      </div>

      <div className="bench-topic-cards">
        {shown.map((r, i) => (
          <article
            key={`${r.school}-${i}`}
            className={`bench-topic-card${r.isHome ? ' is-home' : ''}`}
          >
            <div className="bench-topic-top">
              <span className="bench-topic-school">
                {r.school}
                {r.isHome ? (
                  <Tag color="red" style={{ marginLeft: 6 }}>
                    本校
                  </Tag>
                ) : null}
              </span>
              <span className="bench-topic-when">
                {r.startAt ? shortDate(r.startAt) : '日期未写'}
                {r.weekNo ? ` · 第 ${r.weekNo} 周` : ''}
                {r.leadDays !== null ? ` · 提前 ${r.leadDays} 天预告` : ''}
              </span>
            </div>
            <div className="bench-topic-title" title={r.title}>
              {r.title}
            </div>
            <div className="bench-topic-facts">
              {r.location ? (
                <span>
                  <EnvironmentOutlined /> {r.location}
                </span>
              ) : null}
              {r.audience ? <span>面向 {r.audience}</span> : null}
              {r.joinMethod ? <span>{r.joinMethod}</span> : null}
              {r.scale ? <span>{r.scale}</span> : null}
              {r.coOrganizer ? <span>协办 {r.coOrganizer}</span> : null}
            </div>
            {r.highlights.length ? (
              <div className="bench-topic-hl">
                {r.highlights.slice(0, 3).map((h) => (
                  <span key={h}>{h}</span>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>

      {rest > 0 ? (
        <Button type="link" size="small" className="bench-topic-more" onClick={() => setShowAll(true)}>
          还有 {rest} 场，展开
        </Button>
      ) : null}
      {showAll && cur.rows.length > LIMIT ? (
        <Button type="link" size="small" className="bench-topic-more" onClick={() => setShowAll(false)}>
          收起
        </Button>
      ) : null}
    </section>
  )
}

/**
 * 简报里的「横向对比」页签。
 *
 * 与「简报原文」放同一个抽屉里，因为它们用的是同一次计算的结果——
 * 分成两个入口，迟早会出现一边九个学校、一边六个学校的情况，而用户没法判断该信哪个。
 */
function ComparePanel({ brief }: { brief: BenchBrief }): JSX.Element {
  const { compare } = brief
  const solid = compare.schools.filter((s) => !s.thin)
  const cov = compare.coverage

  if (!brief.activityCount) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的活动" />
  }

  /**
   * 列是按「有几所学校真的有这项数据」动态加的。
   *
   * 固定摆八列的话，规模一列会全是「—」（实测 51 场里只有 5 场写了人数），
   * 看的人会以为抽取漏了；藏着不说又像在回避。所以只在至少两所学校有数据时才比，
   * 没有的那项交给上面的结论句去说明。
   */
  const columns: ColumnsType<(typeof solid)[number]> = [
    {
      title: '学校',
      dataIndex: 'school',
      width: 180,
      render: (v: string, r) => (
        <>
          {v}
          {r.isHome ? <Tag color="red" style={{ marginLeft: 6 }}>本校</Tag> : null}
        </>
      )
    },
    {
      title: '活动',
      dataIndex: 'activities',
      width: 78,
      align: 'right',
      // 同一场活动发预告、招募、回顾三篇时会算成三条，按篇数看就虚高。
      // 斜杠后面是合并后的场次；两者相同的就不显示，省得每格都挂个 /6
      render: (v: number, r) =>
        r.sessions < v ? (
          <Tooltip title={`${v} 篇推文，合并同一场的预告 / 招募 / 回顾后是 ${r.sessions} 场`}>
            <span>
              {v}
              <span className="bench-slash">/{r.sessions}</span>
            </span>
          </Tooltip>
        ) : (
          v
        )
    }
  ]

  if (cov.scale >= 2) {
    columns.push(
      {
        title: '中位规模',
        dataIndex: 'medianScale',
        width: 92,
        align: 'right',
        render: (v: number | null) =>
          v === null ? <span className="bench-muted">—</span> : `${v} 人`
      },
      {
        title: '人数覆盖',
        dataIndex: 'scaleCoverage',
        width: 88,
        align: 'right',
        render: (v: number) => <span className="bench-muted">{Math.round(v * 100)}%</span>
      }
    )
  }

  if (cov.week >= 2) {
    columns.push({
      title: '中位周次',
      dataIndex: 'medianWeek',
      width: 90,
      align: 'right',
      render: (v: number | null) =>
        v === null ? <span className="bench-muted">—</span> : `第 ${v} 周`
    })
  }

  if (cov.lead >= 2) {
    columns.push({
      title: '提前预告',
      dataIndex: 'medianLeadDays',
      width: 92,
      align: 'right',
      render: (v: number | null) =>
        v === null ? <span className="bench-muted">—</span> : `${v} 天`
    })
  }

  if (cov.promo >= 2) {
    columns.push({
      title: '宣传手段',
      dataIndex: 'promoPerItem',
      width: 88,
      align: 'right',
      render: (v: number) => `${v} 种`
    })
  }

  if (cov.coHost >= 2) {
    columns.push({
      title: '有协办',
      dataIndex: 'coHostRate',
      width: 82,
      align: 'right',
      render: (v: number) => `${Math.round(v * 100)}%`
    })
  }

  columns.push({ title: '最常办', dataIndex: 'topKind', ellipsis: true })

  return (
    <div className="bench-cmp">
      <section className="bench-cmp-findings">
        <div className="bench-cmp-h">先说结论</div>
        {compare.insights.map((text, i) => (
          <div className="bench-cmp-finding" key={i}>
            <span className="bench-cmp-n">{i + 1}</span>
            <span>{text}</span>
          </div>
        ))}
      </section>

      {solid.length ? (
        <section>
          <div className="bench-cmp-h">各校一览</div>
          <Table
            size="small"
            rowKey="school"
            tableLayout="fixed"
            pagination={false}
            dataSource={solid}
            rowClassName={(r) => (r.isHome ? 'bench-cmp-home' : '')}
            columns={columns}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            中位数只按「原文写明」的条目算，旁边一列是覆盖率。18 场里只有 2 场写了人数时，
            这个中位数不该和写满的学校并排看待。
          </Typography.Paragraph>
        </section>
      ) : null}

      <div className="bench-cmp-cols">
        <BarList title="办的是些什么活动" unit="场" data={compare.kinds} />
        <BarList title="宣传都用哪些手段" unit="次" data={compare.promos} />
      </div>

      <TopicPanel topics={compare.topics} />
    </div>
  )
}

export const benchmarkModule: ModuleManifest = {
  id: 'benchmark',
  // 导航上一个词就够：「公众号」只说了信息来源，说的是这件软件干什么
  title: '对标',
  icon: <BookOutlined />,
  route: '/benchmark',
  enabled: true,
  page: () => <BenchmarkPage />
}
