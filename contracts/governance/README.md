# CoopLumen Governance contract

Soroban smart contract behind on-chain community governance: members create
proposals and cast votes whose weight is their balance of a configured
governance token, and the resulting proposal records are read straight off the
chain instead of from a backend that has to be trusted.

- **Crate:** `cooplumen-governance` (`contracts/governance`)
- **SDK:** `soroban-sdk` 27.0.6
- **Workspace member:** declared in the root `Cargo.toml`

## Data model

| Type             | Fields                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config`         | `admin`, `governance_token`, `voting_period` (seconds), `quorum_bps` (basis points, at most `10_000`), `total_supply`                             |
| `Proposal`       | `proposal_id`, `proposer`, `title`, `description`, `actions: Vec<String>`, `votes_for`, `votes_against`, `status`, `created_at`, `voting_ends_at` |
| `Vote`           | `voter`, `choice`, `weight`                                                                                                                       |
| `ProposalStatus` | `Active`, `Passed`, `Rejected`, `Executed`                                                                                                        |
| `VoteChoice`     | `For`, `Against`                                                                                                                                  |
| Type                  | Fields                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config`              | `admin`, `governance_token`, `voting_period` (seconds), `quorum_bps` (basis points, at most `10_000`)                                             |
| `Proposal`            | `proposal_id`, `proposer`, `title`, `description`, `actions: Vec<String>`, `votes_for`, `votes_against`, `status`, `created_at`, `voting_ends_at` |
| `Vote`                | `voter`, `choice`, `weight`                                                                                                                       |
| `GovernanceAnalytics` | Proposal counts, total voting power cast, turnout, average quorum, and pass rate                                                                  |
| `ProposalStatus`      | `Active`, `Passed`, `Rejected`, `Executed`                                                                                                        |
| `VoteChoice`          | `For`, `Against`                                                                                                                                  |

State is addressed through the `DataKey` enum:

| Key                      | Holds                                                |
| ------------------------ | ---------------------------------------------------- |
| `Config`                 | The deployed `Config`                                |
| `Proposal(u64)`          | One `Proposal`, keyed by its proposal id             |
| `Vote(u64, Address)`     | One `Vote`, keyed by proposal id and voter           |
| `VoteUsed(u64, Address)` | Whether an address's power was counted in a proposal |
| `Delegation(Address)`    | The delegatee selected by an address                 |
| `Delegators(Address)`    | Addresses represented by a delegatee                 |
| `ProposalCount`          | The last assigned `proposal_id`                      |

Every record is keyed individually, so a lookup by `proposal_id` neither scans
nor disturbs any other proposal's record.

## Interface

### `initialize(admin, governance_token, voting_period, quorum_bps, total_supply)`

Writes the singleton `Config`. Fails with `AlreadyInitialized` if the contract
was already initialized, and with `InvalidInput` when `voting_period` is zero,
`quorum_bps` exceeds `10_000`, or `total_supply` is not positive. Initialization
does not currently require authorization, so deployments must initialize
immediately.

### `create_proposal(proposer, title, description, actions) -> u64`

Requires `proposer` auth, assigns the next `proposal_id`, stamps `created_at`
from the ledger timestamp and `voting_ends_at` as
`created_at + voting_period`, and stores the proposal as `Active`. Fails with
`NotInitialized` before `initialize` and with `InvalidInput` on an empty title.

### `cast_vote(proposal_id, choice, voter)`

Requires `voter` auth, reads the caller's balance and the current balances of
accounts delegated to it, and adds that combined governance-token weight to the
tally for `choice`. Every represented address is consumed for that proposal so
its balance cannot be counted again. A delegator must revoke before voting
directly. The guards run before any write, so a rejected vote leaves no partial
state behind.

### `delegate(delegator, delegatee)`

Requires `delegator` auth and delegates its current governance-token voting
power to `delegatee`. Delegation is one hop: self-delegation, cycles, and
delegating onward from an account that represents someone else are rejected.
Balances are resolved when a ballot is cast, so later token transfers are
reflected in the represented weight.

### `undelegate(delegator)`

Requires `delegator` auth and removes its active delegation. The account can
then vote directly on proposals where its power has not already been counted.

### `get_delegation(delegator) -> Option<Address>`

Returns the address currently receiving the account's voting power.

### `get_delegators(delegatee) -> Vec<Address>`

Returns all accounts currently represented by the delegatee.

### `get_config() -> Config`

Returns the active `Config`, or `NotInitialized`.

### `finalize_proposal(proposal_id) -> ProposalStatus`

