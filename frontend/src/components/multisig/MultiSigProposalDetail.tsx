'use client';

import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { StellarAddress } from '../ui/StellarAddress';
import { ProgressBar } from '../ui/ProgressBar';
import { Alert } from '../ui/Alert';
import { Table } from '../ui/Table';
import type { MultiSigRequest, MultiSigSignerStatus } from '@/hooks/useMultiSig';
import styles from './MultiSigProposalDetail.module.css';
import { sanitizeUserText } from '@/lib/sanitize';

export interface MultiSigProposalDetailProps {
  request: MultiSigRequest;
  onApprove?: (signedXdr?: string) => Promise<void> | void;
  onReject?: (reason?: string) => Promise<void> | void;
  onExecute?: (txHash: string) => Promise<void> | void;
  userAddress?: string;
  className?: string;
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: 'warning',
  approved: 'info',
  executed: 'success',
  rejected: 'error',
  expired: 'neutral',
  cancelled: 'neutral',
};

function formatActionLabel(action: string): string {
  return action
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function MultiSigProposalDetail({
  request,
  onApprove,
  onReject,
  onExecute,
  userAddress,
  className,
}: MultiSigProposalDetailProps) {
  const [loading, setLoading] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [showExecuteForm, setShowExecuteForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending = request.status === 'pending';
  const isApproved = request.status === 'approved';
  const isExecuted = request.status === 'executed';
  const isRejected = request.status === 'rejected';

  const userSigner = request.signers?.find(
    (s) => s.address.toLowerCase() === userAddress?.toLowerCase()
  );
  const userHasSigned = userSigner?.signed ?? false;

  const handleApprove = async () => {
    if (!onApprove) return;
    setLoading(true);
    setError(null);
    try {
      await onApprove();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to approve proposal');
    } finally {
      setLoading(false);
    }
  };

  const handleRejectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onReject) return;
    setLoading(true);
    setError(null);
    try {
      await onReject(rejectReason.trim() || undefined);
      setShowRejectForm(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reject proposal');
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onExecute) return;
    setLoading(true);
    setError(null);
    try {
      await onExecute(txHash.trim());
      setShowExecuteForm(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to execute proposal');
    } finally {
      setLoading(false);
    }
  };

  const signerRows = request.signers ?? [];

  return (
    <Card className={[styles.container, className].filter(Boolean).join(' ')}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h2 className={styles.title}>{sanitizeUserText(request.title)}</h2>
          <div className={styles.badgeGroup}>
            <Badge variant="neutral" size="sm">
              {formatActionLabel(request.action)}
            </Badge>
            <Badge variant={STATUS_VARIANT[request.status] ?? 'neutral'} size="sm" dot>
              {request.status.toUpperCase()}
            </Badge>
          </div>
        </div>
      </div>

      {request.description && (
        <p className={styles.description}>{sanitizeUserText(request.description)}</p>
      )}

      {error && <Alert variant="error">{error}</Alert>}
      {isRejected && request.rejection_reason && (
        <Alert variant="error" title="Rejection Reason">
          {request.rejection_reason}
        </Alert>
      )}

      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Proposer</span>
          <StellarAddress address={request.proposer_address} />
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Created At</span>
          <span className={styles.metaValue}>
            {new Date(request.created_at).toLocaleDateString()}
          </span>
        </div>
        {request.expires_at && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Expires At</span>
            <span className={styles.metaValue}>
              {new Date(request.expires_at).toLocaleDateString()}
            </span>
          </div>
        )}
        {request.executed_at && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Executed At</span>
            <span className={styles.metaValue}>
              {new Date(request.executed_at).toLocaleDateString()}
            </span>
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Signature Progress</h3>
        <ProgressBar
          label="Required Signatures"
          value={request.current_signatures}
          max={request.required_signatures}
          showValue
          valueFormatter={(val, max) => `${val} of ${max} signatures`}
          variant={
            request.current_signatures >= request.required_signatures ? 'success' : 'primary'
          }
        />
      </div>

      {signerRows.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Signers ({signerRows.length})</h3>
          <Table
            columns={[
              {
                key: 'address',
                label: 'Signer Address',
                render: (_, signer) => <StellarAddress address={signer.address} />,
              },
              {
                key: 'role',
                label: 'Role',
                render: (_, signer) => signer.role ?? 'Signer',
              },
              {
                key: 'signed',
                label: 'Status',
                render: (_, signer) =>
                  signer.signed ? (
                    <Badge variant="success" size="sm">
                      Signed
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="sm">
                      Pending
                    </Badge>
                  ),
              },
              {
                key: 'signed_at',
                label: 'Date Signed',
                render: (_, signer) =>
                  signer.signed_at ? new Date(signer.signed_at).toLocaleDateString() : '-',
              },
            ]}
            data={signerRows as Array<MultiSigSignerStatus & Record<string, unknown>>}
            ariaLabel="Signers table"
            className={styles.signersTable}
          />
        </div>
      )}

      {Object.keys(request.payload || {}).length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Proposal Details / Payload</h3>
          <pre className={styles.payloadPre}>{JSON.stringify(request.payload, null, 2)}</pre>
        </div>
      )}

      {request.stellar_tx_hash && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Stellar Transaction Hash</h3>
          <code className={styles.metaValue}>{request.stellar_tx_hash}</code>
        </div>
      )}

      {/* Action Forms */}
      {showRejectForm && (
        <form onSubmit={handleRejectSubmit} className={styles.actionForm}>
          <label htmlFor="rejectReason" className={styles.metaLabel}>
            Reason for Rejection (Optional)
          </label>
          <input
            id="rejectReason"
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Enter reason..."
            style={{
              padding: '0.5rem',
              borderRadius: '0.25rem',
              border: '1px solid #ccc',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowRejectForm(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="danger" size="sm" isLoading={loading}>
              Confirm Rejection
            </Button>
          </div>
        </form>
      )}

      {showExecuteForm && (
        <form onSubmit={handleExecuteSubmit} className={styles.actionForm}>
          <label htmlFor="txHashInput" className={styles.metaLabel}>
            Stellar Transaction Hash
          </label>
          <input
            id="txHashInput"
            type="text"
            required
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
            placeholder="Enter Stellar TX Hash..."
            style={{
              padding: '0.5rem',
              borderRadius: '0.25rem',
              border: '1px solid #ccc',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowExecuteForm(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" isLoading={loading}>
              Confirm Execution
            </Button>
          </div>
        </form>
      )}

      {/* Actions toolbar */}
      {!showRejectForm && !showExecuteForm && (
        <div className={styles.actions}>
          {isPending && onReject && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setShowRejectForm(true)}
              disabled={loading || isExecuted || isRejected}
            >
              Reject
            </Button>
          )}

          {isPending && onApprove && (
            <Button
              variant="primary"
              size="md"
              onClick={handleApprove}
              isLoading={loading}
              disabled={userHasSigned || isExecuted || isRejected}
            >
              {userHasSigned ? 'Already Signed' : 'Approve & Sign'}
            </Button>
          )}

          {isApproved && onExecute && (
            <Button
              variant="secondary"
              size="md"
              onClick={() => setShowExecuteForm(true)}
              disabled={loading || isExecuted}
            >
              Execute Proposal
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
