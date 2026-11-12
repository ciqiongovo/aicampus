import type { Migration } from './migrations'

/**
 * 日报结构化（v10）：日报汇总 + 独立资讯实体 + 多对多关联。
 * 由主代理追加到 migrations.ts 的 MIGRATIONS 数组末尾（这里只导出，不做循环值依赖）。
 *
 * 表与主键：
 * - daily_report：日报汇总，PK id，date_key 唯一，info_id 关联旧 info 汇总行（source_type='daily'）。
 * - daily_article：独立资讯实体，PK id，dedup_key 唯一（source_id + 归一化标题），跨日去重。
 * - daily_report_article：日报-资讯关联，复合主键 (report_id, article_id)。
 *
 * 去重：同源同标题只保留一条 article（dedup_key），force 刷新只更新内容类字段，
 * 不触碰 status/user_acted/item_id，从而保留用户处理状态与原文链接。
 * 旧日报不回填成虚假结构化明细，仅登记 daily_report 行（info_id 关联、0 条 article），原文仍可读。
 */
export const dailyMigrations: Migration[] = [
  {
    version: 10,
    name: 'daily-report-articles',
    up: [
      "CREATE TABLE daily_report (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "date_key TEXT NOT NULL UNIQUE," +
        "title TEXT NOT NULL DEFAULT ''," +
        "intro TEXT NOT NULL DEFAULT ''," +
        "status TEXT NOT NULL DEFAULT 'complete'," +
        "sources_json TEXT NOT NULL DEFAULT '[]'," +
        "info_id INTEGER," +
        "generated_at TEXT," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ")",
      "CREATE TABLE daily_article (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "dedup_key TEXT NOT NULL UNIQUE," +
        "title TEXT NOT NULL DEFAULT ''," +
        "content TEXT NOT NULL DEFAULT ''," +
        "url TEXT," +
        "source_id TEXT NOT NULL DEFAULT ''," +
        "source_label TEXT NOT NULL DEFAULT ''," +
        "score REAL," +
        "topic TEXT," +
        "topic_matches_json TEXT NOT NULL DEFAULT '[]'," +
        "category TEXT NOT NULL DEFAULT '一般信息'," +
        "status TEXT NOT NULL DEFAULT 'keep'," +
        "user_acted INTEGER NOT NULL DEFAULT 0," +
        "item_id INTEGER REFERENCES items(id) ON DELETE SET NULL," +
        "published_at TEXT," +
        "first_seen_at TEXT," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ")",
      "CREATE TABLE daily_report_article (" +
        "report_id INTEGER NOT NULL REFERENCES daily_report(id) ON DELETE CASCADE," +
        "article_id INTEGER NOT NULL REFERENCES daily_article(id) ON DELETE CASCADE," +
        "PRIMARY KEY (report_id, article_id)" +
      ")",
      "CREATE INDEX idx_daily_report_info ON daily_report(info_id)",
      "CREATE INDEX idx_daily_article_topic ON daily_article(topic)",
      "CREATE INDEX idx_daily_article_status ON daily_article(status)",
      "CREATE INDEX idx_daily_article_source ON daily_article(source_id)",
      // 旧日报登记：按标题前 10 位（YYYY-MM-DD）提取日期键，仅登记汇总行、不伪造明细。
      "INSERT OR IGNORE INTO daily_report (date_key, title, intro, status, sources_json, info_id, generated_at)" +
        " SELECT substr(title, 1, 10), title, '', 'complete', '[]', id, created_at" +
        " FROM info WHERE source_type = 'daily'" +
        " AND title GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'"
    ]
  }
]
