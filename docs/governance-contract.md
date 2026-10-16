# Governance contract ABI and deployment

This guide documents the ABI implemented in
[`contracts/governance/src/lib.rs`](../contracts/governance/src/lib.rs) and a
repeatable Stellar CLI deployment flow. It was verified with Stellar CLI
27.1.0 against the contract's embedded specification.

## Build and inspect

From the repository root:

```bash
cargo test -p cooplumen-governance
stellar contract build --package cooplumen-governance --locked
stellar contract info interface \
  --wasm target/wasm32v1-none/release/cooplumen_governance.wasm
```

The build produces
`target/wasm32v1-none/release/cooplumen_governance.wasm`. The interface command
is the authoritative way to inspect the ABI embedded in a particular build.

## ABI

All integer types below are Soroban integers. Every function returns a Soroban
`Result<ok, GovernanceError>`.

| Function            | Arguments                                                                                                    | Success value     | Authorization and behavior                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`        | `admin: Address`, `governance_token: Address`, `voting_period: u64`, `quorum_bps: u32`, `total_supply: i128` | `()`              | One-time configuration. Rejects a zero voting period, quorum above 10,000 basis points, or non-positive supply. It does not require address authorization. |
| `create_proposal`   | `proposer: Address`, `title: String`, `description: String`, `actions: Vec<String>`                          | `u64` proposal ID | Requires `proposer` authorization. IDs start at 1. The title must be non-empty.                                                                            |
| `cast_vote`         | `proposal_id: u64`, `choice: VoteChoice`, `voter: Address`                                                   | `()`              | Requires `voter` authorization. Reads the voter's current governance-token balance and permits one vote per proposal.                                      |
| `finalize_proposal` | `proposal_id: u64`                                                                                           | `ProposalStatus`  | Permissionless after the voting window. `votes_for > votes_against` passes; a tie rejects.                                                                 |
| `execute_proposal`  | `proposal_id: u64`, `executor: Address`                                                                      | `()`              | Requires `executor` authorization. The proposal must be passed and participation must meet quorum.                                                         |
| `get_config`        | none                                                                                                         | `Config`          | Read-only; returns the singleton configuration.                                                                                                            |
| `get_proposal`      | `proposal_id: u64`                                                                                           | `Proposal`        | Read-only proposal and live tally lookup.                                                                                                                  |
| `get_vote`          | `proposal_id: u64`, `voter: Address`                                                                         | `Vote`            | Read-only lookup for one recorded ballot.                                                                                                                  |

### Contract types

```text
Config {
  admin: Address,
  governance_token: Address,
  voting_period: u64,
  quorum_bps: u32,
  total_supply: i128
}

Proposal {
  proposal_id: u64,
  proposer: Address,
  title: String,
  description: String,
  actions: Vec<String>,
  votes_for: i128,
  votes_against: i128,
  status: ProposalStatus,
  created_at: u64,
  voting_ends_at: u64
}

