import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { App as AntApp, Button, Tabs, Tag, Tooltip } from 'antd'
import {
  BookOutlined,
  BulbOutlined,
  CheckOutlined,
  EyeInvisibleOutlined,
  LinkOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined
} from '@ant-design/icons'
import type { RendererApi } from '@shared/types'
import type { FeedPlatformTemplate } from '@shared/feedPlatform'
import type {
  ZhihuBoard,
  ZhihuOpResult,
  ZhihuPush,
  ZhihuPushAction,
  ZhihuPushStatus,
  ZhihuTodayResult
} from '@shared/zhihu'
import './interestFeed.css'

export interface InterestFeedApi {
  today(): Promise<ZhihuTodayResult>
  sync(force?: boolean): Promise<ZhihuOpResult>
  act(id: number, action: ZhihuPushAction): Promise<ZhihuOpResult>
  openExternal(url: string): Promise<unknown>
}

/** 当前只有知乎；其它平台接同形 API 后可直接复用 InterestFeedSection。 */
export function zhihuInterestApi(api: RendererApi): InterestFeedApi {
  return {
    today: () => api.zhihuToday(),
    sync: (force) => api.zhihuSync(force),
    act: (id, action) => api.zhihuAct(id, action),
    openExternal: (url) => api.appOpenExternal(url)
  }
}

const STATUS_META: Record<ZhihuPushStatus, { label: string; color: string }> = {
  pending: { label: '待读', color: 'gold' },
  read: { label: '已读', color: 'blue' },
  saved: { label: '已存资料', color: 'green' },
  ignored: { label: '已忽略', color: 'default' }
}

const TYPE_LABEL: Record<string, string> = {
  answer: '回答',
  article: '文章',
  zvideo: '视频'
}

