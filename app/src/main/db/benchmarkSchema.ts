/**
 * 跨校对标库的数据库结构（迁移 v30）。
 *
 * 设计要点：
 * - 三张表分开：源、文章、抽取结果。文章正文和抽取字段不放在一张表里，
 *   因为重抽（换模型、改提示词）只需要动 bench_activity，不必碰正文。
 * - bench_article.url_key 唯一，但 url 不唯一。同一篇会被不同渠道转成不同 URL，
 *   只有 __biz+mid+idx 稳定，所以去重键由 articleUrlKey() 生成。
 * - 删除状态是常态（公众号文章被作者删掉的很多），单独记 status='deleted'，
 *   统计成功率时从分母里剔除，不和网络故障混算。
 * - 不建 FTS：与 im 模块同样的理由，FTS5 在部分打包 SQLite 里不可用，
 *   运行时由 DAO 尝试建、失败降级 LIKE。
 */

export interface BenchMigration {
  version: number
  name: string
  up: string[]
}

export const benchmarkMigrations: BenchMigration[] = [
  {
    version: 30,
    name: 'benchmark-sources',
    up: [
      `CREATE TABLE IF NOT EXISTS bench_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gh_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        school TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'student_union',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (name, school)
      )`,
      `CREATE TABLE IF NOT EXISTS bench_article (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER REFERENCES bench_source(id) ON DELETE SET NULL,
        url_key TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        is_activity INTEGER,
        fetched_at TEXT,
        body TEXT,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS bench_activity (
        article_id INTEGER PRIMARY KEY REFERENCES bench_article(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT '',
        organizer TEXT NOT NULL DEFAULT '',
        start_at TEXT,
        end_at TEXT,
        week_no INTEGER,
        location TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL DEFAULT '',
        org_form TEXT NOT NULL DEFAULT '',
        join_method TEXT NOT NULL DEFAULT '',
        promo_channels TEXT NOT NULL DEFAULT '[]',
        agenda TEXT NOT NULL DEFAULT '[]',
        is_second_notice INTEGER NOT NULL DEFAULT 0,
        notice_kind TEXT NOT NULL DEFAULT '',
        migration_fit TEXT NOT NULL DEFAULT '',
        migration_note TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        extracted_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_bench_article_status ON bench_article(status)',
      'CREATE INDEX IF NOT EXISTS idx_bench_article_source ON bench_article(source_id, published_at)',
      'CREATE INDEX IF NOT EXISTS idx_bench_article_published ON bench_article(published_at)',
      'CREATE INDEX IF NOT EXISTS idx_bench_activity_kind ON bench_activity(kind, start_at)'
    ]
  },
  {
    /**
     * v31：选学校 + 找公众号 + 字段加细。
     *
     * 前三张表解决的是「有链接之后怎么办」，这一版补的是「链接从哪儿来」。
     * 学校不再是文章上的一个字符串，而是一张可勾选的清单——勾了就按这所学校
     * 的命名习惯去找它的学生会、研究生会、团委号。
     *
     * bench_prospect 存的是「打算去找的账号」，和 bench_source（已经确认存在的号）
     * 分开：凭名字猜出来的号十有八九不存在，把它当源会让源列表变得又长又假。
     */
    version: 31,
    name: 'benchmark-schools',
    up: [
      `CREATE TABLE IF NOT EXISTS bench_school (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        short_name TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL DEFAULT '[]',
        is_home INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS bench_prospect (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school TEXT NOT NULL,
        account_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'student_union',
        status TEXT NOT NULL DEFAULT 'untried',
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_tried_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        UNIQUE (school, account_name)
      )`,
      // 新字段一律 NOT NULL DEFAULT，老行不用回填，读出来就是空串
      "ALTER TABLE bench_activity ADD COLUMN co_organizer TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE bench_activity ADD COLUMN duration TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE bench_activity ADD COLUMN scale TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE bench_activity ADD COLUMN highlights TEXT NOT NULL DEFAULT '[]'",
      // 按学校发现时，这一条是从哪所学校搜出来的。
      // 抓取前公众号名还不知道，没有这列的话，刚入队的文章在列表里学校一栏全空，
      // 用户看不出这次「采集」到底采到谁的。抓完若识别出真学校，以识别结果为准。
      "ALTER TABLE bench_article ADD COLUMN hint_school TEXT NOT NULL DEFAULT ''",
      'CREATE INDEX IF NOT EXISTS idx_bench_prospect_school ON bench_prospect(school, status)',
      'CREATE INDEX IF NOT EXISTS idx_bench_school_home ON bench_school(is_home, enabled)'
    ]
  },
  {
    /**
     * v32：已经查实的公众号名。
     *
     * 命名套路是猜的，「上科大学工部团委」「书院的天空」这种写法按套路根本推不出来。
     * 一旦确认过某个号真的存在，就存下来，下次直接用，不再拿配额去搜。
     * 这不是「预置名单」，是「查证结果的缓存」——用户自己加的号也走这条。
     */
    version: 32,
    name: 'benchmark-known-accounts',
    up: ["ALTER TABLE bench_school ADD COLUMN known_accounts TEXT NOT NULL DEFAULT '[]'"]
  }
]
