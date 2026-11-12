import type { Migration } from './migrations'

/**
 * 认知数据层（画像记忆 / 长期规则 / 权限策略）迁移。
 *
 * 只新增认知相关表并对旧数据做「兼容回填」，不删除、不清空旧 profile_memory / settings。
 * version 11：与并行进行的 v9/v10（会话/消息等）互不依赖，主代理负责把本数组追加进 migrations.ts。
 *
 * 约定（与 shared/cognition.ts 一致）：
 * - 记忆必备 content / source_ref(结构引用) / source_kind / recorded_at / last_confirmed_at；
 * - 未确认推断 last_confirmed_at 为空，不在迁移中伪造确认时间；
 * - 每次内容变化在 history 表保留版本快照；删除=停用（status='archived'），不物理删除；
 * - field_key 为稳定语义键：同 key 冲突检测/显式修正；旧 profile_memory 无 key 置 NULL；
 * - userGrade/userMajor 从 settings 映射为 background 明确画像（field_key=grade/major），原 settings 键保留不清空。
 * - 这里 SQL 全部用单引号字符串，JSON 用 json_array/json_object 生成，避免转义歧义。
 */

export const cognitionMigrations: Migration[] = [
  {
    version: 11,
    name: 'cognition',
    up: [
      // —— 结构化画像记忆（当前行；版本历史在 cognition_memory_history） ——
      "CREATE TABLE cognition_memory (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "section TEXT NOT NULL DEFAULT 'general'," +
        "content TEXT NOT NULL," +
        "source_kind TEXT NOT NULL DEFAULT 'explicit'," +
        "field_key TEXT," +
        "source_ref TEXT NOT NULL DEFAULT ''," +
        "status TEXT NOT NULL DEFAULT 'active'," +
        "recorded_at TEXT NOT NULL," +
        "last_confirmed_at TEXT," +
        "revision INTEGER NOT NULL DEFAULT 1," +
        "manual_edited INTEGER NOT NULL DEFAULT 0," +
        "confidence REAL," +
        "created_at TEXT NOT NULL," +
        "updated_at TEXT NOT NULL" +
        ")",
      "CREATE INDEX idx_cog_mem_section ON cognition_memory(section, status)",
      "CREATE INDEX idx_cog_mem_status ON cognition_memory(status)",
      "CREATE INDEX idx_cog_mem_field ON cognition_memory(field_key, status)",
      // —— 记忆版本/事件历史（追加式，不做物理遗忘） ——
      "CREATE TABLE cognition_memory_history (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "memory_id INTEGER NOT NULL REFERENCES cognition_memory(id)," +
        "revision INTEGER NOT NULL," +
        "content TEXT NOT NULL," +
        "source_kind TEXT NOT NULL," +
        "field_key TEXT," +
        "source_ref TEXT NOT NULL DEFAULT ''," +
        "section TEXT NOT NULL," +
        "status TEXT NOT NULL," +
        "recorded_at TEXT NOT NULL," +
        "last_confirmed_at TEXT," +
        "changed_by TEXT NOT NULL DEFAULT ''," +
        "change_kind TEXT NOT NULL," +
        "changed_at TEXT NOT NULL" +
        ")",
      "CREATE INDEX idx_cog_mem_hist ON cognition_memory_history(memory_id, id)",
      // —— 长期规则（程序可校验的 condition/action，不只自然语言） ——
      "CREATE TABLE cognition_rule (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "scope TEXT NOT NULL DEFAULT 'global'," +
        "name TEXT NOT NULL," +
        "description TEXT NOT NULL DEFAULT ''," +
        "condition_json TEXT NOT NULL DEFAULT '[]'," +
        "action_json TEXT NOT NULL," +
        "enforcement TEXT NOT NULL DEFAULT 'mandatory'," +
        "enabled INTEGER NOT NULL DEFAULT 1," +
        "revision INTEGER NOT NULL DEFAULT 1," +
        "modified_by TEXT NOT NULL DEFAULT ''," +
        "created_at TEXT NOT NULL," +
        "updated_at TEXT NOT NULL" +
        ")",
      "CREATE INDEX idx_cog_rule_scope ON cognition_rule(scope, enabled)",
      // —— 权限策略（单例行 id=1；仅设置页 IPC 可改） ——
      "CREATE TABLE cognition_policy (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "read_domains_json TEXT NOT NULL," +
        "write_auto_json TEXT NOT NULL," +
        "write_confirm_json TEXT NOT NULL," +
        "write_deny_json TEXT NOT NULL," +
        "learning_enabled INTEGER NOT NULL DEFAULT 1," +
        "background_enabled INTEGER NOT NULL DEFAULT 1," +
        "memory_freshness_days INTEGER NOT NULL DEFAULT 30," +
        "time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai'," +
        "updated_at TEXT NOT NULL" +
        ")",
      // —— 兼容回填：旧 profile_memory → cognition_memory（field_key 置 NULL，不猜语义键） ——
      "INSERT INTO cognition_memory" +
        " (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at," +
        "  revision, manual_edited, confidence, created_at, updated_at)" +
        " SELECT 'general', content," +
        "   CASE WHEN kind = 'inferred' THEN 'inferred' ELSE 'explicit' END," +
        "   NULL," +
        "   source," +
        "   CASE WHEN archived = 1 THEN 'archived'" +
        "        WHEN kind = 'inferred' AND last_confirmed_at IS NULL THEN 'candidate'" +
        "        ELSE 'active' END," +
        "   recorded_at, last_confirmed_at, 1, 0, NULL," +
        "   recorded_at, COALESCE(last_confirmed_at, recorded_at)" +
        " FROM profile_memory",
      // —— 兼容回填：userGrade/userMajor → background 明确画像（field_key=grade/major，settings 原键保留） ——
      "INSERT INTO cognition_memory" +
        " (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at," +
        "  revision, manual_edited, confidence, created_at, updated_at)" +
        " SELECT 'background'," +
        "   COALESCE(NULLIF(json_extract(value, '$'), ''), trim(value, char(34)))," +
        "   'explicit'," +
        "   CASE WHEN key = 'userGrade' THEN 'grade' ELSE 'major' END," +
        "   json_object('type','legacy','label',key)," +
        "   'active'," +
        "   datetime('now'), NULL, 1, 0, NULL, datetime('now'), datetime('now')" +
        " FROM settings" +
        " WHERE key IN ('userGrade', 'userMajor')" +
        "   AND COALESCE(NULLIF(json_extract(value, '$'), ''), trim(value, char(34))) IS NOT NULL" +
        "   AND COALESCE(NULLIF(json_extract(value, '$'), ''), trim(value, char(34))) != ''" +
        "   AND COALESCE(NULLIF(json_extract(value, '$'), ''), trim(value, char(34))) NOT IN ('null', 'undefined')",
      // —— 初始权限策略行（默认分级确认） ——
      "INSERT INTO cognition_policy" +
        " (id, read_domains_json, write_auto_json, write_confirm_json, write_deny_json," +
        "  learning_enabled, background_enabled, memory_freshness_days, time_zone, updated_at)" +
        " VALUES (1," +
        "   json_array('email','info','item','reminder','daily','article')," +
        "   json_array('create_item','update_item','route_info','route_article','save_info','mail_flags','create_reminder','learn_memory','set_category')," +
        "   json_array('delete_item','delete_reminder','propose_rule','reconfirm_memory')," +
        "   '[]'," +
        "   1, 1, 30, 'Asia/Shanghai', datetime('now'))"
    ]
  }
]
