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
import { BookOutlined, CloudDownloadOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ModuleManifest } from './types'
import type {
  BenchArticleDetail,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchArticleStatus,
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

  const [school, setSchool] = useState('')
  const [kind, setKind] = useState('')
  const [keyword, setKeyword] = useState('')
  const [secondOnly, setSecondOnly] = useState(false)
  /** 时间窗口：最终版写的是「上海各高校一年内的所有活动」，所以默认给一年 */
  const [range, setRange] = useState<'all' | 'half' | 'year'>('year')

  const load = useCallback(async () => {
    const filter: BenchArticleFilter = {
      school: school || undefined,
      kind: kind || undefined,
      keyword: keyword || undefined,
      secondNoticeOnly: secondOnly || undefined,
      from: range === 'all' ? undefined : daysAgo(range === 'year' ? 365 : 180),
      limit: 200
    }
    const [nextStats, nextRows, nextSchools, nextKinds] = await Promise.all([
      window.api.benchStats(),
      window.api.benchArticles(filter),
      window.api.benchSchools(),
      window.api.benchKinds()
    ])
    setStats(nextStats)
    setRows(nextRows)
    setSchools(nextSchools)
    setKinds(nextKinds)
  }, [school, kind, keyword, secondOnly, range])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setBusy(label)
    try {
      const tip = await action()
      await load()
      message.success(tip)
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
      return `采集完成：成功 ${r.fetched}，原文已删 ${r.deleted}，暂不可见 ${r.unreachable}`
    })
  }

  const doExtract = (): void => {
    void run('extract', async () => {
      const r = await window.api.benchExtract(20)
      return `抽取完成：活动 ${r.activities}，非活动 ${r.skipped}，失败 ${r.failed}`
    })
  }

  const openDetail = (id: number): void => {
    void window.api.benchArticle(id).then((d) => setDetail(d))
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

export const benchmarkModule: ModuleManifest = {
  id: 'benchmark',
  title: '对标库',
  icon: <BookOutlined />,
  route: '/benchmark',
  enabled: true,
  page: () => <BenchmarkPage />
}
