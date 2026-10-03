-- Owner settings (voice choice, persona controls, UI preferences).
BEGIN;

CREATE TABLE app_setting (
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

COMMIT;
