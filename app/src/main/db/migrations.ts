import type { DatabaseSync } from 'node:sqlite'
import { workspaceMigrations } from './workspaceSchema'
import { dailyMigrations } from './dailySchema'
import { cognitionMigrations } from './cognitionSchema'
import { agentMigrations } from './agentSchema'
import { imMigrations } from './imSchema'

export interface Migration {
  version: number
  name: string
  up: string[]
}

/** 全部迁移按版本顺序排列；只允许追加，不允许修改已发布迁移；up 每个元素是一条完整 SQL */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-tables',
    up: [
      "CREATE TABLE accounts (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "provider TEXT NOT NULL," +
        "label TEXT NOT NULL DEFAULT ''," +
        "address TEXT NOT NULL," +
        "host TEXT NOT NULL DEFAULT ''," +
        "port INTEGER," +
        "encryption TEXT NOT NULL DEFAULT 'ssl'," +
        "username TEXT NOT NULL DEFAULT ''," +
        "secret_enc TEXT NOT NULL DEFAULT ''," +
        "folder TEXT NOT NULL DEFAULT 'INBOX'," +
        "auth_mode TEXT NOT NULL DEFAULT 'appPassword'," +
        "last_uidvalidity INTEGER," +
        "last_uid INTEGER," +
        "last_sync_at TEXT," +
        "sync_error TEXT," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ")",
      "CREATE TABLE emails (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE," +
        "folder TEXT NOT NULL DEFAULT 'INBOX'," +
        "uid INTEGER NOT NULL," +
        "message_id TEXT NOT NULL DEFAULT ''," +
        "subject TEXT NOT NULL DEFAULT ''," +
        "from_addr TEXT NOT NULL DEFAULT ''," +
        "to_addr TEXT NOT NULL DEFAULT ''," +
        "cc TEXT NOT NULL DEFAULT ''," +
        "date_utc TEXT," +
        "date_raw TEXT," +
        "unread INTEGER NOT NULL DEFAULT 0," +
        "body_text TEXT NOT NULL DEFAULT ''," +
        "body_html TEXT NOT NULL DEFAULT ''," +
        "attachments_json TEXT NOT NULL DEFAULT '[]'," +
        "size INTEGER NOT NULL DEFAULT 0," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "UNIQUE (account_id, folder, uid)" +
      ")",
      "CREATE TABLE email_analysis (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "email_id INTEGER NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE," +
        "status TEXT NOT NULL DEFAULT 'pending'," +
        "category TEXT," +
        "summary TEXT," +
        "action_required TEXT," +
        "deadline_raw TEXT," +
        "deadline_at TEXT," +
        "deadline_kind TEXT," +
        "event_start_at TEXT," +
        "applicable_to TEXT," +
        "confidence REAL," +
        "evidence_json TEXT NOT NULL DEFAULT '[]'," +
        "model TEXT," +
        "provider TEXT," +
        "error TEXT," +
        "analyzed_at TEXT" +
      ")",
      "CREATE TABLE items (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "title TEXT NOT NULL," +
        "source_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL," +
        "category TEXT," +
        "status TEXT NOT NULL DEFAULT '待核实'," +
        "deadline_at TEXT," +
        "suggest_start_at TEXT," +
        "notes TEXT NOT NULL DEFAULT ''," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ")",
      "CREATE TABLE reminders (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE," +
        "remind_at TEXT NOT NULL," +
        "channel TEXT NOT NULL DEFAULT 'app'," +
        "status TEXT NOT NULL DEFAULT 'pending'," +
        "fired_at TEXT," +
        "error TEXT" +
      ")",
      "CREATE TABLE settings (" +
        "key TEXT PRIMARY KEY," +
        "value TEXT NOT NULL" +
      ")",
      "CREATE INDEX idx_emails_account_uid ON emails(account_id, folder, uid)",
      "CREATE INDEX idx_emails_date ON emails(date_utc)",
      "CREATE INDEX idx_analysis_status ON email_analysis(status)",
      "CREATE INDEX idx_items_status ON items(status)",
      "CREATE INDEX idx_items_deadline ON items(deadline_at)",
      "CREATE INDEX idx_reminders_due ON reminders(remind_at, status)"
    ]
  },
  {
    version: 2,
    name: 'starred-and-fts',
    up: [
      "ALTER TABLE emails ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
      "CREATE VIRTUAL TABLE emails_fts USING fts5(subject, from_addr, to_addr, body_text, content='emails', content_rowid='id', tokenize='trigram')",
      "CREATE TRIGGER emails_ai AFTER INSERT ON emails BEGIN INSERT INTO emails_fts(rowid, subject, from_addr, to_addr, body_text) VALUES (new.id, new.subject, new.from_addr, new.to_addr, new.body_text); END",
      "CREATE TRIGGER emails_ad AFTER DELETE ON emails BEGIN INSERT INTO emails_fts(emails_fts, rowid, subject, from_addr, to_addr, body_text) VALUES ('delete', old.id, old.subject, old.from_addr, old.to_addr, old.body_text); END",
      "CREATE TRIGGER emails_au AFTER UPDATE ON emails BEGIN INSERT INTO emails_fts(emails_fts, rowid, subject, from_addr, to_addr, body_text) VALUES ('delete', old.id, old.subject, old.from_addr, old.to_addr, old.body_text); INSERT INTO emails_fts(rowid, subject, from_addr, to_addr, body_text) VALUES (new.id, new.subject, new.from_addr, new.to_addr, new.body_text); END",
      "INSERT INTO emails_fts(rowid, subject, from_addr, to_addr, body_text) SELECT id, subject, from_addr, to_addr, body_text FROM emails"
    ]
  },
  {
    // M7：面板与提醒骨架。v1 已建 items/reminders 表，这里只补列（SQLite 的 ADD COLUMN 不允许表达式默认值，created_at 先给空串再回填）
    version: 3,
    name: 'panel-items-v3',
    up: [
      "ALTER TABLE items ADD COLUMN deadline_raw TEXT",
      "ALTER TABLE items ADD COLUMN deadline_kind TEXT",
      "ALTER TABLE items ADD COLUMN event_start_at TEXT",
      "ALTER TABLE reminders ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
      "UPDATE reminders SET created_at = datetime('now','localtime') WHERE created_at = ''",
      "CREATE INDEX idx_reminders_item ON reminders(item_id)"
    ]
  },
  {
    // 每账号 AI 绑定：账号级开关与端点覆盖（覆盖项留空 = 跟随全局配置）
    version: 4,
    name: 'account-ai-binding',
    up: [
      "ALTER TABLE accounts ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE accounts ADD COLUMN ai_provider TEXT",
      "ALTER TABLE accounts ADD COLUMN ai_base_url TEXT",
      "ALTER TABLE accounts ADD COLUMN ai_model TEXT"
    ]
  },
  {
    // Outlook/Gmail OAuth 登录：refresh/access 令牌用 safeStorage 加密落库（enc: 前缀）
    version: 5,
    name: 'account-oauth',
    up: [
      "ALTER TABLE accounts ADD COLUMN oauth_provider TEXT",
      "ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT",
      "ALTER TABLE accounts ADD COLUMN oauth_refresh_enc TEXT",
      "ALTER TABLE accounts ADD COLUMN oauth_access_enc TEXT",
      "ALTER TABLE accounts ADD COLUMN oauth_expires_at INTEGER"
    ]
  },
  {
    // P1 信息流数据层：信息流条目（info）+ 带日期的画像记忆（profile_memory）。
    // 四去向 destination：unverified 待核实 / item 事项 / keep 资料 / archive 归档；
    // source_type 预留：email（邮件分析）/ jarvis（对话）/ daily（日报）/ user（手动）。
    // 回填：已分析邮件全部转信息流条目——有行动要求或分类为需行动/不确定 → 待核实，其余 → 资料。
    version: 6,
    name: 'info-flow',
    up: [
      "CREATE TABLE info (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "source_type TEXT NOT NULL DEFAULT 'email'," +
        "source_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL," +
        "title TEXT NOT NULL DEFAULT ''," +
        "content TEXT NOT NULL DEFAULT ''," +
        "category TEXT," +
        "destination TEXT NOT NULL DEFAULT 'unverified'," +
        "item_id INTEGER REFERENCES items(id) ON DELETE SET NULL," +
        "status TEXT NOT NULL DEFAULT 'unverified'," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "routed_at TEXT," +
        "UNIQUE (source_type, source_email_id)" +
      ")",
      "CREATE TABLE profile_memory (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "content TEXT NOT NULL," +
        "source TEXT NOT NULL DEFAULT ''," +
        "kind TEXT NOT NULL DEFAULT 'explicit'," +
        "recorded_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "last_confirmed_at TEXT," +
        "archived INTEGER NOT NULL DEFAULT 0" +
      ")",
      "CREATE INDEX idx_info_destination ON info(destination, created_at)",
      "CREATE INDEX idx_info_category ON info(category)",
      "INSERT INTO info (source_type, source_email_id, title, content, category, destination, status, created_at)" +
        " SELECT 'email', an.email_id, e.subject, COALESCE(an.summary, ''), an.category," +
        " CASE WHEN (an.action_required IS NOT NULL AND an.action_required != '') OR an.category IN ('需行动', '不确定')" +
        "   THEN 'unverified' ELSE 'keep' END, 'unverified', COALESCE(an.analyzed_at, e.created_at, datetime('now'))" +
        " FROM email_analysis an JOIN emails e ON e.id = an.email_id WHERE an.status = 'analyzed'"
    ]
  },
  {
    // P2 半自动分级：AI 输出 tier（'archive'=高置信低风险自动归档，'review'=其余待核实）。
    // 旧行 tier 为 NULL，同步信息流时回退旧规则（action_required/需行动/不确定 → 待核实）。
    version: 7,
    name: 'analysis-tier',
    up: [
      "ALTER TABLE email_analysis ADD COLUMN tier TEXT"
    ]
  },
  {
    // P5 反推荐：每日 ≤1 条（date_key 唯一）、与画像距离最大且来源可信、JARVIS 提问、「去」转事项。
    // status：pending 待处理 / done 已转事项 / ignored 已忽略；item_id 记录「去」后创建的事项。
    version: 8,
    name: 'counter-rec',
    up: [
      "CREATE TABLE counter_rec (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "date_key TEXT NOT NULL UNIQUE," +
        "title TEXT NOT NULL," +
        "source_label TEXT NOT NULL DEFAULT ''," +
        "url TEXT," +
        "reason TEXT NOT NULL DEFAULT ''," +
        "status TEXT NOT NULL DEFAULT 'pending'," +
        "item_id INTEGER REFERENCES items(id) ON DELETE SET NULL," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "acted_at TEXT" +
      ")"
    ]
  },
  ...workspaceMigrations,
  ...dailyMigrations,
  ...cognitionMigrations,
  // 必须按版本递增追加在最后：migrate() 按数组顺序执行并跳过 version<=current 的项。
  ...agentMigrations,
  {
    version: 13,
    name: 'custom-mail-tags',
    up: [
      "CREATE TABLE mail_tag_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '')",
      "CREATE TABLE email_custom_tags (email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES mail_tag_definitions(id) ON DELETE CASCADE, PRIMARY KEY(email_id, tag_id))",
      "CREATE INDEX idx_email_custom_tags_tag ON email_custom_tags(tag_id, email_id)",
      "CREATE TABLE email_custom_tag_matches (email_id INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL)"
    ]
  },
  {
    // 日程与待办：items 继续作为唯一条目源（邮件产生 → 待办勾选 → 日程排期），这里只补清单与时间字段。
    // todo_lists 是用户自建分组（课表、学习安排…）；color 为空表示沿用前端调色板里的下一个颜色。
    version: 14,
    name: 'todo-schedule',
    up: [
      "CREATE TABLE IF NOT EXISTS todo_lists (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "name TEXT NOT NULL," +
        "color TEXT NOT NULL DEFAULT ''," +
        "sort_order INTEGER NOT NULL DEFAULT 0," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))" +
      ")",
      "ALTER TABLE items ADD COLUMN list_id INTEGER REFERENCES todo_lists(id) ON DELETE SET NULL",
      "ALTER TABLE items ADD COLUMN completed_at TEXT",
      "ALTER TABLE items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE items ADD COLUMN event_end_at TEXT",
      "ALTER TABLE items ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX idx_items_event_start ON items(event_start_at)",
      "CREATE INDEX idx_items_list ON items(list_id)",
      "CREATE INDEX idx_items_completed ON items(completed_at)"
    ]
  },
  {
    // v15 新面板：来源适配器目录 + 推荐批次/推荐 + 反馈事件 + 偏好权重。
    // 推荐和反馈必须可回查（为什么推、用户改选了什么），不能只是前端临时状态。
    version: 15,
    name: 'panel-recommendation-loop',
    up: [
      "CREATE TABLE IF NOT EXISTS inbox_source (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "key TEXT NOT NULL UNIQUE," +
        "label TEXT NOT NULL," +
        "kind TEXT NOT NULL," +
        "enabled INTEGER NOT NULL DEFAULT 1," +
        "config_json TEXT NOT NULL DEFAULT '{}'," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))" +
      ")",
      "CREATE TABLE IF NOT EXISTS recommendation_batch (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "mode TEXT NOT NULL DEFAULT 'initial'," +
        "window_days INTEGER," +
        "total INTEGER NOT NULL DEFAULT 0," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))" +
      ")",
      "CREATE TABLE IF NOT EXISTS recommendation (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "batch_id INTEGER NOT NULL REFERENCES recommendation_batch(id) ON DELETE CASCADE," +
        "info_id INTEGER NOT NULL UNIQUE REFERENCES info(id) ON DELETE CASCADE," +
        "source_key TEXT NOT NULL," +
        "title TEXT NOT NULL DEFAULT ''," +
        "summary TEXT NOT NULL DEFAULT ''," +
        "reason TEXT NOT NULL DEFAULT ''," +
        "recommended_action TEXT NOT NULL," +
        "confidence REAL NOT NULL DEFAULT 0.5," +
        "score REAL NOT NULL DEFAULT 0," +
        "category TEXT," +
        "action_required TEXT," +
        "deadline_at TEXT," +
        "event_start_at TEXT," +
        "suggested_at TEXT," +
        "status TEXT NOT NULL DEFAULT 'pending'," +
        "chosen_action TEXT," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "acted_at TEXT" +
      ")",
      "CREATE INDEX IF NOT EXISTS idx_recommendation_batch ON recommendation(batch_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_recommendation_source ON recommendation(source_key, status)",
      "CREATE TABLE IF NOT EXISTS feedback_event (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "recommendation_id INTEGER NOT NULL REFERENCES recommendation(id) ON DELETE CASCADE," +
        "info_id INTEGER NOT NULL," +
        "source_key TEXT NOT NULL DEFAULT ''," +
        "recommended_action TEXT NOT NULL," +
        "chosen_action TEXT NOT NULL," +
        "outcome TEXT NOT NULL," +
        "reason TEXT NOT NULL DEFAULT ''," +
        "category TEXT," +
        "sender_key TEXT NOT NULL DEFAULT ''," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))" +
      ")",
      "CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_event(created_at)",
      "CREATE TABLE IF NOT EXISTS preference_signal (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "dimension TEXT NOT NULL," +
        "key TEXT NOT NULL," +
        "weight REAL NOT NULL DEFAULT 0," +
        "confidence REAL NOT NULL DEFAULT 0," +
        "evidence_count INTEGER NOT NULL DEFAULT 0," +
        "last_reinforced_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "UNIQUE (dimension, key)" +
      ")",
      "CREATE INDEX IF NOT EXISTS idx_preference_weight ON preference_signal(dimension, weight DESC)",
      // 内置来源只是目录行；代码按 kind 找适配器，新增来源不必改 UI。
      "INSERT OR IGNORE INTO inbox_source (key, label, kind) VALUES ('email', '邮件', 'email')",
      "INSERT OR IGNORE INTO inbox_source (key, label, kind) VALUES ('manual', '手动收集', 'manual')",
      "INSERT OR IGNORE INTO inbox_source (key, label, kind) VALUES ('daily', '每日日报', 'daily')"
    ]
  },
  {
    // v16 资料栏：资料文件夹、独立于邮件的话题标签库；面板偏好只保留主题与来源。
    version: 16,
    name: 'material-library-topics',
    up: [
      'ALTER TABLE info ADD COLUMN material_folder TEXT',
      'ALTER TABLE recommendation ADD COLUMN topic TEXT',
      "CREATE TABLE IF NOT EXISTS material_tags (" +
        "info_id INTEGER PRIMARY KEY REFERENCES info(id) ON DELETE CASCADE," +
        "parent_labels TEXT NOT NULL DEFAULT '[]'," +
        "sub_labels TEXT NOT NULL DEFAULT '[]'," +
        "source TEXT NOT NULL DEFAULT 'auto'," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))" +
      ")",
      'CREATE INDEX IF NOT EXISTS idx_material_tags_updated ON material_tags(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_info_material_folder ON info(material_folder)',
      // 旧的动作/发件人/分析分类权重会污染新主题画像，直接清掉；主题从头积累。
      "DELETE FROM preference_signal WHERE dimension IN ('action','category','sender')"
    ]
  },
  {
    version: 17,
    name: 'panel-priority-content-dedupe',
    up: [
      'ALTER TABLE recommendation ADD COLUMN priority TEXT',
      'ALTER TABLE recommendation_batch ADD COLUMN ai_configured INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE recommendation_batch ADD COLUMN ai_message TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE info ADD COLUMN panel_content_key TEXT',
      'ALTER TABLE info ADD COLUMN panel_duplicate_of INTEGER REFERENCES info(id) ON DELETE SET NULL',
      'CREATE INDEX idx_info_panel_content_key ON info(panel_content_key)',
      'CREATE INDEX idx_info_panel_duplicate ON info(panel_duplicate_of)',
      'CREATE INDEX idx_recommendation_pending ON recommendation(status, info_id DESC)',
      'CREATE TRIGGER emails_panel_content_au AFTER UPDATE OF subject, body_text, body_html, attachments_json ON emails' +
        ' WHEN NEW.subject IS NOT OLD.subject OR NEW.body_text IS NOT OLD.body_text OR NEW.body_html IS NOT OLD.body_html OR NEW.attachments_json IS NOT OLD.attachments_json' +
        ' BEGIN UPDATE info SET panel_content_key = NULL WHERE source_email_id = NEW.id; END'
    ]
  },
  {
    version: 18,
    name: 'panel-incremental-content-dedupe',
    up: [
      // Persistent work survives reconnects, external SQL writers and transaction rollback.
      'CREATE TABLE panel_dirty_content (content_key TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID',
      'CREATE INDEX idx_info_panel_missing_key ON info(id) WHERE panel_content_key IS NULL',
      'CREATE INDEX idx_info_source_email ON info(source_email_id)',
      'INSERT INTO panel_dirty_content SELECT DISTINCT panel_content_key FROM info WHERE panel_content_key IS NOT NULL',
      'CREATE TRIGGER info_panel_ai AFTER INSERT ON info WHEN NEW.panel_content_key IS NOT NULL' +
        ' BEGIN INSERT OR IGNORE INTO panel_dirty_content VALUES (NEW.panel_content_key); END',
      'CREATE TRIGGER info_panel_ad AFTER DELETE ON info WHEN OLD.panel_content_key IS NOT NULL' +
        ' BEGIN INSERT OR IGNORE INTO panel_dirty_content VALUES (OLD.panel_content_key); END',
      'CREATE TRIGGER info_panel_key_au AFTER UPDATE OF panel_content_key ON info' +
        ' WHEN NEW.panel_content_key IS NOT OLD.panel_content_key BEGIN' +
        ' INSERT OR IGNORE INTO panel_dirty_content SELECT OLD.panel_content_key WHERE OLD.panel_content_key IS NOT NULL;' +
        ' INSERT OR IGNORE INTO panel_dirty_content SELECT NEW.panel_content_key WHERE NEW.panel_content_key IS NOT NULL; END',
      'CREATE TRIGGER info_panel_route_au AFTER UPDATE OF destination ON info' +
        ' WHEN NEW.destination IS NOT OLD.destination AND NEW.panel_content_key IS NOT NULL' +
        ' BEGIN INSERT OR IGNORE INTO panel_dirty_content VALUES (NEW.panel_content_key); END',
      // Covers rebinding/deleting source emails as well as direct adapter content updates.
      'CREATE TRIGGER info_panel_content_au AFTER UPDATE OF source_email_id, title, content ON info' +
        ' WHEN NEW.source_email_id IS NOT OLD.source_email_id OR NEW.title IS NOT OLD.title OR NEW.content IS NOT OLD.content' +
        ' BEGIN UPDATE info SET panel_content_key = NULL WHERE id = NEW.id; END',
      'CREATE TRIGGER recommendation_panel_ai AFTER INSERT ON recommendation BEGIN' +
        ' INSERT OR IGNORE INTO panel_dirty_content SELECT panel_content_key FROM info WHERE id = NEW.info_id AND panel_content_key IS NOT NULL; END',
      'CREATE TRIGGER recommendation_panel_ad AFTER DELETE ON recommendation BEGIN' +
        ' INSERT OR IGNORE INTO panel_dirty_content SELECT panel_content_key FROM info WHERE id = OLD.info_id AND panel_content_key IS NOT NULL; END',
      'CREATE TRIGGER recommendation_panel_au AFTER UPDATE OF info_id ON recommendation WHEN NEW.info_id IS NOT OLD.info_id BEGIN' +
        ' INSERT OR IGNORE INTO panel_dirty_content SELECT panel_content_key FROM info WHERE id IN (OLD.info_id, NEW.info_id) AND panel_content_key IS NOT NULL; END'
    ]
  },
  {
    // v19 非邮件来源的偏好与“关心雷达”彻底分开：不再借用八类主题权重，
    // 按来源各记一份（来源整体取舍 + 标题关键词），只在推荐排序内部使用，不展示给用户。
    version: 19,
    name: 'source-preferences',
    up: [
      "CREATE TABLE IF NOT EXISTS source_preference (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "source_key TEXT NOT NULL," +
        "dimension TEXT NOT NULL CHECK (dimension IN ('source','keyword'))," +
        "key TEXT NOT NULL," +
        "weight REAL NOT NULL DEFAULT 0," +
        "confidence REAL NOT NULL DEFAULT 0," +
        "evidence_count INTEGER NOT NULL DEFAULT 0," +
        "last_reinforced_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
        "UNIQUE (source_key, dimension, key)" +
      ")",
      'CREATE INDEX IF NOT EXISTS idx_source_preference_weight ON source_preference(source_key, weight DESC)'
    ]
  },
  {
    // v21 命名统一：界面与来源标签里的「每日日报」统一改称「日报」（v15 种子行已发布，按追加迁移改写标签）。
    version: 21,
    name: 'rename-daily-source-label',
    up: [
      "UPDATE inbox_source SET label = '日报' WHERE key = 'daily' AND label = '每日日报'"
    ]
  },
  // v22 聊天记录源：微信/QQ 会话、消息、理解窗口与结论（FTS 由运行时 ensureImFts 建，失败降级 LIKE）
  ...imMigrations,
  {
    version: 23,
    name: 'user-material-folders',
    up: [
      'CREATE TABLE material_folders (key TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE)',
      "INSERT INTO material_folders VALUES ('uncategorized', '未分组')",
      "INSERT OR IGNORE INTO material_folders SELECT DISTINCT material_folder, material_folder FROM info WHERE destination='keep' AND material_folder IS NOT NULL AND material_folder != '' AND material_folder != 'uncategorized'"
    ]
  },
  {
    version: 24,
    name: 'email-keyword-profile',
    up: [
      'CREATE TABLE email_keyword (email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE, keyword TEXT NOT NULL, kind TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT \'\', confidence REAL NOT NULL DEFAULT 0, PRIMARY KEY(email_id, keyword))',
      'CREATE INDEX idx_email_keyword_term ON email_keyword(keyword)',
      'CREATE TABLE keyword_profile (keyword TEXT PRIMARY KEY, weight REAL NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0, repeat_count INTEGER NOT NULL DEFAULT 0, last_feedback_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)',
      'CREATE TABLE keyword_feedback (recommendation_id INTEGER NOT NULL REFERENCES recommendation(id) ON DELETE CASCADE, email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE, keyword TEXT NOT NULL, sentiment INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(recommendation_id, keyword))'
    ]
  },
  {
    // 首次打开新版时清空邮件的面板判断和学习信号。原始邮件、分析、事项与资料实体保留。
    version: 25,
    name: 'reset-email-panel-feedback',
    up: [
      "DELETE FROM feedback_event WHERE source_key IN (SELECT key FROM inbox_source WHERE kind='email')",
      "DELETE FROM recommendation WHERE source_key IN (SELECT key FROM inbox_source WHERE kind='email')",
      'DELETE FROM recommendation_batch WHERE NOT EXISTS (SELECT 1 FROM recommendation r WHERE r.batch_id=recommendation_batch.id)',
      'DELETE FROM keyword_feedback',
      'DELETE FROM keyword_profile',
      'DELETE FROM preference_signal'
    ]
  },
  {
    // v26 关键词画像改为全局画像：邮箱与 QQ 反馈写同一份关键词，邮箱单次反馈权重更高。
    version: 26,
    name: 'global-keyword-profile',
    up: [
      'ALTER TABLE keyword_profile ADD COLUMN email_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE keyword_profile ADD COLUMN qq_count INTEGER NOT NULL DEFAULT 0',
      'UPDATE keyword_profile SET email_count = evidence_count',
      "CREATE TABLE keyword_feedback_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL CHECK(source IN ('email','qq')), source_id INTEGER NOT NULL, keyword TEXT NOT NULL, sentiment INTEGER NOT NULL, weight REAL NOT NULL, created_at TEXT NOT NULL, UNIQUE(source, source_id, keyword))",
      "INSERT INTO keyword_feedback_v2(source, source_id, keyword, sentiment, weight, created_at) SELECT 'email', email_id, keyword, sentiment, 0.32, created_at FROM keyword_feedback",
      'DROP TABLE keyword_feedback',
      'ALTER TABLE keyword_feedback_v2 RENAME TO keyword_feedback',
      'CREATE INDEX idx_keyword_feedback_keyword ON keyword_feedback(keyword, created_at)'
    ]
  },
  {
    // v27 知乎反推荐：每天从登录态推荐流中挑出离画像较远的文章。
    // zhihu_state 只记录登录/同步状态，Cookie 本体留在 Chromium 的 persist:zhihu 分区；
    // zhihu_push 与 info（destination=keep）通过 info_id 关联，用户存为资料后可在资料页管理。
    version: 27,
    name: 'zhihu-counter',
    up: [
      "CREATE TABLE zhihu_state (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "logged_in INTEGER NOT NULL DEFAULT 0," +
        "last_sync_at TEXT," +
        "last_error TEXT NOT NULL DEFAULT ''," +
        "last_count INTEGER NOT NULL DEFAULT 0" +
      ")",
      'INSERT OR IGNORE INTO zhihu_state (id) VALUES (1)',
      "CREATE TABLE zhihu_push (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "date_key TEXT NOT NULL," +
        "item_key TEXT NOT NULL," +
        "title TEXT NOT NULL," +
        "excerpt TEXT NOT NULL DEFAULT ''," +
        "url TEXT NOT NULL," +
        "author TEXT NOT NULL DEFAULT ''," +
        "content_type TEXT NOT NULL DEFAULT ''," +
        "voteup INTEGER," +
        "reason TEXT NOT NULL DEFAULT ''," +
        "distance REAL," +
        "status TEXT NOT NULL DEFAULT 'pending'," +
        "info_id INTEGER REFERENCES info(id) ON DELETE SET NULL," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "acted_at TEXT," +
        "UNIQUE (date_key, item_key)" +
      ")",
      'CREATE INDEX idx_zhihu_push_date ON zhihu_push(date_key, id)',
      "INSERT OR IGNORE INTO inbox_source (key, label, kind) VALUES ('zhihu', '知乎', 'zhihu')"
    ]
  },
  {
    // v28 知乎双板块：推荐（贴兴趣）与反推荐（由推荐位引出另一面）共用一张表。
    // 旧行默认归入 counter，保留用户已有的已读/资料动作。
    version: 28,
    name: 'zhihu-interest-boards',
    up: [
      "ALTER TABLE zhihu_push ADD COLUMN board TEXT NOT NULL DEFAULT 'counter'",
      'CREATE INDEX idx_zhihu_push_board ON zhihu_push(date_key, board, id)',
      'ALTER TABLE zhihu_state ADD COLUMN last_recommend_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE zhihu_state ADD COLUMN last_counter_count INTEGER NOT NULL DEFAULT 0'
    ]
  },
  {
    // v29 SQLite 在嵌套触发器（如 emails 删除触发 info 更新再触发脏键写入）中会沿用外层语句的
    // ABORT 冲突策略，v18 触发器里的 INSERT OR IGNORE 不再生效；同一封邮件有多条 info 时会撞
    // panel_dirty_content 主键并导致删除账号/邮件失败。写入前先跳过已存在的键。
    version: 29,
    name: 'panel-dirty-content-nested-dedupe',
    up: [
      'CREATE TRIGGER IF NOT EXISTS panel_dirty_content_dedupe_bi BEFORE INSERT ON panel_dirty_content' +
        ' WHEN EXISTS (SELECT 1 FROM panel_dirty_content WHERE content_key = NEW.content_key)' +
        ' BEGIN SELECT RAISE(IGNORE); END'
    ]
  }
]

export function latestSchemaVersion(): number { return MIGRATIONS.at(-1)!.version }

/** 应用未执行的迁移；返回当前 schema 版本号 */
export function migrate(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))")
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  let current = row?.v ?? 0
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      for (const sql of m.up) db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version)
      db.exec('COMMIT')
      current = m.version
      console.log(`[db] 迁移已应用：v${m.version} ${m.name}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 v${m.version} ${m.name} 失败：${(error as Error).message}`)
    }
  }
  return current
}
