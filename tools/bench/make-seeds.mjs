/**
 * 生成随安装包发布的内置样本链接表。
 *
 * 只挑「抓过并且真的拿到了正文」的链接：没验过的链接放进安装包，
 * 用户第一次点「导入内置样本」看到一串「原文已删」，比什么都不带给人的印象更差。
 *
 * 用法：node tools/bench/make-seeds.mjs
 * 输出：app/resources/bench-seeds.json
 */

import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
/**
 * 上海高校名单。
 *
 * 这里抄了一份而不是 import：脚本要能直接用 node 跑，而 app 里那份是 .ts，
 * 直接 import 要靠 Node 的类型擦除，版本不对就报错。名单本身很稳，抄一份不碍事。
 */
const SHANGHAI_SCHOOLS = [
  '复旦大学', '上海交通大学', '同济大学', '华东师范大学', '华东理工大学', '上海大学',
  '东华大学', '上海外国语大学', '上海财经大学', '上海理工大学', '上海师范大学', '上海海事大学',
  '上海中医药大学', '上海对外经贸大学', '上海工程技术大学', '上海应用技术大学', '上海电力大学',
  '上海立信会计金融学院', '上海政法学院', '上海体育大学', '上海科技大学', '上海音乐学院',
  '上海戏剧学院', '上海第二工业大学', '上海电机学院', '上海商学院', '上海健康医学院', '上海海关学院'
]

const DB = join(process.env.APPDATA ?? '.', 'InfoAgent', 'infoagent.db')
const OUT = 'app/resources/bench-seeds.json'
/** 每所学校最多给几条。够看出「这所学校一年在办什么」就够，多了只是拖慢首次导入 */
const PER_SCHOOL = 6

const harvestPath = 'output/bench/links-harvest.json'
const harvested = existsSync(harvestPath)
  ? JSON.parse(readFileSync(harvestPath, 'utf8')).items ?? []
  : []

let verified = []
if (existsSync(DB)) {
  const db = new DatabaseSync(DB, { readOnly: true })
  verified = db
    .prepare(
      `SELECT a.id, a.url, a.title, COALESCE(s.school, '') AS school, COALESCE(act.kind, '') AS kind
         FROM bench_article a
         LEFT JOIN bench_source s ON s.id = a.source_id
         LEFT JOIN bench_activity act ON act.article_id = a.id
        WHERE a.status = 'parsed' AND COALESCE(act.kind, '') <> '' AND COALESCE(s.school, '') <> ''
        ORDER BY s.school, a.published_at DESC`
    )
    .all()
  db.close()
}

/**
 * 只带上海高校。搜索跑偏时会带回外省市的号（北京理工、青岛科技……），
 * 它们留在库里能看，但塞进安装包的样本就没道理了——
 * 这个库对标的是上海兄弟高校，第一眼看到一堆外地学校只会让人怀疑数据是怎么来的。
 */
const inScope = new Set(SHANGHAI_SCHOOLS)

/** 已经验过的优先；不够再拿收割来的补，但标上「未验证」，界面上能看出区别 */
const bySchool = new Map()
const push = (school, item, verifiedFlag) => {
  if (!school || !item.url) return
  if (!inScope.has(school)) return
  const list = bySchool.get(school) ?? []
  if (list.length >= PER_SCHOOL) return
  if (list.some((x) => x.url === item.url)) return
  list.push({ school, url: item.url, activity: item.kind || item.activity || '', verified: verifiedFlag })
  bySchool.set(school, list)
}

for (const row of verified) push(row.school, { url: row.url, kind: row.kind }, true)
for (const row of harvested) push(row.school, { url: row.url, activity: row.activity }, false)

const seeds = [...bySchool.values()].flat()
mkdirSync('app/resources', { recursive: true })
writeFileSync(OUT, JSON.stringify(seeds, null, 1))

const summary = [...bySchool.entries()].map(([s, list]) => `${s} ${list.length}`).join(' · ')
console.log(`写入 ${seeds.length} 条 → ${OUT}`)
console.log(summary)
