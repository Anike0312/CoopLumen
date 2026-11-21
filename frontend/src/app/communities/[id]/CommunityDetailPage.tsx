'use client';

import Link from 'next/link';
import { useCommunity } from '@/hooks/useCommunities';
import { useCommunityMembers } from '@/hooks/useCommunityMembers';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { Alert } from '@/components/ui/Alert';
import { StellarAddress } from '@/components/ui/StellarAddress';
import { MemberList } from '@/components/community/MemberList';
import styles from './CommunityDetailPage.module.css';
import { sanitizeUserText } from '@/lib/sanitize';

interface Props {
  /** The community ID extracted from the dynamic route segment. */
  communityId: string;
}

/**
 * Client component that fetches and renders the community detail view.
 *
 * Separated from the page shell so unit tests can render it directly without
 * mocking the Next.js `params` resolution.
 *
 * Accessibility:
 * - The page has a single `<h1>` (the community name) for correct heading
 *   hierarchy; the Members section carries its own `<h2>`.
 * - Back navigation uses a visible `:focus-visible` ring via the global rule.
 * - Loading states are announced by the Spinner and LoadingSkeleton live
 *   regions; the error state uses `role="alert"` (delegated to Alert).
 * - `<time>` elements carry `dateTime` attributes for machine-readable dates.
 */
export function CommunityDetailPage({ communityId }: Props) {
  const {
    data: community,
    error: communityError,
    isLoading: communityLoading,
  } = useCommunity(communityId);

  const {
    data: members,
    error: membersError,
    isLoading: membersLoading,
  } = useCommunityMembers(communityId);

  /* Full-page loading state */
  if (communityLoading) {
    return (
      <main className={styles.page} aria-label="Community detail">
        <div className={styles.inner}>
          <div className={styles.centred}>
            <Spinner size="lg" label="Loading community…" />
          </div>
        </div>
      </main>
    );
  }

  /* Community fetch error */
  if (communityError || !community) {
    return (
      <main className={styles.page} aria-label="Community detail">
        <div className={styles.inner}>
          <Link href="/communities" className={styles.backLink}>
            <span className={styles.backArrow} aria-hidden="true" />
            Back to communities
          </Link>
          <div className={styles.errorWrap}>
            <Alert variant="error" title="Community not found">
              {communityError
                ? communityError.message
                : 'This community does not exist or could not be loaded.'}
            </Alert>
          </div>
        </div>
      </main>
    );
  }

  const createdDate = new Date(community.created_at).toLocaleDateString();

  return (
    <main className={styles.page} aria-label={`${community.name} community detail`}>
      <div className={styles.inner}>
        {/* Back navigation */}
        <Link href="/communities" className={styles.backLink}>
          <span className={styles.backArrow} aria-hidden="true" />
          Back to communities
        </Link>

        <div className={styles.grid}>
          {/* Left column: hero card */}
          <div>
            <Card>
              <div className={styles.heroCard}>
                {/* Heading + token badge */}
                <div className={styles.heroHeader}>
                  <h1 className={styles.communityName}>{sanitizeUserText(community.name)}</h1>
                  <span className={styles.assetBadge} aria-label={`Token: ${community.asset_code}`}>
                    {community.asset_code}
                  </span>
                </div>

                {/* Optional description */}
                {community.description && (
                  <p className={styles.description}>{sanitizeUserText(community.description)}</p>
                )}

                {/* Key stats */}
                <dl className={styles.statsRow}>
                  <div className={styles.stat}>
                    <dt className={styles.statLabel}>Created</dt>
                    <dd className={styles.statValue}>
                      <time dateTime={community.created_at}>{createdDate}</time>
                    </dd>
                  </div>

                  <div className={styles.stat}>
                    <dt className={styles.statLabel}>Asset issuer</dt>
                    <dd className={styles.statValue}>
                      <StellarAddress
                        address={community.asset_issuer}
                        startLength={6}
                        endLength={4}
                      />
                    </dd>
                  </div>

                  <div className={styles.stat}>
                    <dt className={styles.statLabel}>Issuer key</dt>
                    <dd className={`${styles.statValue} ${styles.statValueMono}`}>
                      <StellarAddress
                        address={community.issuer_public_key}
                        startLength={6}
                        endLength={4}
                      />
                    </dd>
                  </div>

                  <div className={styles.stat}>
                    <dt className={styles.statLabel}>Community ID</dt>
                    <dd className={`${styles.statValue} ${styles.statValueMono}`}>
                      {community.id}
                    </dd>
                  </div>
                </dl>
              </div>
            </Card>
          </div>

          {/* Right column: member roster */}
          <div>
            <Card>
              <MemberList
                members={members}
                isLoading={membersLoading}
                error={membersError as Error | undefined}
              />
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
