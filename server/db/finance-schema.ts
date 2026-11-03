/** Kept byte-for-byte with migrations/0004_finance.sql for standalone migrations. */
export const FINANCE_MIGRATION_SQL = String.raw`
-- Owner-scoped financial plans, selected-month versions and registered actuals.
CREATE TABLE IF NOT EXISTS finance_accounts(
  account_id text PRIMARY KEY, owner_id text NOT NULL REFERENCES owners,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  opening_balance_cents bigint CHECK(abs(opening_balance_cents)<=1000000000000),
  opening_balance_date date, external_key text CHECK(length(external_key) BETWEEN 1 AND 200),
  archived_at timestamptz, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,owner_id),UNIQUE(owner_id,external_key),
  CHECK((opening_balance_cents IS NULL)=(opening_balance_date IS NULL))
);
CREATE TABLE IF NOT EXISTS finance_categories(
  category_id text PRIMARY KEY,owner_id text NOT NULL REFERENCES owners,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  external_key text CHECK(length(external_key) BETWEEN 1 AND 200),archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(category_id,owner_id),UNIQUE(owner_id,external_key)
);
CREATE TABLE IF NOT EXISTS finance_plans(
  plan_id text PRIMARY KEY,owner_id text NOT NULL REFERENCES owners,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('recurring','one_off','budget','reserve','liability')),
  account_id text,category_id text,notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  source_label text NOT NULL DEFAULT '' CHECK(length(source_label)<=500),
  external_key text CHECK(length(external_key) BETWEEN 1 AND 200),archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,owner_id),UNIQUE(owner_id,external_key),
  FOREIGN KEY(account_id,owner_id) REFERENCES finance_accounts(account_id,owner_id),
  FOREIGN KEY(category_id,owner_id) REFERENCES finance_categories(category_id,owner_id)
);
CREATE TABLE IF NOT EXISTS finance_plan_versions(
  plan_id text NOT NULL,owner_id text NOT NULL,effective_month text NOT NULL CHECK(effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_cents bigint CHECK(amount_cents BETWEEN 0 AND 1000000000000),
  amount_basis text NOT NULL CHECK(amount_basis IN ('confirmed','reported','estimate','unknown')),
  interval_months integer CHECK(interval_months BETWEEN 1 AND 12),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','reference')),
  included boolean NOT NULL DEFAULT true,due_day integer CHECK(due_day BETWEEN 1 AND 31),
  due_precision text NOT NULL DEFAULT 'unknown' CHECK(due_precision IN ('exact','approximate','unknown')),
  due_on date,next_due_on date,target_cents bigint CHECK(target_cents BETWEEN 0 AND 1000000000000),
  horizon_months integer CHECK(horizon_months BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,plan_id,effective_month),
  FOREIGN KEY(plan_id,owner_id) REFERENCES finance_plans(plan_id,owner_id),
  CHECK((amount_cents IS NULL)=(amount_basis='unknown'))
);
CREATE TABLE IF NOT EXISTS finance_transactions(
  transaction_id text PRIMARY KEY,owner_id text NOT NULL REFERENCES owners,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('expense','income','transfer','refund')),
  posted_on date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000000),
  account_id text,transfer_account_id text,category_id text,plan_id text,
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),source_label text NOT NULL DEFAULT '' CHECK(length(source_label)<=500),
  external_key text CHECK(length(external_key) BETWEEN 1 AND 200),archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,owner_id),UNIQUE(owner_id,external_key),
  FOREIGN KEY(account_id,owner_id) REFERENCES finance_accounts(account_id,owner_id),
  FOREIGN KEY(transfer_account_id,owner_id) REFERENCES finance_accounts(account_id,owner_id),
  FOREIGN KEY(category_id,owner_id) REFERENCES finance_categories(category_id,owner_id),
  FOREIGN KEY(plan_id,owner_id) REFERENCES finance_plans(plan_id,owner_id),
  CHECK((kind='transfer' AND account_id IS NOT NULL AND transfer_account_id IS NOT NULL AND account_id<>transfer_account_id) OR (kind<>'transfer' AND transfer_account_id IS NULL))
);
CREATE INDEX IF NOT EXISTS finance_accounts_owner_idx ON finance_accounts(owner_id,archived_at,account_id);
CREATE INDEX IF NOT EXISTS finance_categories_owner_idx ON finance_categories(owner_id,archived_at,category_id);
CREATE INDEX IF NOT EXISTS finance_plans_owner_idx ON finance_plans(owner_id,archived_at,kind,plan_id);
CREATE INDEX IF NOT EXISTS finance_versions_month_idx ON finance_plan_versions(owner_id,effective_month,plan_id);
CREATE INDEX IF NOT EXISTS finance_transactions_month_idx ON finance_transactions(owner_id,posted_on,transaction_id);
-- The export fallback and explicitly supplied source keys share one namespace.
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_canonical_source_idx ON finance_accounts(owner_id,(COALESCE(external_key,'life-os:'||account_id)));
CREATE UNIQUE INDEX IF NOT EXISTS finance_categories_canonical_source_idx ON finance_categories(owner_id,(COALESCE(external_key,'life-os:'||category_id)));
CREATE UNIQUE INDEX IF NOT EXISTS finance_plans_canonical_source_idx ON finance_plans(owner_id,(COALESCE(external_key,'life-os:'||plan_id)));
CREATE UNIQUE INDEX IF NOT EXISTS finance_transactions_canonical_source_idx ON finance_transactions(owner_id,(COALESCE(external_key,'life-os:'||transaction_id)));
DROP TRIGGER IF EXISTS finance_account_identity ON finance_accounts;
CREATE TRIGGER finance_account_identity BEFORE UPDATE ON finance_accounts FOR EACH ROW EXECUTE FUNCTION protect_entity_identity('account_id');
DROP TRIGGER IF EXISTS finance_category_identity ON finance_categories;
CREATE TRIGGER finance_category_identity BEFORE UPDATE ON finance_categories FOR EACH ROW EXECUTE FUNCTION protect_entity_identity('category_id');
DROP TRIGGER IF EXISTS finance_plan_identity ON finance_plans;
CREATE TRIGGER finance_plan_identity BEFORE UPDATE ON finance_plans FOR EACH ROW EXECUTE FUNCTION protect_entity_identity('plan_id');
DROP TRIGGER IF EXISTS finance_transaction_identity ON finance_transactions;
CREATE TRIGGER finance_transaction_identity BEFORE UPDATE ON finance_transactions FOR EACH ROW EXECUTE FUNCTION protect_entity_identity('transaction_id');
CREATE OR REPLACE FUNCTION protect_finance_source_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_key IS DISTINCT FROM OLD.external_key THEN RAISE EXCEPTION 'Financial source identity is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS finance_account_source_key ON finance_accounts;
CREATE TRIGGER finance_account_source_key BEFORE UPDATE ON finance_accounts FOR EACH ROW EXECUTE FUNCTION protect_finance_source_key();
DROP TRIGGER IF EXISTS finance_category_source_key ON finance_categories;
CREATE TRIGGER finance_category_source_key BEFORE UPDATE ON finance_categories FOR EACH ROW EXECUTE FUNCTION protect_finance_source_key();
DROP TRIGGER IF EXISTS finance_plan_source_key ON finance_plans;
CREATE TRIGGER finance_plan_source_key BEFORE UPDATE ON finance_plans FOR EACH ROW EXECUTE FUNCTION protect_finance_source_key();
DROP TRIGGER IF EXISTS finance_transaction_source_key ON finance_transactions;
CREATE TRIGGER finance_transaction_source_key BEFORE UPDATE ON finance_transactions FOR EACH ROW EXECUTE FUNCTION protect_finance_source_key();
CREATE OR REPLACE FUNCTION protect_finance_version_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.effective_month IS DISTINCT FROM OLD.effective_month THEN RAISE EXCEPTION 'Financial version identity is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS finance_version_identity ON finance_plan_versions;
CREATE TRIGGER finance_version_identity BEFORE UPDATE ON finance_plan_versions FOR EACH ROW EXECUTE FUNCTION protect_finance_version_identity();
CREATE OR REPLACE FUNCTION protect_finance_plan_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'Financial plan kind is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS finance_plan_kind ON finance_plans;
CREATE TRIGGER finance_plan_kind BEFORE UPDATE ON finance_plans FOR EACH ROW EXECUTE FUNCTION protect_finance_plan_kind();
CREATE OR REPLACE FUNCTION validate_finance_version_cadence() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE plan_kind text; BEGIN SELECT kind INTO plan_kind FROM finance_plans WHERE plan_id=NEW.plan_id AND owner_id=NEW.owner_id; IF (plan_kind IN ('budget','reserve') AND NEW.interval_months IS DISTINCT FROM 1) OR (plan_kind IN ('one_off','liability') AND NEW.interval_months IS NOT NULL) THEN RAISE EXCEPTION 'Financial cadence does not match plan kind' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS finance_version_cadence ON finance_plan_versions;
CREATE TRIGGER finance_version_cadence BEFORE INSERT OR UPDATE ON finance_plan_versions FOR EACH ROW EXECUTE FUNCTION validate_finance_version_cadence();
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
`;
