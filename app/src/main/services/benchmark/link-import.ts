/**
 * 从一段文本里捞出公众号文章链接，顺带带上标题和发布时间。
 *
 * 两种输入：
 * 1. 界面里粘贴的一堆链接（一行一个，或者从聊天记录里连文字一起粘）；
 * 2. wechatDownload 这类工具导出的 CSV：
 *    title,url,time,like_num,read_num,share_num,comment_count
 *
 * 为什么 CSV 也要认：搜索引擎只给「被收录过的那几篇」，一个号一年发几十条，
 * 收录的常常只有个位数。工具能翻完整历史列表，那份列表就是这个格式。
 * 它负责「有哪些文章」，我们负责「抓正文、抽字段、做对标」。
 *
 * 标题和时间能先落库就先落：正文还没抓的时候，列表至少能看出「这个号有多少篇」，
 * 而不是一片空白让人以为导入失败了。
 */

/** 只认公众号文章页。短链 s/xxx 也收，但它没有 __biz，去重时会算无效 */
const ARTICLE_URL = /https?:\/\/mp\.weixin\.qq\.com\/s[?/][^\s"'<>\])，。；、,]*/g

const TIME = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/

export interface ParsedLink {
  url: string
  /** CSV 第 1 列；纯文本粘贴时为空 */
  title: string
  /** 归一化成 YYYY-MM-DD HH:MM:SS；没有就是 null */
  publishedAt: string | null
}

/** HTML 转义、锚点、末尾粘着的句读——这些都是从网页/表格里捞出来时的常见残渣 */
function cleanUrl(raw: string): string {
  let url = raw.replace(/&amp;/g, '&').trim()
  const hash = url.indexOf('#')
  if (hash >= 0) url = url.slice(0, hash)
  return url.replace(/[)\]，。；、！？!?]+$/g, '')
}

/**
 * 拆一行 CSV。
 *
 * 不能直接 split(',')：标题里带逗号是常事（「迎新晚会，我们来啦」），
 * Excel 导出时会用双引号把整格包起来。这里只需要拆对，不做类型推断。
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cell)
      cell = ''
    } else cell += ch
  }
  out.push(cell)
  return out.map((x) => x.trim())
}

function normalizeTime(raw: string): string | null {
  const m = raw.match(TIME)
  if (!m) return null
  const pad = (v: string): string => v.padStart(2, '0')
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`
}

/** 这一格像不像标题：非空、不是链接、不是纯数字、不是时间 */
function looksLikeTitle(cell: string): boolean {
  const v = cell.trim()
  if (!v || v.includes('mp.weixin.qq.com')) return false
  if (/^\d+(\.\d+)?$/.test(v)) return false
  if (TIME.test(v) && v.length < 24) return false
  if (/^https?:\/\//i.test(v)) return false
  return v.length >= 2
}

/**
 * 解析整段文本。返回的顺序与原文一致，去重交给调用方（按 __biz+mid+idx）。
 */
export function parseLinkRows(text: string): ParsedLink[] {
  const out: ParsedLink[] = []
  if (!text) return out

  // Excel 另存的 CSV 常带 BOM，不去掉的话第一列会多一个不可见字符
  const src = text.replace(/^\uFEFF/, '')

  for (const line of src.split(/\r?\n/)) {
    if (!line.trim()) continue

    const hits = [...line.matchAll(ARTICLE_URL)]
    if (hits.length === 0) continue

    // 一行里出现 3 个以上逗号分隔的格子，且其中有链接，才当 CSV 看。
    // 否则就是「粘了一段带链接的话」，把整段话当标题会污染列表。
    const cells = line.includes(',') ? splitCsvLine(line) : []
    const isCsv = cells.length >= 3 && cells.some((c) => c.includes('mp.weixin.qq.com'))

    let title = ''
    let publishedAt: string | null = null
    if (isCsv) {
      title = cells.find((c) => looksLikeTitle(c)) ?? ''
      // 时间列通常在第 3 格；按内容找比按下标找稳，列顺序变了也不会错
      for (const cell of cells) {
        const t = normalizeTime(cell)
        if (t) {
          publishedAt = t
          break
        }
      }
    }

    hits.forEach((hit, index) => {
      const url = cleanUrl(hit[0])
      if (url.length < 30) return
      out.push({
        url,
        // 一行多个链接时，标题只给第一个，避免同一段标题被复制到每一条上
        title: index === 0 ? title : '',
        publishedAt: index === 0 ? publishedAt : null
      })
    })
  }

  return out
}
