-- Per-connector sync cursors (IMAP UIDVALIDITY/UID, Gmail history id, Graph delta link).
BEGIN;

CREATE TABLE connector_cursor (
  owner_id      text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  connector_id  text NOT NULL,
  account_id    text NOT NULL,
  cursor        jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, connector_id, account_id)
);

COMMIT;
