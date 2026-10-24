CREATE TABLE IF NOT EXISTS work_contract_policies(
  policy_id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners,
  employer text NOT NULL CHECK(length(employer)>0 AND length(employer)<=200),
  effective_from date NOT NULL,
  effective_to date,
  policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  UNIQUE(policy_id,owner_id)
);
CREATE INDEX IF NOT EXISTS work_contract_policies_owner_employer_idx
  ON work_contract_policies(owner_id,employer,effective_from);
