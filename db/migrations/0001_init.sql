-- Jennifer core schema (spec §15). PostgreSQL 16 + pgvector.
-- Every private entity carries owner_id and space; deletion behavior is explicit.
BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE space AS ENUM ('personal','insurance','music','restaurant','nonprofit','technology');
CREATE TYPE sensitivity AS ENUM ('normal','sensitive','restricted');
CREATE TYPE action_mode AS ENUM ('observe','draft','execute','ask');
CREATE TYPE action_state AS ENUM ('proposed','validated','awaiting_decision','ready','executing','provider_accepted','confirmed','failed','canceled','unknown');
CREATE TYPE capability_status AS ENUM ('verified','conditional','unavailable','disconnected');
CREATE TYPE user_role AS ENUM ('owner','developer','operator');

CREATE TABLE app_user (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  role          user_role NOT NULL,
  home_tz       text NOT NULL DEFAULT 'Europe/Rome',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform      text NOT NULL,
  os_version    text,
  public_key    text NOT NULL,             -- device-bound credential
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE account_connection (
  id                 text PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  connector_id       text NOT NULL,          -- gmail, outlook, telephony, ...
  environment        text NOT NULL,          -- tokens are bound to account + environment
  external_account   text NOT NULL,
  vault_secret_ref   text NOT NULL,          -- refresh token lives in the vault, never here
  scopes             text[] NOT NULL,
  capabilities       jsonb NOT NULL,         -- {read:{status,note,verifiedAt},...}
  sync_cursor        text,                   -- e.g. Gmail historyId
  watch_expires_at   timestamptz,
  last_sync_at       timestamptz,
  last_error         text,
  connected          boolean NOT NULL DEFAULT false,
  revoked_at         timestamptz,
  UNIQUE (owner_id, connector_id, external_account, environment)
);

CREATE TABLE project (
  id        text PRIMARY KEY,
  owner_id  text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  space     space NOT NULL,
  name      text NOT NULL
);

CREATE TABLE contact (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  spaces        space[] NOT NULL,
  relationship  text,
  instructions  text
);

CREATE TABLE contact_identity (
  contact_id  text NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  owner_id    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('email','phone','whatsapp','handle')),
  value       text NOT NULL,              -- normalized
  verified    boolean NOT NULL DEFAULT false,
  source      text NOT NULL,
  PRIMARY KEY (contact_id, kind, value)
);
CREATE INDEX contact_identity_lookup ON contact_identity (owner_id, kind, value);

CREATE TABLE conversation (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id          text NOT NULL REFERENCES account_connection(id) ON DELETE CASCADE,
  channel             text NOT NULL,
  space               space NOT NULL,
  provider_thread_id  text,
  subject             text,
  revision            integer NOT NULL DEFAULT 0,
  UNIQUE (account_id, provider_thread_id)
);

CREATE TABLE attachment (
  id                         text PRIMARY KEY,
  owner_id                   text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  space                      space NOT NULL,
  filename                   text NOT NULL,
  mime_type                  text NOT NULL,
  size_bytes                 bigint NOT NULL,
  storage_ref                text NOT NULL,        -- encrypted object storage key
  scan_status                text NOT NULL DEFAULT 'pending',
  sensitivity                sensitivity NOT NULL DEFAULT 'normal',
  shareable_with_contact_ids text[]
);

CREATE TABLE message (
  id                   text PRIMARY KEY,
  owner_id             text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id           text NOT NULL REFERENCES account_connection(id) ON DELETE CASCADE,
  conversation_id      text NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  provider_message_id  text,
  provider_thread_id   text,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  status               text NOT NULL,
  sender               jsonb NOT NULL,
  recipients           jsonb NOT NULL,       -- {to:[],cc:[],bcc:[]}
  subject              text,
  body_ref             text NOT NULL,        -- encrypted object storage
  headers              jsonb NOT NULL DEFAULT '{}',
  language             text,
  flags                text[] NOT NULL DEFAULT '{}',
  occurred_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_message_id)
);

CREATE TABLE message_attachment (
  message_id     text NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  attachment_id  text NOT NULL REFERENCES attachment(id) ON DELETE RESTRICT,
  PRIMARY KEY (message_id, attachment_id)
);

