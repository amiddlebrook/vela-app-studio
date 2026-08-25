CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
