/**
 * 知乎推荐流垃圾过滤（移植自 antipode/codex读agents/first/code/junk_filter.py）。
 *
 * 推荐流是混装的：真观点、品牌广告、盐选小说、种草软文、三行字空壳都在同一个列表里。
 * 反推荐如果不过滤，就会给广告找「远视角」，既荒谬又浪费 AI 调用。
 *
 * 分四层，宁可漏掉一条广告，也不误杀一篇好文章：
 * 1) 结构性判据：广告跳转域 / 付费墙 URL；
 * 2) 标记层：标题/摘要里平台自己打的「广告」「盐选」「会员专享」；
 * 3) 文风层：章节号 + 第一人称 + 网文套路词 + 完结标记，命中至少 2 条才判网文；
 * 4) 种草层：至少 2 个导购词，或 1 个导购词 + 商品参数/型号。
 * 最后是空壳：没有标题正文，或只有一句话且没有链接。
 */

export type JunkKind = 'ad' | 'fiction' | 'empty' | ''

export interface JunkVerdict {
  drop: boolean
  junk: JunkKind
  reason: string
}

export interface JunkInput {
  url?: string
  title?: string
  text?: string
}

const AD_HOSTS = ['link.zhihu.com', 'click.zhihu.com', 'e.zhihu.com']
const AD_URL_MARKS = ['utm_source=ad', 'utm_medium=ad', 'ad_id=']
const PAYWALL_URL_MARKS = ['/market/', '/pay/', 'zhuanlan.zhihu.com/pay']

const AD_LABELS = ['广告', '赞助', '推广', '品牌合作', '商业推广']
const PAYWALL_LABELS = [
  '盐选',
  '盐选专栏',
  '盐选推荐',
  '会员专享',
  '付费内容',
  '开通会员',
  '继续阅读需付费'
]

const CHAPTER = /第\s*[一二三四五六七八九十百零\d]+\s*[章节回]/
const FIRST_PERSON = /^(我|我们|本人)(被|在|重生|穿越|觉醒|回到|成了)/
const WEB_NOVEL = [
  '重生',
  '穿越',
  '快穿',
  '系统绑定',
  '追妻',
  '虐恋',
  '霸总',
  '校花',
  '赘婿',
  '龙王',
  '修仙',
  '飞升',
  '渡劫',
  '末世',
  '灵气复苏'
]
const SERIAL_MARKS = ['（完）', '(完)', '全文', '大结局', '已完结', '完结文']

const SHOPPING_WORDS = [
  '种草',
  '测评',
  '横评',
  '实测',
  '爆款',
  '限时',
  '优惠',
  '领券',
  '下单',
  '好物',
  '团购',
  '选购',
  '哪款',
  '怎么选',
  '平替',
  '折扣',
  '秒杀',
  '直降',
  '到手价',
  '闭眼入',
  '回购',
  '拔草',
  '攻略',
  '推荐'
]
const SPEC_TOKEN = /\d+\s*(?:nm|μm|um|mm|cm|寸|英寸|Hz|GB|TB|mAh|毫安|万|元|W\b)/i
const MODEL_TOKEN = /(?:[A-Za-z]{1,6}\d{2,4}[A-Za-z]{0,3}|[A-Z]{2,}[-\s]?\d{2,4})/

function drop(junk: Exclude<JunkKind, ''>, reason: string): JunkVerdict {
  return { drop: true, junk, reason }
}

export function classifyJunk(input: JunkInput): JunkVerdict {
  const url = (input.url ?? '').trim().toLowerCase()
  const title = (input.title ?? '').trim()
  const body = (input.text ?? '').trim()
  const head = `${title} ${body.slice(0, 80)}`

  // 1) 结构性判据
  if (AD_HOSTS.some((host) => url.includes(host))) return drop('ad', `跳转到站外广告域：${AD_HOSTS.find((h) => url.includes(h))}`)
  if (AD_URL_MARKS.some((mark) => url.includes(mark))) return drop('ad', `URL 带广告/商品特征：${AD_URL_MARKS.find((m) => url.includes(m))}`)
  if (PAYWALL_URL_MARKS.some((mark) => url.includes(mark))) return drop('fiction', 'URL 落在盐选/付费墙内')

  // 2) 平台标记
  if (AD_LABELS.some((label) => head.includes(label))) return drop('ad', '标题/摘要自带「广告」标记')
  if (PAYWALL_LABELS.some((label) => head.includes(label))) return drop('fiction', '标题/摘要自带「盐选/会员」标记')

  // 3) 网文文风：至少两条特征同时命中
  const hits: string[] = []
  if (CHAPTER.test(title)) hits.push('章节号')
  if (FIRST_PERSON.test(title)) hits.push('第一人称故事开头')
  const novel = WEB_NOVEL.filter((word) => title.includes(word))
  if (novel.length) hits.push('网文套路词:' + novel.slice(0, 3).join('/'))
  if (SERIAL_MARKS.some((mark) => title.includes(mark))) hits.push('完结标记')
  if (hits.length >= 2) return drop('fiction', '标题像网文：' + hits.join('、'))

  // 4) 种草/导购：导购词 +（第二个导购词 / 参数 / 型号）
  const shopping = SHOPPING_WORDS.filter((word) => title.includes(word))
  if (shopping.length) {
    const spec = SPEC_TOKEN.exec(title)
    const model = MODEL_TOKEN.exec(title)
    if (shopping.length >= 2 || spec || model) {
      let detail = shopping.slice(0, 3).join('、')
      if (spec) detail += ` + 参数「${spec[0].trim()}」`
      else if (model) detail += ` + 型号「${model[0]}」`
      return drop('ad', '标题像种草/导购：' + detail)
    }
  }

  // 5) 空壳
  if (!body && !title) return drop('empty', '标题和正文都为空')
  if (body.length < 30 && !url) return drop('empty', '只有一句话，没有可读内容')

  return { drop: false, junk: '', reason: '' }
}
