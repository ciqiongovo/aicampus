/**
 * 把「一段链接 / 一份表格」入队。
 *
 * 从 service 里拆出来，是为了能脱离 Electron 直接测：
 * service 会 import fetcher，而 fetcher 依赖 BrowserWindow，在纯 node 里起不来。
 * 这段逻辑本身只碰数据库，单独放一处，测试和界面才能对着同一份实现跑。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { BenchImportResult } from '../../../shared/benchmark'
import { articleUrlKey, guessSchool } from '../../../shared/benchmark'
import * as dao from '../../db/dao/benchmarkDao'
import { parseLinkRows } from './link-import'

/**
 * @param raw    粘贴的文本，或整份 CSV / xlsx 转出来的文字
 * @param school 用户在这批导入里选的学校；空串表示没选，交给公众号名去猜
 */
export function importLinkText(db: DatabaseSync, raw: string, school = ''): BenchImportResult {
  const rows = parseLinkRows(raw)
  const chosen = school.trim()
  let accepted = 0
  let duplicated = 0
  let invalid = 0
  const seen = new Set<string>()
  const accounts = new Set<string>()

  for (const row of rows) {
    const key = articleUrlKey(row.url)
    if (!key) {
      invalid += 1
      continue
    }
    // 同一批里重复粘贴的，算重复而不是新入队
    if (seen.has(key)) {
      duplicated += 1
      continue
    }
    seen.add(key)

    // 表里写了公众号名就先建源：列表里「公众号」一列立刻有名字，
    // 学校卡片也能马上把篇数算进去，不用等采完正文
    const sourceId = row.account
      ? dao.ensureSourceForImport(db, row.account, chosen)
      : null
    if (sourceId) accounts.add(row.account)

    const ok = dao.enqueueArticle(db, {
      urlKey: key,
      url: row.url,
      sourceId,
      // 归属：用户选的 > 名字里的校名 > 留空
      hintSchool: chosen || (row.account ? guessSchool(row.account) : ''),
      title: row.title,
      publishedAt: row.publishedAt
    })
    if (ok) accepted += 1
    else duplicated += 1
  }

  return { accepted, duplicated, invalid, accounts: accounts.size }
}
