-- Jennifer Company OS (blueprint §12): companies, memberships, versioned roles,
-- persisted runs with ordered events, company knowledge, CRM records with
-- versioned patches, and per-company budgets. Every company-owned row carries
-- company_id; child rows reference (company_id, id) so they cannot point at
-- another company's parent.
BEGIN;

CREATE TABLE company (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name        text NOT NULL,
  timezone    text NOT NULL,
  locale      text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  profile     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_membership (
  company_id  text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','member','viewer')),
  permissions text[] NOT NULL DEFAULT '{}',
  revoked_at  timestamptz,
  PRIMARY KEY (company_id, user_id)
);

-- Immutable role configuration versions (a run pins the version it used).
CREATE TABLE agent_version (
  agent_id    text NOT NULL,
  version     integer NOT NULL,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE company_run (
  company_id       text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id               text NOT NULL,
  workflow_id      text NOT NULL,
  workflow_version integer NOT NULL,
  status           text NOT NULL,
  idempotency_key  text,
  data             jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX company_run_idem ON company_run (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX company_run_status ON company_run (status, updated_at);

CREATE TABLE company_run_event (
  company_id  text NOT NULL,
  run_id      text NOT NULL,
  seq         integer NOT NULL,
  type        text NOT NULL,
  at          timestamptz NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (company_id, run_id, seq),
  FOREIGN KEY (company_id, run_id) REFERENCES company_run(company_id, id) ON DELETE CASCADE
);

CREATE TABLE company_artifact (
  company_id   text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           text NOT NULL,
  run_id       text,
  kind         text NOT NULL,
  content_hash text NOT NULL,
  review       text NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE knowledge_source (
  company_id      text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id              text NOT NULL,
  title           text NOT NULL,
  classification  text NOT NULL,
  status          text NOT NULL,
  data            jsonb NOT NULL,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE knowledge_chunk (
  company_id          text NOT NULL,
  source_id           text NOT NULL,
  document_version_id text NOT NULL,
  seq                 integer NOT NULL,
  locator             text NOT NULL,
  text                text NOT NULL,
  PRIMARY KEY (company_id, document_version_id, seq),
  FOREIGN KEY (company_id, source_id) REFERENCES knowledge_source(company_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunk_fts ON knowledge_chunk USING gin (to_tsvector('simple', text));

CREATE TABLE knowledge_fact (
  company_id  text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          text NOT NULL,
  status      text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE crm_record (
  company_id  text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          text NOT NULL,
  kind        text NOT NULL,
  version     integer NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE crm_patch (
  company_id  text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          text NOT NULL,
  record_id   text,
  status      text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (company_id, id)
);

COMMIT;
