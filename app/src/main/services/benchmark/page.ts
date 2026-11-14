/**
 * 页面判定：把「渲染完的页面」变成「可入库的结果」。
 *
 * 单独成文件的原因：这段逻辑不该跟某一种渲染方式绑死。现在有两条渲染路径
 * （Electron 隐藏窗口、外部 Edge 无头模式），将来可能还有第三条。判定规则
 * 和标记文案只该有一份，否则两条路径会慢慢判得不一样，成功率统计就失去意义。
 *
 * 这个文件不 import electron，也不碰文件系统，可以单独跑。
 */

export type FetchStatus = 'ok' | 'deleted' | 'unreachable'

export interface FetchOutcome {
  status: FetchStatus
  title: string
  author: string
  publishedAt: string | null
  body: string
  error: string
  /**
   * 纯图推送：页面能正常打开、标题也在，但正文全在图片里，一个字都没抽到。
   * 这不是抓取失败——重试一百次还是空的。调用方应当归档而不是反复重试。
   */
  imageOnly?: boolean
  /** 抓取耗时，仅用于诊断，不入库 */
  elapsedMs?: number
}

/** 页面被判定为这些文案时，说明原文已不可读；分开记，因为处理方式不同 */
const DELETED_MARKERS = ['该内容已被发布者删除', '此内容因违规无法查看', '该公众号已迁移']

/**
 * 风控页。这个必须和普通「暂不可见」分开：它不是这一篇的问题，
 * 而是这台机器被微信盯上了——继续按原速抓，后面每一篇都会是这个结果，
 * 白白把队列里正常的文章都刷成 unreachable。上层收到这个信号应当降速或停手。
 */
const VERIFY_MARKERS = ['环境异常', '完成验证后即可继续访问']

const UNAVAILABLE_MARKERS = ['此内容暂时无法查看']

/** 风控专用文案，上层按这个字符串熔断 */
export const VERIFY_BLOCKED = '触发微信人机验证'

/** 渲染后从页面里取到的原始文字。各后端都要能产出这一份形状 */
export interface RawPage {
  title: string
  author: string
  timeText: string
  body: string
  plain: string
}

const EMPTY = { title: '', author: '', publishedAt: null, body: '' }

/**
 * 页面上固定出现的整句文案。
 *
 * 只收长度足够、正常文章里几乎不会出现的句子——「更多」「确定」「分享」这种
 * 短词一律不碰：它们本身就是正文用词，删了会把真内容切碎。
 * 这里是「宁漏不误」，漏掉的短标签交给下面那条连续短标签规则处理。
 */
const UI_PHRASES = [
  '在小说阅读器读本章',
  '在公众号小说中沉浸阅读',
  '预览时标签不可点',
  '搜索「」网络结果',
  '关闭调整当前正文文字大小',
  '此设置仅对当前内容生效，如需全局调整，请前往微信系统设置',
  '微信扫一扫',
  '关注该公众号',
  '当前内容可能存在未经审核的第三方商业营销信息，请确认是否继续访问',
  '微信公众平台广告规范指引',
  '使用完整服务',
  '使用小程序',
  '可在「公众号 > 右上角 > 划线」找到划线过的内容',
  '选择留言身份',
  '加载失败，点击重试',
  '返回的内容会推荐给朋友和关注你的人',
  '对关注你的人展示公众号身份',
  '你可以补充投诉原因（选填）',
  '名称已清空',
  '赞赏后展示我的头像',
  '暂无作品',
  '确定提交投诉',
  '最低赞赏',
  '赠予作者'
]

/** 署名行：整段都是岗位上的人名，不含活动信息，统计正文长度时不该算进去 */
const BYLINE_BLOCK =
  /(?:供稿|排版|校对|审核|文案|编辑|责编|摄影|图片|设计|来源|监制|指导老师|审核老师|美编)\s*[:：][^。！？\n]{0,40}/g

