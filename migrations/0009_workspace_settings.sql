CREATE TABLE IF NOT EXISTS workspace_settings (
  owner_id TEXT PRIMARY KEY,
  active_provider TEXT DEFAULT 'auto',
  openrouter_key_ciphertext TEXT,
  openrouter_model TEXT DEFAULT 'anthropic/claude-3.5-sonnet',
  openai_key_ciphertext TEXT,
  openai_model TEXT DEFAULT 'gpt-4o',
  gemini_key_ciphertext TEXT,
  gemini_model TEXT DEFAULT 'gemini-2.0-flash',
  anthropic_key_ciphertext TEXT,
  anthropic_model TEXT DEFAULT 'claude-3-5-sonnet-20241022',
  cf_ai_model TEXT DEFAULT '@cf/meta/llama-3.3-70b-instruct',
  custom_endpoint TEXT,
  custom_key_ciphertext TEXT,
  custom_model TEXT,
  updated_at TEXT NOT NULL
);
