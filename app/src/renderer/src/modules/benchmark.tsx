import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { BookOutlined, CloudDownloadOutlined, FileTextOutlined, PlusOutlined, SwapOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ModuleManifest } from './types'
import type {
  BenchArticleDetail,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchArticleStatus,
  BenchBrief,
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
  const [schools, setSchools] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [detail, setDetail] = useState<BenchArticleDetail | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [brief, setBrief] = useState<BenchBrief | null>(null)
  /** 勾选用于并排对比的文章；最多 4 篇，再多就没法并排看了 */
  const [picked, setPicked] = useState<number[]>([])
  const [compare, setCompare] = useState<BenchArticleDetail[] | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [sources, setSources] = useState<BenchSourceInfo[]>([])
  const [newName, setNewName] = useState('')
  const [newSchool, setNewSchool] = useState('')
  const [newCategory, setNewCategory] = useState<BenchSourceCategory>('student_union')

  const [school, setSchool] = useState('')
  const [kind, setKind] = useState('')
  const [keyword, setKeyword] = useState('')
  const [secondOnly, setSecondOnly] = useState(false)
  /** 时间窗口：最终版写的是「上海各高校一年内的所有活动」，所以默认给一年 */
  const [range, setRange] = useState<'all' | 'half' | 'year'>('year')

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
    const [nextStats, nextRows, nextSchools, nextKinds, nextSources] = await Promise.all([
      window.api.benchStats(),
      window.api.benchArticles(filter),
      window.api.benchSchools(),
      window.api.benchKinds(),
      window.api.benchSources()
    ])
    setStats(nextStats)
    setRows(nextRows)
    setSchools(nextSchools)
    setKinds(nextKinds)
    setSources(nextSources)
  }, [currentFilter])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setBusy(label)
    try {
      const tip = await action()
      await load()
      // 空字符串表示「这个动作自己把结果展示出来了」，不必再弹一条提示
      if (tip) message.success(tip)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

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
      const byRule = r.mode === 'rule' ? '（未配模型，按规则抽取：只有类型、时间、地点）' : ''
      return `抽取完成${byRule}：活动 ${r.activities}，非活动 ${r.skipped}，失败 ${r.failed}`
    })
  }

  const openDetail = (id: number): void => {
    void window.api.benchArticle(id).then((d) => setDetail(d))
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
      render: (_v, row) => (
        <Typography.Link onClick={() => openDetail(row.id)}>
          {row.title || row.url.slice(0, 40)}
        </Typography.Link>
      )
    },
    { title: '学校', dataIndex: 'school', width: 110, render: (v: string) => v || '—' },
    { title: '公众号', dataIndex: 'sourceName', width: 140, render: (v: string) => v || '—' },
    {
      title: '发布时间',
      dataIndex: 'publishedAt',
      width: 140,
      render: (v: string | null) => shortDate(v)
    },
    {
      title: '周次',
      dataIndex: 'weekNo',
      width: 70,
      render: (v: number | null) => (v ? `第${v}周` : '—')
    },
    { title: '类型', dataIndex: 'kind', width: 110, render: (v: string) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: BenchArticleStatus) => <Tag color={STATUS_TEXT[v].color}>{STATUS_TEXT[v].text}</Tag>
    },
    {
      title: '标记',
      dataIndex: 'isSecondNotice',
      width: 96,
      render: (v: boolean, row) =>
        v ? (
          <Tooltip title="这篇是改期/换场地/取消之类的二次通知">
            <Tag color="volcano">{NOTICE_TEXT[row.noticeKind] ?? '二次通知'}</Tag>
          </Tooltip>
        ) : null
    }
  ]

  return (
    <div className="bench">
      <div className="bench-head">
        <div className="bench-title">
          <BookOutlined /> 跨校对标库
        </div>
        <div className="bench-stats">
          {stats ? (
            <>
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

      <Space className="bench-tools" wrap>
        <Button onClick={() => setSourcesOpen(true)}>
          公众号源（{stats?.sources ?? 0}）
        </Button>
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
        <Button
          type="primary"
          icon={<FileTextOutlined />}
          loading={busy === 'brief'}
          disabled={!!busy && busy !== 'brief'}
          onClick={doBrief}
        >
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
          style={{ width: 150 }}
          placeholder="全部学校"
          allowClear
          value={school || undefined}
          onChange={(v) => setSchool(v ?? '')}
          options={schools.map((s) => ({ value: s, label: s }))}
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
      </Space>

      {!stats?.articles ? (
        <Empty
          className="bench-empty"
          description="库里还没有文章。先点「导入链接」粘一批公众号链接，再点「采集正文」。"
        />
      ) : (
        <Table
          className="bench-table"
          size="small"
          rowKey="id"
          pagination={{ pageSize: 50, showSizeChanger: false }}
          columns={columns}
          dataSource={rows}
          rowSelection={{
            selectedRowKeys: picked,
            onChange: (keys) => setPicked(keys as number[]),
            // 最多四篇：再多并排就挤成一团，读不出差异
            getCheckboxProps: (row) => ({ disabled: picked.length >= 4 && !picked.includes(row.id) })
          }}
        />
      )}

      <Drawer
        open={!!detail}
        width={560}
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
              <span>{detail.sourceName || '未识别公众号'}</span>
              <span>{shortDate(detail.publishedAt)}</span>
              <Tag color={STATUS_TEXT[detail.status].color}>{STATUS_TEXT[detail.status].text}</Tag>
            </div>
            {detail.error ? <Alert type="warning" showIcon message={detail.error} /> : null}
            {detail.activity ? (
              <div className="bench-fields">
                <Field label="类型" value={detail.activity.kind} />
                <Field label="主办" value={detail.activity.organizer} />
                <Field label="时间" value={detail.activity.startAt} />
                <Field
                  label="周次"
                  value={detail.activity.weekNo ? `第${detail.activity.weekNo}周` : ''}
                />
                <Field label="地点" value={detail.activity.location} />
                <Field label="对象" value={detail.activity.audience} />
                <Field label="组织方式" value={detail.activity.orgForm} />
                <Field label="参与方式" value={detail.activity.joinMethod} />
                <Field label="宣传" value={detail.activity.promoChannels.join('、')} />
                <Field
                  label="可迁移"
                  value={MIGRATION_TEXT[detail.activity.migrationFit]}
                />
                <Field
                  label="把握"
                  value={detail.activity.confidence ? `${Math.round(detail.activity.confidence * 100)}%` : ''}
                />
                <Field label="理由" value={detail.activity.migrationNote} />
                {detail.activity.agenda.length ? (
                  <div className="bench-agenda">
                    <span className="bench-field-label">议程</span>
                    <ol>
                      {detail.activity.agenda.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Typography.Paragraph className="bench-body">
              {detail.body ? detail.body.slice(0, 3000) : '（没有正文）'}
            </Typography.Paragraph>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={!!brief}
        width={720}
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

      <Drawer
        open={!!compare}
        width={Math.min(1100, 320 * (compare?.length ?? 2) + 160)}
        onClose={() => setCompare(null)}
        title="并排对比"
      >
        {compare && compare.length >= 2 ? <CompareTable items={compare} /> : null}
      </Drawer>

      <Drawer
        open={sourcesOpen}
        width={720}
        onClose={() => setSourcesOpen(false)}
        title="公众号源"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这里列的是要跟踪的公众号。名单本身不影响采集——采集的起点是链接——
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

/**
 * 并排对比要看的字段。
 *
 * 顺序是有讲究的：先「是什么、什么时候、在哪」，再「怎么办的」，
 * 最后才是「我们能不能照做」。这个顺序就是跟人讲这件事的顺序。
 */
const COMPARE_FIELDS: { label: string; get: (d: BenchArticleDetail) => string }[] = [
  { label: '学校', get: (d) => d.school },
  { label: '公众号', get: (d) => d.sourceName },
  { label: '活动类型', get: (d) => d.activity?.kind ?? '' },
  { label: '时间', get: (d) => (d.activity?.startAt ? d.activity.startAt.slice(0, 16) : '') },
  { label: '周次', get: (d) => (d.activity?.weekNo ? `第 ${d.activity.weekNo} 周` : '') },
  { label: '地点', get: (d) => d.activity?.location ?? '' },
  { label: '组织方式', get: (d) => d.activity?.orgForm ?? '' },
  { label: '面向', get: (d) => d.activity?.audience ?? '' },
  { label: '参与方式', get: (d) => d.activity?.joinMethod ?? '' },
  { label: '议程', get: (d) => (d.activity?.agenda ?? []).join(' → ') },
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
                  <span className="bench-compare-school">{d.school || '未填学校'}</span>
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
  title: '对标库',
  icon: <BookOutlined />,
  route: '/benchmark',
  enabled: true,
  page: () => <BenchmarkPage />
}
