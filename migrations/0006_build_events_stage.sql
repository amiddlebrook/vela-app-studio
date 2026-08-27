ALTER TABLE build_events ADD COLUMN stage TEXT;
CREATE INDEX IF NOT EXISTS idx_build_events_stage ON build_events(stage);
