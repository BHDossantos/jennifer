-- Durable conversations, messages, attachments and memory as documents.
-- (The normalized tables from 0001 remain the long-term target; these keep
-- the in-process domain model durable today.)
BEGIN;

CREATE TABLE conversation_doc (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_doc (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  conversation_id  text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  data             jsonb NOT NULL
);
CREATE INDEX message_doc_conv ON message_doc (conversation_id, occurred_at);

CREATE TABLE attachment_doc (
  id        text PRIMARY KEY,
  owner_id  text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  data      jsonb NOT NULL
);

CREATE TABLE memory_doc (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status      text NOT NULL,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_review_doc (
  id        text PRIMARY KEY,
  owner_id  text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  data      jsonb NOT NULL
);

COMMIT;
