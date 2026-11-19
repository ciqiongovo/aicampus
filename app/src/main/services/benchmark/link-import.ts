/**
 * 从一段文本里捞出公众号文章链接，顺带带上标题、发布时间和公众号名。
 *
 * 三种输入：
 * 1. 界面里粘贴的一堆链接（一行一个，或者从聊天记录里连文字一起粘）；
 * 2. wechatDownload 这类工具导出的 CSV：
 *    title,url,time,like_num,read_num,share_num,comment_count
 * 3. 同一种表，但列名是中文、顺序也不一样（Excel 导出常见）：
 *    公众号名称,文章标题,文章链接,发布时间,阅读数...
 *
 * 为什么要认第 3 种：各家的「导出表格」列顺序不一样，公众号名还常排在第一列。
 * 只按「第一个像标题的格子」去猜，会把公众号名当成标题，整份列表看起来全是
 * 「上海交通大学学生会」——比不导入更让人困惑。所以有表头就按表头取，
 * 没表头才回到按内容猜，并靠「同一列在多行里重复」认出公众号名。
 *
 * 标题、时间、公众号名能先落库就先落：正文还没抓的时候，列表至少能看出
 * 「哪个号、多少篇、什么时候发的」，而不是一片空白让人以为导入失败了。
 */

/** 只认公众号文章页。短链 s/xxx 也收，但它没有 __biz，去重时会算无效 */
const ARTICLE_URL = /https?:\/\/mp\.weixin\.qq\.com\/s[?/][^\s"'<>\])，。；、,]*/g

/** 2026-10-11 / 2026/10/11 / 2026年10月11日，后面可跟时间 */
// 分隔符后面的 [ T] 必须是可选的：`\s*日?` 会把日期与时间之间的空格吃掉，
// 再要求一个空格才配时间，就会只解析出日期、时间悄悄变成 00:00:00。
const TIME = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?(?:[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?/

/** 公众号名常见字样：用来在没表头时认列，也用来判断某个格子像不像号名 */
const ACCOUNT_HINT = /(学生会|研究生会|团委|共青团|青年|大学|学院|书院|社团|社联|研究生|招生|教务)/

export interface ParsedLink {
  url: string
  /** CSV 的标题列；纯文本粘贴时为空 */
  title: string
  /** 归一化成 YYYY-MM-DD HH:MM:SS；没有就是 null */
  publishedAt: string | null
  /** 公众号名；表里没这一列、也认不出来时为空 */
  account: string
}

interface Columns {
  url: number
  title: number
  time: number
  account: number
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
export function splitCsvLine(line: string): string[] {
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
    else if (ch === ',' || ch === '\t') {
      out.push(cell)
      cell = ''
    } else cell += ch
  }
  out.push(cell)
  return out.map((x) => x.trim())
}

function pad(v: string): string {
  return v.padStart(2, '0')
}

/** Excel 把日期存成 1899-12-30 起的天数；表里出现 45000 这种数就是它 */
function fromExcelSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null
  const ms = Math.round((n - 25569) * 86400 * 1000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${pad(String(d.getUTCMonth() + 1))}-${pad(String(d.getUTCDate()))} ${pad(String(d.getUTCHours()))}:${pad(String(d.getUTCMinutes()))}:${pad(String(d.getUTCSeconds()))}`
}

export function normalizeTime(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d+(\.\d+)?$/.test(v)) return fromExcelSerial(Number(v))
  const m = v.match(TIME)
  if (!m) return null
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

/** 表格的表头行：没有链接，但三四个格子都在说「标题/链接/时间/公众号」 */
function detectHeader(line: string): Columns | null {
  if (line.includes('mp.weixin.qq.com')) return null
  const cells = splitCsvLine(line)
  if (cells.length < 2) return null
  const cols: Columns = { url: -1, title: -1, time: -1, account: -1 }
  cells.forEach((raw, i) => {
    const c = raw.toLowerCase().replace(/\s+/g, '')
    if (!c) return
    // 先认公众号：中文表头常写「公众号名称」，也带「名称」两个字
    if (cols.account < 0 && /(公众号|账号|帐号|作者|昵称|来源|author|nickname|account)/.test(c)) {
      cols.account = i
      return
    }
    if (cols.url < 0 && /(链接|地址|网址|url|link|href)/.test(c)) {
      cols.url = i
      return
    }
    if (cols.title < 0 && /(标题|title)/.test(c)) {
      cols.title = i
      return
    }
    if (cols.time < 0 && /(时间|日期|发表|发布|time|date)/.test(c)) cols.time = i
  })
  // 至少得认出两个位置列，否则这就是一行普通文字，不是表头
  const hits = [cols.url, cols.title, cols.time, cols.account].filter((i) => i >= 0).length
  return hits >= 2 ? cols : null
}

interface TableRecord {
  cells: string[]
  urls: string[]
}

/**
 * 没表头时认公众号名：同一列在多行里反复出现同一个短文本。
 * 表头丢了也不会把「上海交通大学学生会」当成每篇文章的标题。
 */
function repeatedColumn(records: TableRecord[]): number {
  const width = Math.max(0, ...records.map((r) => r.cells.length))
  if (width < 3 || records.length < 3) return -1
  for (let col = 0; col < width; col += 1) {
    const values = records
      .map((r) => (r.cells[col] ?? '').trim())
      .filter((v) => v && v.length <= 30 && !v.includes('mp.weixin.qq.com') && !normalizeTime(v))
    if (values.length < 3) continue
    if (new Set(values).size === 1 && ACCOUNT_HINT.test(values[0])) return col
  }
  return -1
}

function firstTime(cells: string[]): string | null {
  for (const cell of cells) {
    const t = normalizeTime(cell)
    if (t) return t
  }
  return null
}

function isAccountLike(cell: string): boolean {
  const v = cell.trim()
  return v.length >= 2 && v.length <= 30 && ACCOUNT_HINT.test(v) && !/^\d+$/.test(v)
}

/**
 * 解析整段文本。返回的顺序与原文一致，去重交给调用方（按 __biz+mid+idx）。
 */
export function parseLinkRows(text: string): ParsedLink[] {
  if (!text) return []

  // Excel 另存的 CSV 常带 BOM，不去掉的话第一列会多一个不可见字符
  const src = text.replace(/^\uFEFF/, '')

  let columns: Columns | null = null
  const records: TableRecord[] = []

  for (const line of src.split(/\r?\n/)) {
    if (!line.trim()) continue

    // 表头只认一次，认到之后按列取值，后面的行不再猜
    if (!columns) {
      const header = detectHeader(line)
      if (header) {
        columns = header
        continue
      }
    }

    const hits = [...line.matchAll(ARTICLE_URL)]
    if (hits.length === 0) continue

    const cells = /[,\t]/.test(line) ? splitCsvLine(line) : []
    records.push({ cells, urls: hits.map((h) => cleanUrl(h[0])) })
  }

  const accountCol = columns && columns.account >= 0 ? columns.account : repeatedColumn(records)

  const out: ParsedLink[] = []
  for (const rec of records) {
    const { cells } = rec
    const isTable = cells.length >= 3 && cells.some((c) => c.includes('mp.weixin.qq.com'))

    let title = ''
    let publishedAt: string | null = null
    let account = ''

    if (isTable && columns) {
      if (columns.title >= 0) title = cells[columns.title] ?? ''
      if (columns.account >= 0) account = cells[columns.account] ?? ''
      const at = columns.time >= 0 ? normalizeTime(cells[columns.time] ?? '') : null
      publishedAt = at ?? firstTime(cells)
    } else if (isTable) {
      // 没有表头：先认出「像公众号名」的那一格，再在剩下的格里挑最长的当标题。
      // 顺序不能反——「上工程团委」比「迎新晚会」长，先挑标题就会把号名当标题。
      const accountAt = accountCol >= 0 ? accountCol : cells.findIndex(isAccountLike)
      if (accountAt >= 0) account = cells[accountAt] ?? ''
      const candidates = cells.filter(
        (c, i) => i !== accountAt && looksLikeTitle(c) && !normalizeTime(c)
      )
      title = candidates.sort((a, b) => b.length - a.length)[0] ?? ''
      publishedAt = firstTime(cells)
    } else {
      // 一行里只有一个链接（或者不是表格），退回逐格判断
      publishedAt = firstTime(cells)
    }

    rec.urls.forEach((url, index) => {
      if (url.length < 30) return
      out.push({
        url,
        // 一行多个链接时，标题只给第一个，避免同一段标题被复制到每一条上
        title: index === 0 ? title.trim() : '',
        publishedAt: index === 0 ? publishedAt : null,
        account: index === 0 ? account.trim() : ''
      })
    })
  }

  return out
}
