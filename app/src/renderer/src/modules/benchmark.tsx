import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Drawer,
  Empty,
  Input,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  BookOutlined,
  CloudDownloadOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UserSwitchOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ModuleManifest } from './types'
import type {
  BenchArticleDetail,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchArticleStatus,
  BenchBrief,
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
  const { message } = AntApp.useApp()

  const [stats, setStats] = useState<BenchStats | null>(null)
  const [rows, setRows] = useState<BenchArticleInfo[]>([])
  const [schoolOptions, setSchoolOptions] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [schoolList, setSchoolList] = useState<BenchSchoolInfo[]>([])
  const [sources, setSources] = useState<BenchSourceInfo[]>([])

  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<BenchProgressEvent | null>(null)

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

  /** 账号清单抽屉：看某所学校打算找哪些号、哪些找着了 */
  const [accountsSchool, setAccountsSchool] = useState<BenchSchoolInfo | null>(null)
  const [prospects, setProspects] = useState<BenchProspectInfo[]>([])
  const [extraAccount, setExtraAccount] = useState('')

  const [school, setSchool] = useState('')
  const [kind, setKind] = useState('')
  const [keyword, setKeyword] = useState('')
  const [secondOnly, setSecondOnly] = useState(false)
  /** 时间窗口：报名表写的是「上海各高校一年内的所有活动」，所以默认给一年 */
  const [range, setRange] = useState<'all' | 'half' | 'year'>('year')

  const homeSchool = useMemo(() => schoolList.find((s) => s.isHome) ?? null, [schoolList])
  const withData = useMemo(() => schoolList.filter((s) => s.articleCount > 0), [schoolList])
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
      return `${target.name}：${r.message}`
    })
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

  const doFetch = (): void => {
    void run('fetch', async () => {
      const r = await window.api.benchFetch(20)
      const parts = [`正文可抽 ${r.fetched}`]
      if (r.imageOnly) parts.push(`纯图 ${r.imageOnly}`)
      if (r.deleted) parts.push(`原文已删 ${r.deleted}`)
      if (r.unreachable) parts.push(`暂不可见 ${r.unreachable}`)
      // 撞验证时要说清楚是怎么回事，否则用户只会看到一串失败反复重试
      if (r.blocked) parts.push('连续撞上微信验证，已提前停止，过 20–30 分钟再试')
      return `采集完成：${parts.join('，')}`
    })
  }

  const doExtract = (): void => {
    void run('extract', async () => {
      const r = await window.api.benchExtract(20)
      const byRule = r.mode === 'rule' ? '（未配模型，按规则抽取，细节字段会少一些）' : ''
      return `抽取完成${byRule}：活动 ${r.activities}，非活动 ${r.skipped}，失败 ${r.failed}`
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

  const doBrief = (): void => {
    void run('brief', async () => {
      const next = await window.api.benchBrief(currentFilter())
      setBrief(next)
      return next.activityCount
        ? `简报已生成：${next.schoolCount} 所学校、${next.activityCount} 场活动`
        : '没有符合条件的活动，可以先放宽时间范围或补采几个公众号'
    })
  }

  const copyBrief = (): void => {
    if (!brief) return
    void navigator.clipboard
      .writeText(brief.markdown)
      .then(() => message.success('已复制，可直接粘进文档或群聊'))
      .catch(() => message.error('复制失败，可以全选下面的文字手动复制'))
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

  return (
    <div className="bench">
      <div className="bench-head">
        <div className="bench-title">
          <BookOutlined /> 兄弟高校公众号
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
                活动 <b>{stats.activities}</b>
              </span>
              <span className="bench-muted">原文已删 {stats.deleted}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------- 第一步：选学校 ---------- */}
      <section className="bench-step">
        <div className="bench-step-head">
          <span className="bench-step-no">1</span>
          选学校，让软件自己去公众号里找文章
          <span className="bench-step-hint">
            点某个学校的「找文章」，它就会按「校名+学生会 / 团委」这类常见命名去搜，
            每个学校几十秒。搜的是搜索引擎收录过的公开推文，不是这个号的全部历史。
          </span>
        </div>

        {progress ? (
          <div className="bench-step-body">
            <Progress
              percent={
                progress.total ? Math.round((progress.current / progress.total) * 100) : 0
              }
              size="small"
              style={{ width: 220 }}
              status="active"
            />
            <span className="bench-muted">
              {progress.school}
              {progress.account ? ` · 正在找「${progress.account}」` : ''}
              {progress.total ? `（${progress.current}/${progress.total}）` : ''}
              {progress.note && !progress.account ? ` · ${progress.note}` : ''}
            </span>
          </div>
        ) : null}

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
                  找文章
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
          <Tooltip title="装好就有点东西可看。这批链接是随软件带的，不用联网去搜">
            <Button size="small" icon={<InboxOutlined />} loading={busy === 'seed'} onClick={importSeeds}>
              导入内置样本
            </Button>
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
            采集正文
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={busy === 'extract'}
            disabled={!!busy && busy !== 'extract'}
            onClick={doExtract}
          >
            抽字段
          </Button>
          <Button onClick={() => void load()} icon={<ReloadOutlined />} disabled={!!busy}>
            刷新
          </Button>
        </div>
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
          <Button type="primary" icon={<FileTextOutlined />} loading={busy === 'brief'} disabled={!!busy && busy !== 'brief'} onClick={doBrief}>
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
          <Button onClick={() => setSourcesOpen(true)}>
            公众号源（{stats?.sources ?? 0}）
          </Button>
        </Space>

        {!stats?.articles ? (
          <Empty
            className="bench-empty"
            description="库里还没有文章。上面点「导入内置样本」立刻有东西可看，或者按学校去搜。"
          />
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
            <Button size="small" onClick={() => void window.api.appOpenExternal(detail.url)}>
              打开原文
            </Button>
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

      {/* ---------- 简报 ---------- */}
      <Drawer
        open={!!brief}
        width={760}
        onClose={() => setBrief(null)}
        title={brief?.title ?? '简报'}
        extra={
          brief ? (
            <Button type="primary" size="small" onClick={copyBrief}>
              复制全文
            </Button>
          ) : null
        }
      >
        {brief ? (
          <div className="bench-brief-wrap">
            <div className="bench-brief-meta">
              <span>
                覆盖 <b>{brief.schoolCount}</b> 所学校
              </span>
              <span>
                共 <b>{brief.activityCount}</b> 场活动
              </span>
              <span className="bench-muted">生成于 {brief.generatedAt}</span>
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              下面是纯文本简报，可以直接复制进 Word 或群聊。每条都带原文链接，
              别人追问时能当场打开。
            </Typography.Paragraph>
            <pre className="bench-brief">{brief.markdown}</pre>
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

      {/* ---------- 公众号源 ---------- */}
      <Drawer open={sourcesOpen} width={760} onClose={() => setSourcesOpen(false)} title="公众号源">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这里列的是已经确认存在的公众号。名单本身不影响采集——采集的起点是链接——
          但它决定「这一篇算哪个学校的」，简报和对比都按这个分组。
        </Typography.Paragraph>
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
            { title: '学校', dataIndex: 'school', width: 130, render: (v: string) => v || '未填' },
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

export const benchmarkModule: ModuleManifest = {
  id: 'benchmark',
  title: '公众号',
  icon: <BookOutlined />,
  route: '/benchmark',
  enabled: true,
  page: () => <BenchmarkPage />
}
