import { GovernanceWorkspace } from './GovernanceWorkspace';

interface PageProps {
  searchParams: Promise<{ communityId?: string }>;
}

export default async function GovernancePage({ searchParams }: PageProps) {
  const { communityId = '' } = await searchParams;
  return <GovernanceWorkspace initialCommunityId={communityId} />;
}
