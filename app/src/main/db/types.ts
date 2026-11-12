// 数据库行类型：与 migrations.ts 中的建表 SQL 一一对应

export interface AccountRow {
  id: number
  provider: string
  label: string
  address: string
  host: string
  port: number | null
  encryption: 'ssl' | 'starttls'
  username: string
  secret_enc: string
  folder: string
  auth_mode: 'appPassword' | 'password' | 'oauth'
  last_uidvalidity: number | null
  last_uid: number | null
  last_sync_at: string | null
  sync_error: string | null
  ai_enabled: number
  ai_provider: string | null
  ai_base_url: string | null
  ai_model: string | null
  oauth_provider: string | null
  oauth_client_id: string | null
  oauth_refresh_enc: string | null
  oauth_access_enc: string | null
  oauth_expires_at: number | null
  created_at: string
  updated_at: string
}

export interface EmailRow {
  id: number
  account_id: number
  folder: string
  uid: number
  message_id: string
  subject: string
  from_addr: string
  to_addr: string
  cc: string
  date_utc: string | null
  date_raw: string | null
  unread: number
  starred: number
  body_text: string
  body_html: string
  attachments_json: string
  size: number
  created_at: string
}

export interface EmailAnalysisRow {
  id: number
  email_id: number
  status: 'pending' | 'analyzed' | 'failed' | 'skipped'
  category: string | null
  summary: string | null
  action_required: string | null
  deadline_raw: string | null
  deadline_at: string | null
  deadline_kind: string | null
  event_start_at: string | null
  applicable_to: string | null
  confidence: number | null
  tier: string | null
  evidence_json: string
  model: string | null
  provider: string | null
  error: string | null
  analyzed_at: string | null
}

export interface ItemRow {
  id: number
  title: string
  source_email_id: number | null
  category: string | null
  status: string
  deadline_at: string | null
  deadline_raw: string | null
  deadline_kind: string | null
  event_start_at: string | null
  suggest_start_at: string | null
  notes: string
  created_at: string
  updated_at: string
  /** v14 日程与待办：清单分组、完成时刻、优先级（0 无 / 1 低 / 2 中 / 3 高）、事件结束与全天标记 */
  list_id: number | null
  completed_at: string | null
  priority: number
  event_end_at: string | null
  all_day: number
}

export interface ReminderRow {
  id: number
  item_id: number
  remind_at: string
  channel: string
  status: string
  fired_at: string | null
  error: string | null
  created_at: string
}

/** P1 信息流条目（四去向：unverified 待核实 / item 事项 / keep 资料 / archive 归档） */
export interface InfoRow {
  id: number
  source_type: string
  source_email_id: number | null
  title: string
  content: string
  category: string | null
  destination: 'unverified' | 'item' | 'keep' | 'archive'
  item_id: number | null
  status: string
  created_at: string
  routed_at: string | null
}
