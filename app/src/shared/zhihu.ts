/** 知乎反推荐：前后端共享类型与通道约定。 */

/** 独立持久化分区：知乎登录态只留在该分区，不污染主窗口会话。 */
export const ZHIHU_PARTITION = 'persist:zhihu'

export type ZhihuPushStatus = 'pending' | 'read' | 'saved' | 'ignored'
export type ZhihuPushAction = 'read' | 'save' | 'ignore' | 'restore'
/** 知乎页里的两个板块：推荐（贴兴趣）与反推荐（由推荐位引出另一面）。 */
export type ZhihuBoard = 'recommend' | 'counter'

/** 一条知乎推送；board 决定它落在「推荐」还是「反推荐」。 */
export interface ZhihuPush {
  id: number
  dateKey: string
  itemKey: string
  title: string
  excerpt: string
  url: string
  author: string
  contentType: string
  voteup: number | null
  reason: string
  distance: number | null
  status: ZhihuPushStatus
  board: ZhihuBoard
  infoId: number | null
  createdAt: string
}

export interface ZhihuStatus {
  /** 当前是否存在可用的知乎登录态（z_c0 Cookie） */
  loggedIn: boolean
  lastSyncAt: string | null
  lastError: string
  /** 推荐板每日条数 */
  recommendCount: number
  /** 反推荐板每日条数 */
  counterCount: number
  /** 今天推荐板已生成条数 */
  todayRecommendCount: number
  /** 今天反推荐板已生成条数 */
  todayCounterCount: number
  /** 本次排序实际用到的兴趣标签（来自应用画像） */
  tags: string[]
  /** 兼容旧调用：等于 counterCount */
  count: number
  /** 兼容旧调用：两个板块合计 */
  todayCount: number
}

export interface ZhihuTodayResult {
  status: ZhihuStatus
  pushes: ZhihuPush[]
}

export interface ZhihuOpResult {
  ok: boolean
  message: string
  pushes?: ZhihuPush[]
}

export interface ZhihuApi {
  zhihuStatus(): Promise<ZhihuStatus>
  zhihuLogin(): Promise<ZhihuOpResult>
  /** 清除本机保存的知乎登录态（推荐条目与资料不受影响） */
  zhihuLogout(): Promise<ZhihuOpResult>
  zhihuSync(force?: boolean): Promise<ZhihuOpResult>
  zhihuToday(): Promise<ZhihuTodayResult>
  zhihuAct(id: number, action: ZhihuPushAction, folder?: string): Promise<ZhihuOpResult>
}
