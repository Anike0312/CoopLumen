# Governance

CoopLumen's governance contract provides token-weighted proposals and voting on
Soroban. Proposal state, ballots, tallies, and lifecycle transitions are stored
by the contract, so the result does not depend on a backend making the final
decision.

The implementation lives in `contracts/governance/src/lib.rs`. The PostgreSQL
`proposals` and `votes` tables are intended for indexing and application reads;
they are not the authority for an on-chain outcome.

## Contract configuration

`initialize(admin, governance_token, voting_period, quorum_bps, total_supply)`
can be called once. It stores:

| Field              | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `admin`            | Governance administrator address recorded in the configuration.     |
| `governance_token` | Soroban token contract used to read each voter's balance.           |
| `voting_period`    | Number of seconds each new proposal remains open.                   |
| `quorum_bps`       | Minimum participation in basis points, from `0` to `10_000`.        |
| `total_supply`     | Quorum denominator supplied at initialization. It must be positive. |

The Soroban token interface used by the contract has no total-supply method, so
the configured `total_supply` is trusted. Deployers must set it to the intended
governance-token supply and redeploy if that assumption changes.

## Proposal lifecycle

```text
create_proposal
       |
       v
    Active -- voting window closes --> finalize_proposal
                                      /               \
                                     v                 v
                                  Passed            Rejected
                                     |
                                     | quorum met
                                     v
                             execute_proposal
                                     |
                                     v
                                  Executed
```

### 1. Create

`create_proposal(proposer, title, description, actions)` requires authorization
from `proposer`. It assigns the next numeric proposal ID and stores an `Active`
proposal with zero tallies. The voting window starts at the current ledger
timestamp and ends at `created_at + voting_period`.

The title must be non-empty. `actions` is a list of opaque strings such as
`disburse_treasury:500`; the contract stores these values without interpreting
their format.

### 2. Vote

`cast_vote(proposal_id, choice, voter)` requires authorization from `voter` and
reads the voter's current balance from the configured governance-token
contract. That full balance becomes the vote weight.

A voter may vote `For` or `Against` once per proposal. A vote is rejected when:

- the proposal does not exist or is no longer active;
- the ledger timestamp is later than `voting_ends_at`;
- the address has already voted; or
- the token balance is zero or negative.

The contract persists both the individual ballot and the updated aggregate
tally. Voting at the exact `voting_ends_at` timestamp is allowed; finalization
becomes available on the next timestamp.

### 3. Finalize

After the voting window, anyone may call `finalize_proposal(proposal_id)`.
The proposal becomes `Passed` only when `votes_for` is greater than
`votes_against`; a tie and an against majority become `Rejected`.

Finalization determines the vote result but does not enforce quorum. Quorum is
checked immediately before execution.

### 4. Execute

`execute_proposal(proposal_id, executor)` requires authorization from
`executor`. Any address may execute a proposal when both conditions hold:

1. the proposal status is `Passed`; and
2. total participation meets the configured quorum.

The quorum calculation is:

```text
participation = votes_for + votes_against
required      = total_supply * quorum_bps / 10_000
```

Integer division is used. Once the checks pass, the status changes to
`Executed`. For every non-empty action, the contract publishes a `prop_exec`
event containing the proposal ID and action string. An empty action publishes
an `exec_fail` event instead.

The current implementation does not dispatch cross-contract calls. Off-chain
executors or indexers must consume the events and perform any domain-specific
work. Because the status is already `Executed`, the proposal cannot be run a
second time.

## Read interface

- `get_config()` returns the singleton configuration.
- `get_proposal(proposal_id)` returns proposal metadata, tallies, status, and
  voting timestamps without authentication or state changes.
- `get_vote(proposal_id, voter)` returns the stored ballot for that address.

Contract storage uses a separate key for configuration, the proposal counter,
each proposal, and each `(proposal_id, voter)` ballot. A proposal read therefore
does not scan other proposals.

## Errors

| Code | Name                      | Meaning                                                    |
| ---- | ------------------------- | ---------------------------------------------------------- |
| `1`  | `AlreadyInitialized`      | Configuration already exists.                              |
| `2`  | `NotInitialized`          | A configured contract is required.                         |
| `3`  | `InvalidInput`            | Initialization values or proposal title are invalid.       |
| `4`  | `ProposalNotFound`        | The proposal or requested ballot is absent.                |
| `5`  | `ProposalNotActive`       | Voting or finalization requires an active proposal.        |
| `6`  | `VotingPeriodEnded`       | Voting has ended, or finalization was attempted too early. |
| `7`  | `AlreadyVoted`            | The voter already has a ballot for the proposal.           |
| `8`  | `NoVotingPower`           | The governance-token balance is not positive.              |
| `9`  | `Overflow`                | Checked arithmetic could not represent the result.         |
| `10` | `InsufficientQuorum`      | Participation is below the execution threshold.            |
| `11` | `ProposalExecutionFailed` | The proposal is not in `Passed` status.                    |

## Off-chain data

The backend migrations create `proposals` and `votes` tables for searchable
metadata and indexed reads. They enforce proposal types and statuses, voting
windows, Stellar-address formats, and one ballot per voter. These tables do not
replace Soroban state and, at present, are not synchronized by an event indexer.
Code that decides whether a proposal passed or executed must read the contract
or a projection whose ledger position is known.

## Development and verification

Run the contract suite from the repository root:

```bash
cargo test -p cooplumen-governance
cargo fmt --check -p cooplumen-governance
```

The tests register a Stellar asset contract, mint governance tokens to test
addresses, and exercise token-weighted voting, lifecycle guards, quorum, and
proposal reads with Soroban test utilities.
