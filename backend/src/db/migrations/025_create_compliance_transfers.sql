CREATE TABLE IF NOT EXISTS compliance_transfers (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID           NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  stellar_address   TEXT           NOT NULL,
  asset_code        TEXT           NOT NULL,
  asset_issuer      TEXT           NOT NULL,
  amount            NUMERIC(20, 7) NOT NULL,
  status            TEXT           NOT NULL DEFAULT 'reserved',
  stellar_tx_hash   TEXT           UNIQUE,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT compliance_transfers_address_check CHECK (
    stellar_address ~ '^G[A-Z2-7]{55}$'
  ),
  CONSTRAINT compliance_transfers_amount_check CHECK (amount > 0),
  CONSTRAINT compliance_transfers_status_check CHECK (
    status IN ('reserved', 'submitted', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_compliance_transfers_daily_usage
  ON compliance_transfers (community_id, stellar_address, created_at)
  WHERE status IN ('reserved', 'submitted');

DROP TRIGGER IF EXISTS compliance_transfers_updated_at ON compliance_transfers;
CREATE TRIGGER compliance_transfers_updated_at
  BEFORE UPDATE ON compliance_transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE compliance_transfers IS
  'Transfer reservations used to enforce daily limits for community-token accounts that are not KYC verified.';
