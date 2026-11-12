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
  }
]
