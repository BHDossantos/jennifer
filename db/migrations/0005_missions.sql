-- Missions: always-on goal-driven agents (activity log and results inside data).
BEGIN;

CREATE TABLE mission (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status      text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_owner ON mission (owner_id, status);

COMMIT;