-- Inbound events: committed before acknowledgment; unique provider key dedupes redelivery.
CREATE TABLE event (
  id                 text PRIMARY KEY,
  provider_event_id  text NOT NULL,
  owner_id           text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id         text NOT NULL,
  channel            text NOT NULL,
  kind               text NOT NULL,
  conversation_id    text,
  sender             jsonb,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  payload_ref        text NOT NULL,
  language           text,
  space              space,
  trace_id           text NOT NULL,
  processed_at       timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  UNIQUE (account_id, provider_event_id)
);
CREATE INDEX event_unprocessed ON event (received_at) WHERE processed_at IS NULL;

CREATE TABLE authority_rule (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  principal       text NOT NULL,
  action          text NOT NULL,
  mode            action_mode NOT NULL,
  scope           jsonb NOT NULL,
  limits          jsonb NOT NULL DEFAULT '{}',
  attachments     jsonb NOT NULL DEFAULT '{"allowed":false}',
  expires_at      timestamptz,
  policy_version  integer NOT NULL,
  revoked_at      timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  parent_id        text REFERENCES task(id) ON DELETE CASCADE,
  role             text NOT NULL,
  goal             text NOT NULL,
  authorized_scope jsonb NOT NULL,
  deadline         timestamptz NOT NULL,
  max_cost_eur     numeric(10,4) NOT NULL,
  spent_eur        numeric(10,4) NOT NULL DEFAULT 0,
  tool_budget      integer NOT NULL,
  tool_calls       integer NOT NULL DEFAULT 0,
  depth            integer NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL
);

