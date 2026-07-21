// Inlined rather than read from a .sql file at runtime: electron-vite bundles
// src/main into a single out/main/index.js and does not copy arbitrary
// non-imported assets alongside it, so a file read here would break in the
// packaged app while working in dev. Keeping the schema as a TS string keeps
// dev and packaged behavior identical.
export const SCHEMA_SQL = `
-- "workspace" is this app's project: one row per connected folder, a
-- user-facing name, and (via sessions.workspace_id) the group of
-- conversations that belong to it. collapsed is the sidebar's persisted
-- expand/collapse UI preference for that project group.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- 'default'   — still the generic "New <Agent> session" placeholder, eligible for one-time auto-generation.
  -- 'generated' — auto-derived from the first real prompt; still replaceable by a later generation, never by an older one.
  -- 'handoff'   — set once at continuation-creation time from the new instruction; protected the same as manual.
  -- 'manual'    — the user explicitly renamed it; never touched by any automatic titling again.
  title_source TEXT NOT NULL DEFAULT 'default',
  -- The session this one was created from via "Continue with another agent",
  -- if any. Never mutated after creation. Used to reliably exclude the
  -- injected handoff-envelope message from this session's OWN future
  -- handoff summaries (see handoff-service.ts) — the envelope is always
  -- and only that first user message when this is non-null, by construction.
  continued_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  native_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_memory (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_memory_session ON approval_memory(session_id, command_hash);
`
