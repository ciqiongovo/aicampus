import type { Migration } from './migrations'
export const workspaceMigrations: Migration[] = [{ version: 9, name: 'persistent-ai-workspace', up: [
  "CREATE TABLE ai_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE ai_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id), request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', model_state TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE ai_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, references_json TEXT NOT NULL DEFAULT '[]', attachment_ids TEXT NOT NULL DEFAULT '[]', run_id TEXT REFERENCES ai_runs(id), created_at TEXT NOT NULL)",
  "CREATE TABLE ai_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id), call_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, call_id))",
  "CREATE TABLE ai_attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id), name TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, status TEXT NOT NULL, error TEXT, extracted_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at)",
  "CREATE INDEX idx_ai_runs_conversation ON ai_runs(conversation_id, created_at)",
  "CREATE UNIQUE INDEX idx_ai_active_run ON ai_runs(conversation_id) WHERE status IN ('running','waiting_confirmation')",
  "CREATE TABLE ai_background_jobs (id INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)"
] }]
