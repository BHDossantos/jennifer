-- Worker leases for event processing, and identity tables for Week 2.
BEGIN;

ALTER TABLE event ADD COLUMN lease_until timestamptz;
ALTER TABLE action_intent ADD COLUMN decision_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE action_intent ADD COLUMN receipt jsonb;

CREATE TABLE passkey_credential (
  id             text PRIMARY KEY,           -- base64url credential id
  owner_id       text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  device_id      text REFERENCES device(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE TABLE auth_session (
  id_hash         text PRIMARY KEY,          -- sha256 of the bearer token; token itself never stored
  owner_id        text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id       text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  role            user_role NOT NULL,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  step_up_at      timestamptz,
  revoked_at      timestamptz
);

CREATE TABLE vault_secret (
  ref            text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id     text NOT NULL,
  environment    text NOT NULL,
  wrapped_key    bytea NOT NULL,             -- data key encrypted by the master key (KMS in production)
  ciphertext     bytea NOT NULL,
  iv             bytea NOT NULL,
  tag            bytea NOT NULL,
  key_version    integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz,
  revoked_at     timestamptz
);

COMMIT;
