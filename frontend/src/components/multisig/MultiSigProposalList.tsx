'use client';

import React, { useState, useRef, useId } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { StellarAddress } from '@/components/ui/StellarAddress';
import styles from './MultiSigProposalList.module.css';
import { sanitizeUserText } from '@/lib/sanitize';

export type ProposalStatus = 'pending' | 'executed' | 'rejected';

export interface MultiSigProposal {
  id: string;
  title: string;
  description?: string;
  status: ProposalStatus;
  amount: string;
  assetCode: string;
  targetAddress: string;
  signaturesCount: number;
  requiredSignatures: number;
  createdAt: string;
  creatorAddress?: string;
}

export interface MultiSigProposalListProps {
  proposals: MultiSigProposal[];
  onSign?: (proposalId: string) => void;
  onExecute?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
  isLoading?: boolean;
}

const TABS: Array<{ key: ProposalStatus; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'executed', label: 'Executed' },
  { key: 'rejected', label: 'Rejected' },
];

export function MultiSigProposalList({
  proposals = [],
  onSign,
  onExecute,
  onReject,
  isLoading = false,
}: MultiSigProposalListProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ProposalStatus>('pending');
  const baseId = useId();
  const tabRefs = useRef<Record<ProposalStatus, HTMLButtonElement | null>>({
    pending: null,
    executed: null,
    rejected: null,
  });

  const countByStatus = {
    pending: proposals.filter((p) => p.status === 'pending').length,
    executed: proposals.filter((p) => p.status === 'executed').length,
    rejected: proposals.filter((p) => p.status === 'rejected').length,
  };

  const filteredProposals = proposals.filter((p) => p.status === activeTab);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, currentTab: ProposalStatus) => {
    const tabKeys: ProposalStatus[] = ['pending', 'executed', 'rejected'];
    const currentIndex = tabKeys.indexOf(currentTab);
    let nextIndex = -1;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % tabKeys.length;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + tabKeys.length) % tabKeys.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = tabKeys.length - 1;
    }

    if (nextIndex >= 0) {
      const nextTab = tabKeys[nextIndex];
      setActiveTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  const getStatusBadgeVariant = (status: ProposalStatus) => {
    switch (status) {
      case 'executed':
        return 'success';
      case 'rejected':
        return 'error';
      case 'pending':
      default:
        return 'warning';
    }
  };

  return (
    <div className={styles.container} data-testid="multisig-proposal-list">
      {/* Accessible Tab List */}
      <div role="tablist" aria-label="MultiSig Proposal Status Filter" className={styles.tabList}>
        {TABS.map(({ key, label }) => {
          const isActive = activeTab === key;
          const tabId = `${baseId}-tab-${key}`;
          const panelId = `${baseId}-panel-${key}`;

          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(key)}
              onKeyDown={(e) => handleKeyDown(e, key)}
              data-testid={`tab-${key}`}
            >
              <span>{label}</span>
              <span className={styles.badgeCount} aria-hidden="true">
                {countByStatus[key]}
              </span>
              <span className="sr-only">
                ({countByStatus[key]} {label.toLowerCase()} proposals)
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab Panel */}
      <div
        id={`${baseId}-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        tabIndex={0}
        className={styles.tabPanel}
        data-testid={`tabpanel-${activeTab}`}
      >
        {isLoading ? (
          <div className={styles.emptyState}>Loading proposals...</div>
        ) : filteredProposals.length === 0 ? (
          <div className={styles.emptyState} data-testid="empty-state">
            <p>No {activeTab} multi-sig proposals found.</p>
          </div>
        ) : (
          <ul className={styles.proposalList}>
            {filteredProposals.map((proposal) => {
              const formattedDate = new Date(proposal.createdAt).toLocaleDateString();
              const hasMetThreshold = proposal.signaturesCount >= proposal.requiredSignatures;

              return (
                <li
                  key={proposal.id}
                  className={styles.card}
                  data-testid={`proposal-card-${proposal.id}`}
                >
                  <div className={styles.cardHeader}>
                    <div>
                      <h3 className={styles.cardTitle}>{sanitizeUserText(proposal.title)}</h3>
                      {proposal.description && (
                        <p className={styles.description}>
                          {sanitizeUserText(proposal.description)}
                        </p>
                      )}
                    </div>
                    <Badge variant={getStatusBadgeVariant(proposal.status)}>
                      {proposal.status.toUpperCase()}
                    </Badge>
                  </div>

                  <div className={styles.detailsGrid}>
                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Amount</span>
                      <span className={styles.detailValue}>
                        {proposal.amount} {proposal.assetCode}
                      </span>
                    </div>

                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Target Address</span>
                      <span className={styles.detailValue}>
                        <StellarAddress address={proposal.targetAddress} />
                      </span>
                    </div>

                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Signatures</span>
                      <div className={styles.detailValue}>
                        <span>
                          {proposal.signaturesCount} / {proposal.requiredSignatures}
                        </span>
                        <ProgressBar
                          value={proposal.signaturesCount}
                          max={proposal.requiredSignatures}
                          size="sm"
                        />
                      </div>
                    </div>

                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Created</span>
                      <span className={styles.detailValue}>{formattedDate}</span>
                    </div>
                  </div>

                  {/* Actions for Pending Proposals */}
                  {proposal.status === 'pending' && (
                    <div className={styles.actions}>
                      {onReject && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onReject(proposal.id)}
                          data-testid={`reject-btn-${proposal.id}`}
                        >
                          Reject
                        </Button>
                      )}

                      {!hasMetThreshold && onSign && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onSign(proposal.id)}
                          data-testid={`sign-btn-${proposal.id}`}
                        >
                          Sign Proposal
                        </Button>
                      )}

                      {hasMetThreshold && onExecute && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onExecute(proposal.id)}
                          data-testid={`execute-btn-${proposal.id}`}
                        >
                          Execute Disbursement
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default MultiSigProposalList;
