-- Bruno's ChatGPT / Claude history from explicit exports and shared clips (spec §11).
BEGIN;

CREATE TABLE ai_import (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  source       text NOT NULL,
  checksum     text NOT NULL,
  imported_at  timestamptz NOT NULL,
  stats        jsonb NOT NULL
);

CREATE TABLE ai_conversation (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  source         text NOT NULL,
  external_id    text NOT NULL,
  title          text NOT NULL,
  project        text,
  created_at     timestamptz,
  updated_at     timestamptz,
  import_id      text NOT NULL,
  message_count  integer NOT NULL
);
CREATE INDEX ai_conversation_owner ON ai_conversation (owner_id, updated_at DESC);

CREATE TABLE ai_message (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL,
  owner_id         text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  role             text NOT NULL,
  text             text NOT NULL,
  created_at       timestamptz
);
CREATE INDEX ai_message_conv ON ai_message (conversation_id, seq);
CREATE INDEX ai_message_fts ON ai_message USING gin (to_tsvector('simple', text));

CREATE TABLE ai_project (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  source     text NOT NULL,
  name       text NOT NULL,
  data       jsonb NOT NULL,
  import_id  text NOT NULL
);

COMMIT;
