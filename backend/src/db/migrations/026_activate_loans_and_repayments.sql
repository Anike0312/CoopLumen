ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS asset_issuer TEXT,
  ADD COLUMN IF NOT EXISTS amount_repaid NUMERIC(20, 7) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS loan_repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  payer_address TEXT NOT NULL,
  amount NUMERIC(20, 7) NOT NULL CHECK (amount > 0),
  stellar_tx_hash TEXT UNIQUE,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan_paid ON loan_repayments(loan_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_payer ON loan_repayments(payer_address, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_borrower_status ON loans(borrower_address, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_lender_status ON loans(lender_address, status, created_at DESC);

DROP TRIGGER IF EXISTS loans_updated_at ON loans;
CREATE TRIGGER loans_updated_at BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO loan_repayments (loan_id, payer_address, amount, stellar_tx_hash, paid_at, metadata)
SELECT le.loan_id, l.borrower_address, le.amount, p.stellar_tx_hash, le.created_at,
       jsonb_build_object('migratedFrom', 'loan_events', 'loanEventId', le.id)
FROM loan_events le
JOIN loans l ON l.id = le.loan_id
LEFT JOIN payments p ON p.id = le.payment_id
WHERE le.event_type = 'repayment' AND le.amount IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM loan_repayments lr WHERE lr.metadata ->> 'loanEventId' = le.id::text);
