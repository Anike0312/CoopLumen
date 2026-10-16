CREATE TABLE IF NOT EXISTS proposal_delegations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id        UUID        NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  delegator_address  TEXT        NOT NULL,
  delegatee_address  TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT proposal_delegations_delegator_format
    CHECK (delegator_address ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT proposal_delegations_delegatee_format
    CHECK (delegatee_address ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT proposal_delegations_not_self
    CHECK (delegator_address <> delegatee_address),
  CONSTRAINT proposal_delegations_unique_delegator
    UNIQUE (proposal_id, delegator_address)
);

CREATE INDEX IF NOT EXISTS idx_proposal_delegations_delegatee
  ON proposal_delegations(proposal_id, delegatee_address);

DROP TRIGGER IF EXISTS proposal_delegations_updated_at ON proposal_delegations;
CREATE TRIGGER proposal_delegations_updated_at
  BEFORE UPDATE ON proposal_delegations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE proposal_delegations IS
  'Proposal-scoped assignment of one active member voting on behalf of another.';