-- Outbox: each action intent is the durable record of an outbound intent.
CREATE TABLE action_intent (
  id                            text PRIMARY KEY,
  owner_id                      text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type                          text NOT NULL,
  space                         space NOT NULL,
  channel                       text NOT NULL,
  connector_id                  text NOT NULL,
  account_id                    text NOT NULL,
  conversation_id               text REFERENCES conversation(id) ON DELETE SET NULL,
  based_on_conversation_revision integer,
  workflow_id                   text,
  task_id                       text REFERENCES task(id) ON DELETE SET NULL,
  payload                       jsonb NOT NULL,
  revision                      integer NOT NULL,
  payload_hash                  text NOT NULL,
  idempotency_key               text NOT NULL UNIQUE,
  state                         action_state NOT NULL,
  state_reason                  text,
  policy_version                integer,
  authority_rule_id             text REFERENCES authority_rule(id),
  approval_id                   text,
  attempts                      integer NOT NULL DEFAULT 0,
  next_attempt_at               timestamptz,
  expires_at                    timestamptz,
  proposed_by                   text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_ready ON action_intent (next_attempt_at) WHERE state = 'ready';

CREATE TABLE action_transition (
  action_id  text NOT NULL REFERENCES action_intent(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  from_state action_state NOT NULL,
  to_state   action_state NOT NULL,
  reason     text,
  actor      text NOT NULL
);

-- Approval is bound to one revision + payload hash + approving user; never a blanket token.
CREATE TABLE approval (
  id                text PRIMARY KEY,
  action_id         text NOT NULL REFERENCES action_intent(id) ON DELETE CASCADE,
  revision          integer NOT NULL,
  payload_hash      text NOT NULL,
  approved_by       text NOT NULL REFERENCES app_user(id),
  approved_at       timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  step_up_verified  boolean NOT NULL DEFAULT false,
  consumed_at       timestamptz,
  invalidated_at    timestamptz
);

CREATE TABLE action_receipt (
  action_id            text PRIMARY KEY REFERENCES action_intent(id) ON DELETE CASCADE,
  provider_message_id  text,
  provider_event_id    text,
  delivery_status      text NOT NULL,
  observed_at          timestamptz NOT NULL,
  evidence             text NOT NULL
);

CREATE TABLE suppression_rule (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contact(id) ON DELETE CASCADE,
  address     text,
  domain      text,
  channels    text[],                        -- NULL = all
  reason      text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz
);

CREATE TABLE memory_source (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  ref          text NOT NULL,
  excerpt      text NOT NULL,
  asserted_by  text NOT NULL,
  checksum     text
);

CREATE TABLE memory_entry (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  space             space NOT NULL,
  contact_id        text REFERENCES contact(id) ON DELETE CASCADE,
  key               text,
  value             text NOT NULL,                 -- field-encrypt when sensitivity <> 'normal'
  source_id         text NOT NULL REFERENCES memory_source(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  effective_from    timestamptz NOT NULL,
  effective_until   timestamptz,
  last_verified_at  timestamptz,
  confidence        text NOT NULL,
  sensitivity       sensitivity NOT NULL,
  retention         text NOT NULL,
  status            text NOT NULL,
  superseded_by     text REFERENCES memory_entry(id) ON DELETE SET NULL,
  fingerprint       text NOT NULL,
  embedding         vector(1536)                     -- deleted together with the row
);
CREATE INDEX memory_scope ON memory_entry (owner_id, space, status, sensitivity);
CREATE INDEX memory_embedding ON memory_entry USING hnsw (embedding vector_cosine_ops);

-- Deletion ledger blocks reinsertion from old imports.
CREATE TABLE memory_deletion_ledger (
  owner_id     text NOT NULL,
  fingerprint  text NOT NULL,
  source_ref   text NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, fingerprint)
);

CREATE TABLE memory_review (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  entry_ids    text[] NOT NULL,
  message      text NOT NULL,
  resolved_at  timestamptz
);

CREATE TABLE call_session (
  id                 text PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dialed_account_id  text NOT NULL,
  caller_number      text,
  caller_hint_contact_id text REFERENCES contact(id) ON DELETE SET NULL,
  caller_name        text,
  purpose            text,
  verified           boolean NOT NULL DEFAULT false,
  phase              text NOT NULL,
  language           text NOT NULL,
  recording_ref      text,                   -- off by default
  transcript_ref     text,
  summary            text,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  retention_until    timestamptz
);

CREATE TABLE feedback (
  id                 text PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  action_id          text REFERENCES action_intent(id) ON DELETE SET NULL,
  kind               text NOT NULL,
  space              space NOT NULL,
  contact_id         text REFERENCES contact(id) ON DELETE SET NULL,
  original_candidate text NOT NULL,
  approved_final     text,
  note               text,
  source_refs        text[] NOT NULL DEFAULT '{}',
  policy_version     integer,
  model_version      text NOT NULL,
  prompt_version     text NOT NULL,
  training_consent   boolean NOT NULL DEFAULT false,
  at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_run (
  id               text PRIMARY KEY,
  candidate        text NOT NULL,
  baseline         text NOT NULL,
  dataset_ref      text NOT NULL,
  critical_passed  boolean NOT NULL,
  metrics          jsonb NOT NULL,
  report_ref       text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_deployment (
  id                  text PRIMARY KEY,
  kind                text NOT NULL,
  version             text NOT NULL,
  dataset_ref         text,
  evaluation_run_id   text REFERENCES evaluation_run(id),
  status              text NOT NULL,
  deployed_at         timestamptz,
  rolled_back_at      timestamptz
);

CREATE TABLE proactive_workflow (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name                text NOT NULL,
  template            text NOT NULL,
  trigger             jsonb NOT NULL,
  time_zone           text NOT NULL,
  space               space NOT NULL,
  inputs              jsonb NOT NULL DEFAULT '{}',
  allowed_actions     text[] NOT NULL,
  exclusions          text[] NOT NULL DEFAULT '{}',
  stop_conditions     text[] NOT NULL DEFAULT '{}',
  success_criteria    text NOT NULL,
  max_follow_ups      integer NOT NULL,
  status              text NOT NULL DEFAULT 'draft',
  confirmed_at        timestamptz,
  last_run_at         timestamptz
);

-- Append-only audit log.
CREATE TABLE audit_event (
  id          text PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  owner_id    text,
  actor       text NOT NULL,
  kind        text NOT NULL,
  subject_id  text,
  detail      jsonb NOT NULL                -- redacted before insert
);
CREATE INDEX audit_subject ON audit_event (subject_id);
REVOKE UPDATE, DELETE ON audit_event FROM PUBLIC;

-- Row-level security: developer/operator roles cannot read private correspondence.
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only_message ON message USING (owner_id = current_setting('jennifer.owner_id', true));
CREATE POLICY owner_only_memory ON memory_entry USING (owner_id = current_setting('jennifer.owner_id', true));
CREATE POLICY owner_only_call ON call_session USING (owner_id = current_setting('jennifer.owner_id', true));

COMMIT;
