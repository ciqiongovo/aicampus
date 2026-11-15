/**
 * 随安装包带的一批样本链接。
 *
 * 新装一份软件，库里是空的。要看到东西，得先有链接，而找链接要走搜索引擎，
 * 有配额、会撞验证码。第一次打开就面对一个空表格，多数人不会坚持到看见数据。
 *
 * 所以带一批已经验证过能打开的公众号推文。它不解决「以后怎么办」，
 * 只解决「第一次打开有没有东西可看」。用户可以一键导入，也可以完全不用。
 *
 * 文件放 resources 而不是打进 asar：链接要能单独更新，坏链可以直接换文件，
 * 不必为几条链接重新发一个版本。
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SeedLink {
  school: string
  url: string
  /** 大盘参照用：这篇大概是哪类活动，只用于界面提示，抽取时会重新判 */
  activity: string
}

let cache: SeedLink[] | null = null

function seedPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources/bench-seeds.json')
    : join(app.getAppPath(), 'resources/bench-seeds.json')
}

export function readSeeds(): SeedLink[] {
  if (cache) return cache
  const path = seedPath()
  if (!existsSync(path)) {
    cache = []
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) {
      cache = []
      return cache
    }
    cache = parsed
      .map((x) => x as Partial<SeedLink>)
      .filter((x): x is SeedLink => typeof x?.url === 'string' && typeof x?.school === 'string')
      .map((x) => ({ school: x.school, url: x.url, activity: x.activity ?? '' }))
    return cache
  } catch {
    // 种子坏了不该影响启动：没有样本只是少一个便利，不是故障
    cache = []
    return cache
  }
}