function cleanPlain(text: string): string {
  let out = text
  for (const p of UI_PHRASES) out = out.split(p).join(' ')
  // 页尾那串「赞 在看 分享 留言 收藏」只在按钮条上连着出现，四个以上连着就是按钮条
  out = out.replace(/(?:\s*(?:赞|在看|分享|留言|收藏|听过)\s*){3,}/g, ' ')
  return out.replace(/[ \t\u00a0]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 去掉署名行后还剩多少个汉字——这才是「文章里有多少可读内容」 */
export function meaningfulChars(text: string): number {
  return (text.replace(BYLINE_BLOCK, '').match(/[\u4e00-\u9fa5]/g) ?? []).length
}

/** 正文至少要有这么多实义字，低于此数的当纯图推送，不当正文 */
const MIN_BODY_CHARS = 60
/** 整页文字兜底的门槛要高得多：那份文字里混着大量界面文案，宁严不宽 */
const MIN_PLAIN_CHARS = 200

/**
 * 判定一份页面。
 *
 * 三种结果分得很细，因为下游处理完全不同：
 * deleted 是原文没了（常态，从成功率分母里剔除，不再重试）；
 * unreachable 是这次没拿到（可能是风控、超时、渲染失败，要重试）；
 * 只有 ok 才进抽取。
 */
export function judgePage(page: RawPage, parseTime: (text: string) => string | null): FetchOutcome {
  const plain = page.plain || ''

  if (DELETED_MARKERS.some((m) => plain.includes(m))) {
    return { ...EMPTY, status: 'deleted', error: '原文已删除' }
  }
  if (VERIFY_MARKERS.some((m) => plain.includes(m))) {
    return { ...EMPTY, status: 'unreachable', error: VERIFY_BLOCKED }
  }
  if (UNAVAILABLE_MARKERS.some((m) => plain.includes(m))) {
    return { ...EMPTY, status: 'unreachable', error: '内容暂不可见' }
  }

  // 先看正文区。判的是「实义字」有多少，不是字符长度：一篇长图推送的
  // #js_content 里也可能有几百个字，但全是供稿、排版、校对这几行署名。
  const bodyChars = meaningfulChars(page.body)
  if (bodyChars >= MIN_BODY_CHARS) {
    return {
      status: 'ok',
      title: page.title,
      author: page.author,
      publishedAt: parseTime(page.timeText),
      body: page.body,
      error: ''
    }
  }

  // 正文区不够时用整页文字兜底，但要先洗掉界面文案，并且门槛调高。
  // 不设这道坎的话，纯图推送会拿着「关闭 更多 搜索 网络结果 不喜欢…」
  // 当正文入库，抽取出来的活动字段全是噪声。
  const cleaned = cleanPlain(plain)
  if (meaningfulChars(cleaned) >= MIN_PLAIN_CHARS) {
    return {
      status: 'ok',
      title: page.title,
      author: page.author,
      publishedAt: parseTime(page.timeText),
      body: cleaned.slice(0, 3000),
      error: ''
    }
  }

  // 页面能开、标题也在，就是一个字可读内容都没有 —— 这类是纯图推送。
  // 归成失败会让队列永远清不掉，所以单独标出来，让上层归档。
  if (page.title.trim()) {
    return {
      status: 'ok',
      title: page.title,
      author: page.author,
      publishedAt: parseTime(page.timeText),
      body: page.body.slice(0, 3000),
      error: '正文为图片，无可抽取文字',
      imageOnly: true
    }
  }
  return { ...EMPTY, status: 'unreachable', error: '正文为空' }
}

/** 渲染后页面里就地取字段的脚本。两条后端共用同一份，避免取数口径分叉 */
export const PAGE_EXTRACT_SCRIPT = `(() => {
  const meta = (p) => {
    const el = document.querySelector('meta[property="' + p + '"]')
    return el ? (el.getAttribute('content') || '').trim() : ''
  }
  const text = (sel) => {
    const el = document.querySelector(sel)
    return el ? (el.innerText || el.textContent || '').trim() : ''
  }
  const content = document.querySelector('#js_content') || document.querySelector('#js_image_content')
  let body = ''
  if (content) {
    const clone = content.cloneNode(true)
    clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove())
    body = (clone.innerText || clone.textContent || '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim()
  }
  const plain = (document.body ? document.body.innerText : '').slice(0, 3000)
  // 公众号名优先取页面上的 #js_name。og:article:author 会被站点填成
  // 「欢迎新生的」这类推广语，只当兜底；带标点或以「的」结尾的一律不要，
  // 免得凭空建出一个不存在的公众号源。
  const okName = (s) => {
    const v = (s || '').replace(/\\s+/g, ' ').trim()
    if (!v || v.length > 40) return ''
    if (/[，。、；：？！,.;:!?]/.test(v)) return ''
    if (/^(欢迎|点击|关注|扫码|长按|回复)/.test(v)) return ''
    if (/的$/.test(v)) return ''
    return v
  }
  const jsName = text('#js_name')
  return {
    title: meta('og:title') || text('#activity-name') || document.title || '',
    author: okName(jsName) || okName(meta('og:article:author')),
    timeText: text('#publish_time'),
    body,
    plain
  }
})()`