Vote { voter: Address, choice: VoteChoice, weight: i128 }
ProposalStatus = Active | Passed | Rejected | Executed
VoteChoice = For | Against
```

`total_supply` is supplied at initialization because the standard Soroban
token interface has no total-supply method. Quorum is calculated at execution
as `total_supply * quorum_bps / 10_000`; the configured denominator does not
automatically change when tokens are minted or burned.

### Errors

| Code | Name                      | Meaning                                                             |
| ---- | ------------------------- | ------------------------------------------------------------------- |
| 1    | `AlreadyInitialized`      | Configuration already exists.                                       |
| 2    | `NotInitialized`          | Configuration is required for the requested operation.              |
| 3    | `InvalidInput`            | Initialization values or proposal title are invalid.                |
| 4    | `ProposalNotFound`        | The proposal or requested vote does not exist.                      |
| 5    | `ProposalNotActive`       | The proposal can no longer accept votes or be finalized.            |
| 6    | `VotingPeriodEnded`       | Voting has closed, or finalization was attempted before it closed.  |
| 7    | `AlreadyVoted`            | The address already voted on this proposal.                         |
| 8    | `NoVotingPower`           | The voter's current token balance is not positive.                  |
| 9    | `Overflow`                | Checked counter, timestamp, tally, or quorum arithmetic overflowed. |
| 10   | `InsufficientQuorum`      | Participation is below the configured threshold.                    |
| 11   | `ProposalExecutionFailed` | The proposal is not in `Passed` state.                              |

### Execution events

`execute_proposal` marks the proposal `Executed` and publishes one event for
each action string:

| Topic                        | Data                    | Condition             |
| ---------------------------- | ----------------------- | --------------------- |
| `("prop_exec", proposal_id)` | non-empty action string | Normal action record  |
| `("exec_fail", proposal_id)` | empty action string     | Invalid action record |

The current implementation does not parse actions or make cross-contract
calls. An indexer or executor service must consume these events and perform the
encoded work. An empty action does not revert execution.

## Deploy to testnet

The examples use a named CLI identity and the built-in `testnet` network. Do
not put secret keys in source control or command history.

1. Create and fund a deployment identity if one is not already configured:

   ```bash
   stellar keys generate cooplumen-deployer --network testnet --fund
   stellar keys address cooplumen-deployer
   ```

2. Build the release WASM and run its tests:

   ```bash
   cargo test -p cooplumen-governance
   stellar contract build --package cooplumen-governance --locked
   ```

3. Deploy and save the returned contract ID under a local alias:

   ```bash
   stellar contract deploy \
     --wasm target/wasm32v1-none/release/cooplumen_governance.wasm \
     --source cooplumen-deployer \
     --network testnet \
     --alias cooplumen-governance
   ```

4. Initialize immediately. `TOKEN_CONTRACT_ID` must identify a deployed token
   contract implementing the standard `balance(Address) -> i128` interface.
   Token amounts use the token contract's smallest unit.

   ```bash
   export ADMIN_ADDRESS="$(stellar keys address cooplumen-deployer)"
   export TOKEN_CONTRACT_ID="C..."

   stellar contract invoke \
     --id cooplumen-governance \
     --source cooplumen-deployer \
     --network testnet \
     -- initialize \
     --admin "$ADMIN_ADDRESS" \
     --governance_token "$TOKEN_CONTRACT_ID" \
     --voting_period 86400 \
     --quorum_bps 5000 \
     --total_supply 1000000000
   ```

   Initialization is a first-writer operation and currently has no
   `require_auth` guard. Deploy and initialize in one controlled run; do not
   leave an uninitialized contract ID exposed.

5. Verify the stored configuration without submitting a transaction:

   ```bash
   stellar contract invoke \
     --id cooplumen-governance \
     --source cooplumen-deployer \
     --network testnet \
     --send no \
     -- get_config
   ```

For mainnet, configure a mainnet identity and replace every `--network
testnet` argument with the reviewed mainnet network alias. Rebuild from the
audited commit, record the WASM hash printed by `stellar contract build`, and
verify the deployed contract ID and initialization result before publishing it
to backend or frontend configuration.

## Example lifecycle

The Stellar CLI derives argument parsing from the embedded ABI. Addresses that
authorize `create_proposal`, `cast_vote`, or `execute_proposal` must be
available to the CLI source/signing configuration.

```bash
stellar contract invoke --id cooplumen-governance --source alice --network testnet -- \
  create_proposal \
  --proposer "$(stellar keys address alice)" \
  --title "Fund the community garden" \
  --description "Release the approved grant" \
  --actions '["treasury:release:grant-42"]'

stellar contract invoke --id cooplumen-governance --source bob --network testnet -- \
  cast_vote \
  --proposal_id 1 \
  --choice For \
  --voter "$(stellar keys address bob)"

# Run only after voting_ends_at.
stellar contract invoke --id cooplumen-governance --source cooplumen-deployer --network testnet -- \
  finalize_proposal --proposal_id 1

stellar contract invoke --id cooplumen-governance --source cooplumen-deployer --network testnet -- \
  execute_proposal \
  --proposal_id 1 \
  --executor "$(stellar keys address cooplumen-deployer)"
```

Before using an example against a deployed contract, run
`stellar contract invoke ... -- --help` to confirm the argument rendering for
the installed CLI version and deployed ABI.
