-- Create one in-app alert for every current community member whenever a
-- governance proposal is created. Keeping this at the database boundary means
-- API, indexer, and administrative proposal creation paths behave consistently.

CREATE OR REPLACE FUNCTION notify_members_on_proposal_created()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO notifications (
    stellar_address,
    community_id,
    type,
    title,
    body,
    metadata
  )
  SELECT
    members.stellar_address,
    NEW.community_id,
    'proposal_created',
    'New proposal: ' || NEW.title,
    COALESCE(NEW.description, 'A new governance proposal is ready for review.'),
    jsonb_build_object(
      'proposalId', NEW.id,
      'proposalType', NEW.type,
      'proposalStatus', NEW.status,
      'votingEndsAt', NEW.voting_ends_at
    )
  FROM members
  WHERE members.community_id = NEW.community_id
    AND members.deleted_at IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL has no CREATE TRIGGER IF NOT EXISTS. Drop/recreate keeps a
-- manually re-run migration idempotent without creating duplicate alerts.
DROP TRIGGER IF EXISTS proposals_notify_members ON proposals;
CREATE TRIGGER proposals_notify_members
  AFTER INSERT ON proposals
  FOR EACH ROW EXECUTE FUNCTION notify_members_on_proposal_created();

COMMENT ON FUNCTION notify_members_on_proposal_created() IS
  'Creates proposal_created notifications for current members of the proposal community.';

