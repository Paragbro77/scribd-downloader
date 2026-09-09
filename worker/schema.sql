CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, pages TEXT DEFAULT 'all',
  scale INTEGER DEFAULT 2, delay REAL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL, started_at INTEGER, heartbeat_at INTEGER, finished_at INTEGER,
  attempts INTEGER DEFAULT 0, title TEXT, pages_done INTEGER, download_url TEXT,
  client_key TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_key, created_at);

CREATE TABLE IF NOT EXISTS rate_buckets (
  rate_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (rate_key, window_start)
);

CREATE TABLE IF NOT EXISTS turnstile_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turnstile_tokens_created ON turnstile_tokens(created_at);
