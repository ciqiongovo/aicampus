import type { Migration } from './migrations'
/** v12：Agent 思考流。只追加，不改已发布迁移。 */
export const agentMigrations: Migration[] = [{ version: 12, name: 'agent-thoughts', up: [
  "CREATE TABLE ai_thoughts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id), seq INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, seq))",
  "CREATE INDEX idx_ai_thoughts_run ON ai_thoughts(run_id, seq)"
] }]
