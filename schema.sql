CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session TEXT,
  device TEXT,
  country TEXT,
  city TEXT,
  referrer TEXT,
  ua TEXT,
  ip TEXT,
  region_cn TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits (ts);
CREATE INDEX IF NOT EXISTS idx_visits_session ON visits (session);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits (ip, ts);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER DEFAULT 0,
  last_ts INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_email ON requests (email);