After the voting window closes, transitions an active proposal to `Passed` when
`votes_for > votes_against`; ties and against majorities become `Rejected`.

### `execute_proposal(proposal_id, executor)`

Requires `executor` auth and a passed proposal whose participation meets the
configured quorum. The current implementation records each opaque action as a
`prop_exec` event for an off-chain executor; it does not dispatch
cross-contract calls.

### `get_proposal(proposal_id) -> Proposal`

The read side of the contract, and the view the off-chain layers surface:

- Returns the proposal's `proposer`, `title`, `description`, encoded `actions`,
  the running `votes_for` / `votes_against` tallies, the lifecycle `status` and
  the `created_at` / `voting_ends_at` voting window.
- Requires no auth and mutates no state, so it is safe to call from a
  simulation or read-only invocation.
- Errors:
  - `NotInitialized` if the contract has not been initialized yet — the same
    error `get_config` returns, which lets a caller distinguish "not deployed
    yet" from "no such proposal".
  - `ProposalNotFound` if the contract is initialized but `proposal_id` was
    never assigned.

### `get_vote(proposal_id, voter) -> Vote`

Returns the `Vote` that `voter` cast on `proposal_id`.

### `get_analytics() -> GovernanceAnalytics`

Returns aggregate metrics computed directly from on-chain proposal records:

- `voter_turnout_bps` is average token participation across every proposal,
  including active ballots so live dashboards move as votes arrive.
- `average_quorum_bps` is average token participation across finalized
  proposals only.
- `proposal_pass_rate_bps` is the share of finalized proposals that passed;
  executed proposals remain successful outcomes.

All rates use basis points (`10_000` = 100%). Participation for an individual
proposal is capped at 100% in analytics, preventing token movement between
ballots from producing a misleading percentage above the configured supply.
Empty collections return zero-valued rates rather than failing division.

## Errors

| Code | Name                      | Raised when                                                     |
| ---- | ------------------------- | --------------------------------------------------------------- |
| 1    | `AlreadyInitialized`      | `initialize` is called on an initialized contract               |
| 2    | `NotInitialized`          | Any call before `initialize`                                    |
| 3    | `InvalidInput`            | Empty title, zero voting period, or quorum above `10_000` bps   |
| 4    | `ProposalNotFound`        | Unknown `proposal_id`, or no vote from that voter on a proposal |
| 5    | `ProposalNotActive`       | Voting on a proposal whose status is no longer `Active`         |
| 6    | `VotingPeriodEnded`       | Voting after `voting_ends_at`                                   |
| 7    | `AlreadyVoted`            | The same address voting twice on one proposal                   |
| 8    | `NoVotingPower`           | The voter's governance-token balance is zero                    |
| 9    | `Overflow`                | Counter or tally arithmetic overflow                            |
| 10   | `InsufficientQuorum`      | Participation is below the configured execution threshold       |
| 11   | `ProposalExecutionFailed` | The proposal is not in `Passed` state                           |

For the complete embedded ABI and a CLI-verified deployment procedure, see
[`docs/governance-contract.md`](../../docs/governance-contract.md).
| Code | Name                   | Raised when                                                     |
| ---- | ---------------------- | --------------------------------------------------------------- |
| 1    | `AlreadyInitialized`   | `initialize` is called on an initialized contract               |
| 2    | `NotInitialized`       | Any call before `initialize`                                    |
| 3    | `InvalidInput`         | Empty title, zero voting period, or quorum above `10_000` bps   |
| 4    | `ProposalNotFound`     | Unknown `proposal_id`, or no vote from that voter on a proposal |
| 5    | `ProposalNotActive`    | Voting on a proposal whose status is no longer `Active`         |
| 6    | `VotingPeriodEnded`    | Voting after `voting_ends_at`                                   |
| 7    | `AlreadyVoted`         | The same address voting twice on one proposal                   |
| 8    | `NoVotingPower`        | The voter's governance-token balance is zero                    |
| 9    | `Overflow`             | Counter or tally arithmetic overflow                            |
| 12   | `CannotDelegateToSelf` | An account tries to delegate to itself                          |
| 13   | `InvalidDelegation`    | A delegation would create a chain or cycle                      |
| 14   | `VotingPowerDelegated` | A delegator tries to vote before revoking                       |
| 15   | `NoDelegation`         | An account tries to revoke when it has no delegation            |

## Development

```bash
cargo test -p cooplumen-governance   # unit tests (soroban-sdk testutils)
cargo fmt --check -p cooplumen-governance
```

The tests live in the `test` module of `src/lib.rs` and register a Stellar asset
contract as the governance token, so token-weighted tallies run against real
balances with mocked auth.
