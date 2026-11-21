'use client';

import Link from 'next/link';
import type { Community } from '@/hooks/useCommunities';
import styles from './CommunityCard.module.css';
import { sanitizeUserText } from '@/lib/sanitize';

/**
 * A community as rendered on the discovery page: the API shape plus the
 * discovery-only metrics the list endpoint layers on top of it.
 */
export type DiscoverableCommunity = Community & {
  member_count?: number;
  token_count?: number;
  is_joined?: boolean;
};

interface Props {
  community: DiscoverableCommunity;
  onJoin?: (id: string) => void;
}

export function CommunityCard({ community, onJoin }: Props): React.JSX.Element {
  const createdDate = new Date(community.created_at).toLocaleDateString();

  // Fall back to the issuer key while the API is still filling in ids.
  const communityId = community.id || community.issuer_public_key;

  const handleJoinClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault(); // Prevents the card's Link wrapper from routing
    e.stopPropagation();
    if (onJoin) onJoin(communityId);
  };

  return (
    <article className={styles.card}>
      <Link
        href={`/communities/${communityId}`}
        className={styles.linkOverlay}
        aria-label={`View details for ${community.name}`}
      />

      <div className={styles.content}>
        <div className={styles.header}>
          <h3 className={styles.name}>{sanitizeUserText(community.name)}</h3>
          <span className={styles.token}>{community.asset_code}</span>
        </div>

        {community.description && (
          <p className={styles.description}>{sanitizeUserText(community.description)}</p>
        )}

        <div className={styles.meta}>
          <span>Issuer: {community.issuer_public_key.slice(0, 8)}…</span>
          <span>Created {createdDate}</span>
        </div>

        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{community.member_count ?? 0}</span>
            <span className={styles.metricLabel}> Members</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{community.token_count ?? 0}</span>
            <span className={styles.metricLabel}> Tokens</span>
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          onClick={handleJoinClick}
          disabled={community.is_joined}
          className={community.is_joined ? styles.buttonJoined : styles.buttonJoin}
          aria-label={community.is_joined ? `Joined ${community.name}` : `Join ${community.name}`}
        >
          {community.is_joined ? 'Joined' : 'Join Community'}
        </button>
      </div>
    </article>
  );
}
