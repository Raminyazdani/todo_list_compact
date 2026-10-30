-- Additive personal routines migration. The runtime schema source is server/db/schema.ts.
CREATE TABLE IF NOT EXISTS routines(
  routine_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners,
  title text NOT NULL CHECK(length(btrim(title))>0 AND length(title)<=200),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  start_date date NOT NULL,
  weekdays smallint[] NOT NULL DEFAULT '{}',
  time_of_day text CHECK(time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text NOT NULL DEFAULT 'Europe/Berlin' CHECK(timezone='Europe/Berlin'),
  enabled boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(routine_id,owner_id),
  CHECK(cardinality(weekdays)<=7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);
CREATE INDEX IF NOT EXISTS routines_owner_active_idx ON routines(owner_id,archived_at,enabled,start_date,routine_id);
CREATE TABLE IF NOT EXISTS routine_schedules(
  owner_id text NOT NULL,
  routine_id text NOT NULL,
  effective_date date NOT NULL,
  start_date date NOT NULL,
  weekdays smallint[] NOT NULL DEFAULT '{}',
  time_of_day text CHECK(time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  PRIMARY KEY(owner_id,routine_id,effective_date),
  FOREIGN KEY(routine_id,owner_id) REFERENCES routines(routine_id,owner_id),
  CHECK(cardinality(weekdays)<=7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);
CREATE TABLE IF NOT EXISTS routine_checkins(
  owner_id text NOT NULL,
  routine_id text NOT NULL,
  local_date date NOT NULL,
  done boolean NOT NULL,
  checked_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,routine_id,local_date),
  FOREIGN KEY(routine_id,owner_id) REFERENCES routines(routine_id,owner_id),
  CHECK((done AND checked_at IS NOT NULL) OR (NOT done AND checked_at IS NULL))
);
CREATE INDEX IF NOT EXISTS routine_checkins_history_idx ON routine_checkins(owner_id,routine_id,local_date DESC);
DROP TRIGGER IF EXISTS routine_identity_immutable ON routines;
CREATE TRIGGER routine_identity_immutable BEFORE UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION protect_entity_identity('routine_id');
CREATE OR REPLACE FUNCTION protect_routine_schedule_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.routine_id IS DISTINCT FROM OLD.routine_id OR NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN RAISE EXCEPTION 'Routine schedule identity is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS routine_schedule_identity_immutable ON routine_schedules;
CREATE TRIGGER routine_schedule_identity_immutable BEFORE UPDATE ON routine_schedules FOR EACH ROW EXECUTE FUNCTION protect_routine_schedule_identity();
CREATE OR REPLACE FUNCTION protect_routine_checkin_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.routine_id IS DISTINCT FROM OLD.routine_id OR NEW.local_date IS DISTINCT FROM OLD.local_date THEN RAISE EXCEPTION 'Routine check-in identity is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS routine_checkin_identity_immutable ON routine_checkins;
CREATE TRIGGER routine_checkin_identity_immutable BEFORE UPDATE ON routine_checkins FOR EACH ROW EXECUTE FUNCTION protect_routine_checkin_identity();
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
