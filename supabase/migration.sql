-- ─────────────────────────────────────────────────────────────────────────────
-- RevIQ Command — Database Migration
-- Run this in the Supabase SQL Editor for your project
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: messages
-- Every message from the Telegram group chat
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_message_id   BIGINT      NOT NULL,
  sender_name           TEXT        NOT NULL,
  sender_telegram_id    BIGINT      NOT NULL,
  text                  TEXT,
  file_type             TEXT,        -- 'photo' | 'document' | 'voice' | 'video' | NULL
  file_id               TEXT,        -- Telegram file_id for re-sending
  reply_to_message_id   BIGINT,      -- telegram_message_id of the parent message
  tags                  TEXT[],      -- ['#task', '#decision', '#idea', '#blocker', '#reference']
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_created_at        ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_telegram_msg_id   ON messages (telegram_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id         ON messages (sender_telegram_id);
CREATE INDEX IF NOT EXISTS idx_messages_file_type         ON messages (file_type) WHERE file_type IS NOT NULL;

-- Full-text search index on message text
CREATE INDEX IF NOT EXISTS idx_messages_text_fts
  ON messages USING gin(to_tsvector('english', COALESCE(text, '')));

-- Unique constraint so we can upsert without duplicates on bot restart
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_messages_telegram_msg_id'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT uq_messages_telegram_msg_id UNIQUE (telegram_message_id);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: tasks
-- Action items extracted from chat or created manually
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title              TEXT        NOT NULL,
  description        TEXT,
  assigned_to        TEXT        NOT NULL,   -- person's name (matches team_members.name)
  status             TEXT        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'in_progress', 'done')),
  priority           TEXT        NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low', 'normal', 'high')),
  created_by         TEXT        NOT NULL,
  source_message_id  BIGINT,                 -- telegram_message_id that triggered this task
  due_date           DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at  ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks (priority);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: decisions
-- Logged decisions from /decide command
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decisions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision           TEXT        NOT NULL,
  context            TEXT,
  decided_by         TEXT        NOT NULL,
  source_message_id  BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions (created_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: team_members
-- The 5 people on the launch team — edit these rows directly in Supabase
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  telegram_username  TEXT        NOT NULL,
  telegram_id        BIGINT      NOT NULL,
  role               TEXT        NOT NULL
);

-- Seed with placeholder data — replace with real team info
INSERT INTO team_members (name, telegram_username, telegram_id, role) VALUES
  ('Alec',    'alec_placeholder',    1000000001, 'CEO / Founder'),
  ('Omar',    'omar_placeholder',    1000000002, 'CTO'),
  ('Sofia',   'sofia_placeholder',   1000000003, 'Head of Product'),
  ('Marcus',  'marcus_placeholder',  1000000004, 'Lead Engineer'),
  ('Priya',   'priya_placeholder',   1000000005, 'Head of Growth')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: interventions
-- Every autonomous message the bot sends, for review and tuning
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interventions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_reason  TEXT        NOT NULL,   -- e.g. 'CONTRADICTION', 'FORGOTTEN_TASK', etc.
  message_text    TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_interventions_created_at ON interventions (created_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- SUPABASE REALTIME
-- Enable live subscriptions for tasks and decisions (used by web dashboard)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE decisions;


-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Disable RLS for now — access is controlled by the service key (bot) and
-- anon key scoped to dashboard. Enable and add policies when you scale the team.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages      DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE decisions     DISABLE ROW LEVEL SECURITY;
ALTER TABLE team_members  DISABLE ROW LEVEL SECURITY;
ALTER TABLE interventions DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: knowledge_base
-- Permanent facts and rules the AI remembers and uses as foundational context
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_base (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fact            TEXT        NOT NULL,
  source          TEXT        NOT NULL DEFAULT 'auto', -- 'auto' or 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_knowledge_base_created_at ON knowledge_base (created_at DESC);

ALTER TABLE knowledge_base DISABLE ROW LEVEL SECURITY;
