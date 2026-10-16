DROP INDEX IF EXISTS idx_kyc_records_address_updated;
ALTER TABLE kyc_records
  DROP CONSTRAINT IF EXISTS kyc_records_stellar_address_format;

COMMENT ON TABLE kyc_records IS
  'Per-community KYC verification state prepared for a future integration.';
COMMENT ON COLUMN kyc_records.stellar_address IS NULL;