function whenText(iso: string | null): string {
  if (!iso) return '尚未同步'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '尚未同步'
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function InterestFeedSection({
  template,
  api,
  onOpenSettings,
  onOpenAccounts
}: {
  template: FeedPlatformTemplate
  api: InterestFeedApi
  onOpenSettings: () => void
  onOpenAccounts: () => void
}): ReactElement {
  const { message } = AntApp.useApp()
  const [data, setData] = useState<ZhihuTodayResult | null>(null)
  const [board, setBoard] = useState<ZhihuBoard>(template.boards[0]?.key ?? 'recommend')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setData(await api.today())
    } catch (error) {
      message.error(`读取${template.label}失败：` + (error instanceof Error ? error.message : String(error)))
    } finally {
      setLoading(false)
    }
  }, [api, message, template.label])

  useEffect(() => {
    void load()
  }, [load])

  const applyResult = useCallback((pushes: ZhihuPush[] | undefined): void => {
    if (!pushes) {
      void load()
      return
    }
    setData((previous) => (previous ? { ...previous, pushes } : previous))
  }, [load])

  const sync = async (force: boolean): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.sync(force)
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      applyResult(result.pushes)
    } catch (error) {
      message.error(`生成${template.label}内容失败：` + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  const act = async (id: number, action: ZhihuPushAction): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.act(id, action)
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      applyResult(result.pushes)
    } catch (error) {
      message.error('操作失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  const openOriginal = async (url: string): Promise<void> => {
    try {
      await api.openExternal(url)
    } catch (error) {
      message.error('打开原文失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const status = data?.status
  const pushes = data?.pushes ?? []
  const boardPushes = (key: ZhihuBoard): ZhihuPush[] => pushes.filter((push) => push.board === key)
  const activeBoard = template.boards.find((item) => item.key === board) ?? template.boards[0]

  const boardList = (key: ZhihuBoard): ReactElement => {
    const list = boardPushes(key)
    const boardTemplate = template.boards.find((item) => item.key === key)
    if (!list.length) {
      return (
        <div className="interest-feed-empty">
          <span>今天还没有生成{boardTemplate?.label ?? '内容'}。</span>
          <Button size="small" type="primary" loading={busy} onClick={() => void sync(true)}>
            生成今天的{boardTemplate?.label ?? '内容'}
          </Button>
        </div>
      )
    }
    return (
      <div className="interest-feed-list">
        {list.map((push, index) => {
          const meta = STATUS_META[push.status]
          return (
            <article key={push.id} className={`interest-push interest-push-${push.status}`}>
              <div className="interest-push-body">
                <div className="interest-push-title-row">
                  <span className="interest-push-index">{String(index + 1).padStart(2, '0')}</span>
                  <h4>{push.title}</h4>
                  <Tag color={meta.color}>{meta.label}</Tag>
                </div>
                {push.excerpt && <p className="interest-push-excerpt">{push.excerpt}</p>}
                <div className="interest-push-meta">
                  {TYPE_LABEL[push.contentType] ?? push.contentType} · {push.author || '匿名用户'} ·{' '}
                  {push.voteup ?? 0} 赞
                </div>
                <div className={`interest-push-reason ${key === 'counter' ? 'is-counter' : ''}`}>
                  {key === 'counter' ? <SwapOutlined /> : <BulbOutlined />} {push.reason}
                </div>
              </div>
              <div className="interest-push-actions">
                <Button size="small" type="text" icon={<LinkOutlined />} onClick={() => void openOriginal(push.url)}>
                  读原文
                </Button>
                {push.status === 'pending' && (
                  <Button size="small" type="text" icon={<CheckOutlined />} onClick={() => void act(push.id, 'read')}>
                    已读
                  </Button>
                )}
                {push.status !== 'saved' && (
                  <Button
                    size="small"
                    type="text"
                    icon={<BookOutlined />}
                    disabled={busy}
                    onClick={() => void act(push.id, 'save')}
                  >
                    存为资料
                  </Button>
                )}
                {push.status === 'ignored' ? (
                  <Button size="small" type="text" disabled={busy} onClick={() => void act(push.id, 'restore')}>
                    恢复
                  </Button>
                ) : push.status !== 'saved' ? (
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<EyeInvisibleOutlined />}
                    disabled={busy}
                    onClick={() => void act(push.id, 'ignore')}
                  >
                    不感兴趣
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    )
  }

  return (
    <section className="interest-feed" aria-label={`${template.title}推荐与反推荐`}>
      <div className="interest-feed-head">
        <div className="interest-feed-heading">
          <span className="interest-feed-kicker">{template.kicker}</span>
          <div>
            <h3>{template.title}</h3>
            <p>
              {status
                ? `今日推荐 ${status.todayRecommendCount} 条 · 反推荐 ${status.todayCounterCount} 条 · 目标 ${status.recommendCount}/${status.counterCount} · 上次同步 ${whenText(status.lastSyncAt)}`
                : '按你的兴趣标签生成推荐，再由推荐位引出反推荐'}
            </p>
          </div>
        </div>
        <div className="interest-feed-tools">
          {status?.loggedIn ? (
            <>
              <Tooltip title="重新读取推荐流，刷新两个板块">
                <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={() => void sync(true)}>
                  刷新
                </Button>
              </Tooltip>
              <Tooltip title="每天条数在「日报 → 日报设置」里修改">
                <Button size="small" type="text" icon={<SettingOutlined />} onClick={onOpenSettings}>
                  每日条数
                </Button>
              </Tooltip>
            </>
          ) : (
            <Button size="small" onClick={onOpenAccounts}>
              账号管理
            </Button>
          )}
        </div>
      </div>

      {status?.lastError && <div className="interest-feed-error">{status.lastError}</div>}

      {status?.loggedIn && status.tags.length > 0 && (
        <div className="interest-feed-tags" aria-label="本次排序使用的兴趣标签">
          <span>兴趣标签</span>
          {status.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      )}

      {loading ? (
        <div className="interest-feed-loading">正在读取{template.title}…</div>
      ) : !status?.loggedIn ? (
        <div className="interest-feed-connect">
          <div>
            <strong>在「设置 → 账号管理」连接一次{template.label}，之后每天自动读取推荐流。</strong>
            <span>只保存登录会话，不保存密码；内容只在本机处理。启用 AI 时，候选标题和摘要会发送到已授权的 AI 端点。</span>
          </div>
          <Button type="primary" onClick={onOpenAccounts}>
            去账号管理连接
          </Button>
        </div>
      ) : (
        <>
          <div className="interest-feed-board-hint">{activeBoard?.hint}</div>
          <Tabs
            activeKey={board}
            onChange={(key) => setBoard(key as ZhihuBoard)}
            items={template.boards.map((item) => ({
              key: item.key,
              label: `${item.label} ${boardPushes(item.key).length}`,
              children: boardList(item.key)
            }))}
          />
        </>
      )}
    </section>
  )
}
