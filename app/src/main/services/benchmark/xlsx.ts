/**
 * 读 .xlsx 的最小子集，够把「导出的文章表格」变成一行行文字就行。
 *
 * 为什么不用现成的库：整个安装包里只有 imap / mailparser 两个原生依赖，
 * 为了读一张三列的表再拖一个 xlsx 进来，打包体积和供应链都不划算。
 * xlsx 本质是个 zip，里面两三个 XML——自己拆一遍，一百来行，够用且可控。
 *
 * 只做三件事：解开 zip、读 sharedStrings、按行读第一张表。
 * 公式、样式、合并单元格一概不管——我们要的只是「标题 / 链接 / 时间」这些文本。
 */

import { inflateRawSync } from 'node:zlib'

/** 从 zip 里取出所有文件。只认本地文件头 + 中央目录，够读 xlsx */
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  // 末尾的 EOCD 记录可能带注释，所以从后往前找签名
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localAt = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (localAt + 30 <= buf.length && buf.readUInt32LE(localAt) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localAt + 26)
      const lExtraLen = buf.readUInt16LE(localAt + 28)
      const start = localAt + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(start, start + compSize)
      try {
        files.set(name, method === 0 ? raw : inflateRawSync(raw))
      } catch {
        // 单个文件坏掉不影响别的；读不到就当它不存在
      }
    }
    p += 46 + nameLen + extraLen + commentLen
  }

  return files
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 一行 XML 里所有 <t> 的文本拼起来（富文本会被拆成多段 run） */
function textOf(xml: string): string {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out += decodeXml(m[1])
  return out
}

function sharedStrings(xml: string): string[] {
  const out: string[] = []
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(textOf(m[1]))
  return out
}

/** "BC12" → 54（0 起） */
function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

function rowsOf(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = []
    const cellRe = /<c([^>]*?)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] ?? cm[2] ?? ''
      const inner = cm[3] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = textOf(inner)
      else if (type === 'str') value = decodeXml(v)
      else value = v ? decodeXml(v) : ''
      const at = ref ? columnIndex(ref) : cells.length
      while (cells.length < at) cells.push('')
      cells[at] = value.trim()
    }
    if (cells.some((c) => c)) rows.push(cells)
  }
  return rows
}

function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(',')
    )
    .join('\n')
}

/**
 * xlsx 二进制 → CSV 文本。
 *
 * 交给 parseLinkRows 之前先变成表，是为了只维护一套「认列」的规则：
 * 不管文件是 csv 还是 xlsx，后面走的是同一条路。
 */
export function xlsxToCsv(buf: Buffer): string {
  const files = unzip(buf)
  const shared = files.has('xl/sharedStrings.xml')
    ? sharedStrings(files.get('xl/sharedStrings.xml')!.toString('utf8'))
    : []
  const sheetName =
    [...files.keys()].find((n) => n === 'xl/worksheets/sheet1.xml') ??
    [...files.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n))
  if (!sheetName) throw new Error('这个 xlsx 里没有工作表')
  const xml = files.get(sheetName)!.toString('utf8')
  const rows = rowsOf(xml, shared)
  if (rows.length === 0) throw new Error('表格是空的')
  return toCsv(rows)
}
