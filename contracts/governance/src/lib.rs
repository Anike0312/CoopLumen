#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, Env, String, Symbol, Vec,
};

/// Errors returned by the CoopLumen Governance contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidInput = 3,
    ProposalNotFound = 4,
    ProposalNotActive = 5,
    VotingPeriodEnded = 6,
    AlreadyVoted = 7,
    NoVotingPower = 8,
    Overflow = 9,
    /// The proposal did not reach the minimum quorum threshold.
    InsufficientQuorum = 10,
    /// The proposal is not in `Passed` status and cannot be executed.
    ProposalExecutionFailed = 11,
    /// An account cannot delegate voting power to itself.
    CannotDelegateToSelf = 12,
    /// Delegation is limited to one hop to prevent cycles and ambiguous power.
    InvalidDelegation = 13,
    /// The voter delegated their power and must revoke before voting directly.
    VotingPowerDelegated = 14,
    /// The account has no active delegation to revoke.
    NoDelegation = 15,
}

/// Lifecycle status of an on-chain proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Executed,
}

/// Choice made by a voter when casting a vote.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    For,
    Against,
}

/// Governance contract configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub governance_token: Address,
    pub voting_period: u64,
    pub quorum_bps: u32,
    /// Total supply of the governance token, used as the quorum denominator.
    /// The standard token interface has no `total_supply` accessor, so this
    /// is supplied at initialization time and trusted from there.
    pub total_supply: i128,
}

/// On-chain proposal record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub proposal_id: u64,
    pub proposer: Address,
    pub title: String,
    pub description: String,
    pub actions: Vec<String>,
    pub votes_for: i128,
    pub votes_against: i128,
    pub status: ProposalStatus,
    pub created_at: u64,
    pub voting_ends_at: u64,
}

/// Individual vote record cast by an account.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
}

/// Aggregate governance metrics derived from on-chain proposal tallies.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceAnalytics {
    pub total_proposals: u64,
    pub active_proposals: u64,
    pub finalized_proposals: u64,
    pub passed_proposals: u64,
    pub rejected_proposals: u64,
    pub executed_proposals: u64,
    pub total_voting_power_cast: i128,
    /// Average participation across every proposal, in basis points.
    pub voter_turnout_bps: u32,
    /// Average participation across finalized proposals, in basis points.
    pub average_quorum_bps: u32,
    /// Passed and executed proposals divided by finalized proposals, in basis points.
    pub proposal_pass_rate_bps: u32,
}

/// Contract storage keys.
#[contracttype]
pub enum DataKey {
    Config,
    Proposal(u64),
    Vote(u64, Address),
    VoteUsed(u64, Address),
    Delegation(Address),
    Delegators(Address),
    ProposalCount,
}

// Event topic symbols

/// Emitted when a proposal is successfully executed.
/// `topics = ("proposal_executed", proposal_id)`
/// `data   = actions: Vec<String>`
const TOPIC_PROPOSAL_EXECUTED: Symbol = symbol_short!("prop_exec");

/// Emitted for each action that could not be dispatched during execution.
/// `topics = ("execution_failed", proposal_id)`
/// `data   = action: String`
const TOPIC_EXECUTION_FAILED: Symbol = symbol_short!("exec_fail");

/// Emitted when an account delegates its voting power.
#[contractevent(topics = ["delegated"])]
pub struct VotingPowerDelegatedEvent {
    #[topic]
    pub delegator: Address,
    pub delegatee: Address,
}

/// Emitted when an account revokes its voting-power delegation.
#[contractevent(topics = ["undel"])]
pub struct VotingPowerUndelegatedEvent {
    #[topic]
    pub delegator: Address,
    pub former_delegatee: Address,
}

/// On-chain Governance smart contract for CoopLumen.
#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract with admin, governance token, voting period, and quorum.
    pub fn initialize(
        env: Env,
        admin: Address,
        governance_token: Address,
        voting_period: u64,
        quorum_bps: u32,
        total_supply: i128,
    ) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(GovernanceError::AlreadyInitialized);
        }
        if voting_period == 0 || quorum_bps > 10_000 || total_supply <= 0 {
            return Err(GovernanceError::InvalidInput);
        }

        let config = Config {
            admin,
            governance_token,
            voting_period,
            quorum_bps,
            total_supply,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    /// Create a new proposal with title, description, and list of actions.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        actions: Vec<String>,
    ) -> Result<u64, GovernanceError> {
        proposer.require_auth();

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)?;

        if title.is_empty() {
            return Err(GovernanceError::InvalidInput);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count.checked_add(1).ok_or(GovernanceError::Overflow)?;

        let now = env.ledger().timestamp();
        let voting_ends_at = now
            .checked_add(config.voting_period)
            .ok_or(GovernanceError::Overflow)?;

        let proposal = Proposal {
            proposal_id,
            proposer,
            title,
            description,
            actions,
            votes_for: 0,
            votes_against: 0,
            status: ProposalStatus::Active,
            created_at: now,
            voting_ends_at,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        Ok(proposal_id)
    }

    /// Delegate all current governance-token voting power to another account.
    ///
    /// Delegation is intentionally one hop: an account that already represents
    /// delegators cannot delegate onward, and a delegatee cannot itself have an
    /// active delegation. This keeps vote accounting deterministic and prevents
    /// cycles. The token balance is read when a vote is cast, not when the
    /// delegation is created.
    pub fn delegate(
        env: Env,
        delegator: Address,
        delegatee: Address,
    ) -> Result<(), GovernanceError> {
        delegator.require_auth();

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)?;

        if delegator == delegatee {
            return Err(GovernanceError::CannotDelegateToSelf);
        }

        let token_client = token::Client::new(&env, &config.governance_token);
        if token_client.balance(&delegator) <= 0 {
            return Err(GovernanceError::NoVotingPower);
        }

        let inbound: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Delegators(delegator.clone()))
            .unwrap_or(Vec::new(&env));
        let delegatee_outbound: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Delegation(delegatee.clone()));

        if !inbound.is_empty() || delegatee_outbound.is_some() {
            return Err(GovernanceError::InvalidDelegation);
        }

        let previous: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Delegation(delegator.clone()));
        if previous == Some(delegatee.clone()) {
            return Ok(());
        }

        if let Some(previous_delegatee) = previous {
            remove_delegator(&env, &previous_delegatee, &delegator);
        }

        let mut delegators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Delegators(delegatee.clone()))
            .unwrap_or(Vec::new(&env));
        delegators.push_back(delegator.clone());

        env.storage()
            .instance()
            .set(&DataKey::Delegation(delegator.clone()), &delegatee);
        env.storage()
            .instance()
            .set(&DataKey::Delegators(delegatee.clone()), &delegators);
        VotingPowerDelegatedEvent {
            delegator,
            delegatee,
        }
        .publish(&env);

        Ok(())
    }

    /// Revoke the caller's active voting-power delegation.
    pub fn undelegate(env: Env, delegator: Address) -> Result<(), GovernanceError> {
        delegator.require_auth();

        if !env.storage().instance().has(&DataKey::Config) {
            return Err(GovernanceError::NotInitialized);
        }

        let delegatee: Address = env
            .storage()
            .instance()
            .get(&DataKey::Delegation(delegator.clone()))
            .ok_or(GovernanceError::NoDelegation)?;

        remove_delegator(&env, &delegatee, &delegator);
        env.storage()
            .instance()
            .remove(&DataKey::Delegation(delegator.clone()));
        VotingPowerUndelegatedEvent {
            delegator,
            former_delegatee: delegatee,
        }
        .publish(&env);

        Ok(())
    }

    /// Cast a token-weighted vote on an active proposal.
    pub fn cast_vote(
        env: Env,
        proposal_id: u64,
        choice: VoteChoice,
        voter: Address,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)?;

        if env
            .storage()
            .instance()
            .has(&DataKey::Delegation(voter.clone()))
        {
            return Err(GovernanceError::VotingPowerDelegated);
        }

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }

        if env.ledger().timestamp() > proposal.voting_ends_at {
            return Err(GovernanceError::VotingPeriodEnded);
        }

        let token_client = token::Client::new(&env, &config.governance_token);
        let mut represented = Vec::new(&env);
        represented.push_back(voter.clone());

        let delegators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Delegators(voter.clone()))
            .unwrap_or(Vec::new(&env));
        for delegator in delegators.iter() {
            represented.push_back(delegator);
        }

        let mut weight = 0_i128;
        for account in represented.iter() {
            if env
                .storage()
                .instance()
                .has(&DataKey::VoteUsed(proposal_id, account.clone()))
                || env
                    .storage()
                    .instance()
                    .has(&DataKey::Vote(proposal_id, account.clone()))
            {
                return Err(GovernanceError::AlreadyVoted);
            }

            weight = weight
                .checked_add(token_client.balance(&account))
                .ok_or(GovernanceError::Overflow)?;
        }

        if weight <= 0 {
            return Err(GovernanceError::NoVotingPower);
        }

        match choice {
            VoteChoice::For => {
                proposal.votes_for = proposal
                    .votes_for
                    .checked_add(weight)
                    .ok_or(GovernanceError::Overflow)?;
            }
            VoteChoice::Against => {
                proposal.votes_against = proposal
                    .votes_against
                    .checked_add(weight)
                    .ok_or(GovernanceError::Overflow)?;
            }
        }

        let vote_record = Vote {
            voter: voter.clone(),
            choice,
            weight,
        };

        env.storage()
            .instance()
            .set(&DataKey::Vote(proposal_id, voter.clone()), &vote_record);
        for account in represented.iter() {
            env.storage()
                .instance()
                .set(&DataKey::VoteUsed(proposal_id, account), &true);
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        Ok(())
    }

    /// Finalise a proposal whose voting period has elapsed.
    ///
    /// Transitions the status from `Active` to `Passed` (votes_for > votes_against)
    /// or `Rejected`. Anyone may call this once the voting window has closed; it is
    /// a prerequisite for `execute_proposal`.
    ///
    /// Returns `VotingPeriodEnded` if the window is still open, and
    /// `ProposalNotActive` if the proposal is already finalised.
    pub fn finalize_proposal(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalStatus, GovernanceError> {
        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }

        // The voting window must have closed before we can finalise.
        if env.ledger().timestamp() <= proposal.voting_ends_at {
            return Err(GovernanceError::VotingPeriodEnded);
        }

        proposal.status = if proposal.votes_for > proposal.votes_against {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Rejected
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        Ok(proposal.status)
    }

    /// Execute a passed proposal, dispatching its encoded actions on-chain.
    ///
    /// # Prerequisites
    ///
    /// 1. The contract must be initialised.
    /// 2. The proposal must exist and be in `Passed` status (call
    ///    [`finalize_proposal`] after the voting window closes to transition it).
    /// 3. Total participation (votes_for + votes_against) must meet or exceed
    ///    `quorum_bps / 10_000` of the governance-token total supply.
    ///
    /// # Execution model
    ///
    /// Actions are opaque `String` values stored on the proposal (e.g.
    /// `"disburse_treasury:500"`). The contract emits a
    /// `TOPIC_PROPOSAL_EXECUTED` event carrying all action strings once the
    /// entire batch succeeds.  If the quorum check fails the function returns
    /// `InsufficientQuorum`; if the proposal is not in `Passed` status it
    /// returns `ProposalExecutionFailed`.  Individual action failures are
    /// recorded via `TOPIC_EXECUTION_FAILED` events but do not revert the
    /// status transition — the proposal is marked `Executed` regardless, so
    /// off-chain indexers can detect partial failures without allowing
    /// re-execution.
    ///
    /// # Authorization
    ///
    /// The `executor` address must authorise the call (`require_auth`). Any
    /// address may execute a passed, quorate proposal — the contract does not
    /// restrict execution to the admin or proposer.
    pub fn execute_proposal(
        env: Env,
        proposal_id: u64,
        executor: Address,
    ) -> Result<(), GovernanceError> {
        executor.require_auth();

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        // 1. Status gate
        // Only a Passed proposal may be executed; Executed proposals are idempotent-blocked.
        if proposal.status != ProposalStatus::Passed {
            return Err(GovernanceError::ProposalExecutionFailed);
        }

        // 2. Quorum check
        // participation = votes_for + votes_against
        // required      = total_supply * quorum_bps / 10_000
        //
        // total_supply comes from Config (the standard token interface has no
        // total_supply accessor, so it is supplied at initialization time).
        // We use i128 arithmetic throughout and guard every step with
        // checked_* to satisfy the `overflow-checks = true` release profile.
        let total_supply = config.total_supply;

        let participation = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(GovernanceError::Overflow)?;

        // required_participation = total_supply * quorum_bps / 10_000
        // Cast quorum_bps to i128 for the multiplication.
        let quorum_bps_i128 = i128::from(config.quorum_bps);
        let required = total_supply
            .checked_mul(quorum_bps_i128)
            .ok_or(GovernanceError::Overflow)?
            / 10_000_i128;

        if participation < required {
            return Err(GovernanceError::InsufficientQuorum);
        }

        // 3. Status transition
        // Mark Executed before dispatching actions so re-entrant calls are
        // blocked even if an action somehow calls back into this contract.
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // 4. Action dispatch
        // Actions are opaque encoded strings (e.g. "disburse_treasury:500").
        // The contract records each one in an event so off-chain indexers and
        // executor bots can pick them up and drive the corresponding sub-calls.
        // Failures are surfaced as individual TOPIC_EXECUTION_FAILED events;
        // they do not revert the Executed status (preventing indefinite retry
        // loops on a permanently-failing action).
        for action in proposal.actions.iter() {
            // Validate the action string is non-empty before recording it.
            if action.is_empty() {
                env.events()
                    .publish((TOPIC_EXECUTION_FAILED, proposal_id), action.clone());
                continue;
            }

            // Emit the action for off-chain executors / indexers.
            // In a production contract this is where cross-contract calls or
            // sub-invocations keyed on the action prefix would be dispatched.
            env.events()
                .publish((TOPIC_PROPOSAL_EXECUTED, proposal_id), action.clone());
        }

        Ok(())
    }

    /// Get current governance configuration.
    pub fn get_config(env: Env) -> Result<Config, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)
    }

    /// Calculate aggregate governance metrics from the current on-chain state.
    ///
    /// Turnout includes active proposals so dashboards can reflect live
    /// participation. Average quorum and pass rate include only finalized
    /// proposals (`Passed`, `Rejected`, or `Executed`) so open ballots do not
    /// distort outcome metrics. `Executed` is counted as a passed outcome.
    pub fn get_analytics(env: Env) -> Result<GovernanceAnalytics, GovernanceError> {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)?;
        let total_proposals: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);

        let mut active_proposals = 0_u64;
        let mut finalized_proposals = 0_u64;
        let mut passed_proposals = 0_u64;
        let mut rejected_proposals = 0_u64;
        let mut executed_proposals = 0_u64;
        let mut total_voting_power_cast = 0_i128;
        let mut turnout_bps_total = 0_u64;
        let mut finalized_quorum_bps_total = 0_u64;

        let mut proposal_id = 1_u64;
        while proposal_id <= total_proposals {
            let proposal: Proposal = env
                .storage()
                .instance()
                .get(&DataKey::Proposal(proposal_id))
                .ok_or(GovernanceError::ProposalNotFound)?;
            let participation = proposal
                .votes_for
                .checked_add(proposal.votes_against)
                .ok_or(GovernanceError::Overflow)?;
            total_voting_power_cast = total_voting_power_cast
                .checked_add(participation)
                .ok_or(GovernanceError::Overflow)?;

            let participation_bps = participation_basis_points(participation, config.total_supply)?;
            turnout_bps_total = turnout_bps_total
                .checked_add(u64::from(participation_bps))
                .ok_or(GovernanceError::Overflow)?;

            match proposal.status {
                ProposalStatus::Active => active_proposals += 1,
                ProposalStatus::Passed => {
                    finalized_proposals += 1;
                    passed_proposals += 1;
                    finalized_quorum_bps_total += u64::from(participation_bps);
                }
                ProposalStatus::Rejected => {
                    finalized_proposals += 1;
                    rejected_proposals += 1;
                    finalized_quorum_bps_total += u64::from(participation_bps);
                }
                ProposalStatus::Executed => {
                    finalized_proposals += 1;
                    passed_proposals += 1;
                    executed_proposals += 1;
                    finalized_quorum_bps_total += u64::from(participation_bps);
                }
            }

            proposal_id = proposal_id
                .checked_add(1)
                .ok_or(GovernanceError::Overflow)?;
        }

        let voter_turnout_bps = if total_proposals == 0 {
            0
        } else {
            (turnout_bps_total / total_proposals) as u32
        };
        let average_quorum_bps = if finalized_proposals == 0 {
            0
        } else {
            (finalized_quorum_bps_total / finalized_proposals) as u32
        };
        let proposal_pass_rate_bps = if finalized_proposals == 0 {
            0
        } else {
            passed_proposals
                .checked_mul(10_000)
                .ok_or(GovernanceError::Overflow)?
                .checked_div(finalized_proposals)
                .ok_or(GovernanceError::Overflow)? as u32
        };

        Ok(GovernanceAnalytics {
            total_proposals,
            active_proposals,
            finalized_proposals,
            passed_proposals,
            rejected_proposals,
            executed_proposals,
            total_voting_power_cast,
            voter_turnout_bps,
            average_quorum_bps,
            proposal_pass_rate_bps,
        })
    }

    /// Read a proposal by ID.
    ///
    /// This is the read side of the governance contract. It returns the stored
    /// [`Proposal`] for `proposal_id` — the proposer and metadata, the encoded
    /// `actions` the proposal would execute, the running `votes_for` /
    /// `votes_against` tallies, the lifecycle `status`, and the voting window
    /// (`created_at` / `voting_ends_at`) — without mutating any state, so it is
    /// safe to call from a read-only / simulation invocation.
    ///
    /// Because every proposal is keyed by its own `proposal_id`, a call for one
    /// id can never observe or disturb another proposal's record.
    ///
    /// # Errors
    ///
    /// - [`GovernanceError::NotInitialized`] if the contract has not been
    ///   initialized yet, matching `get_config`, `create_proposal` and
    ///   `cast_vote`.
    /// - [`GovernanceError::ProposalNotFound`] if the contract is initialized
    ///   but no proposal is stored under `proposal_id`.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        if !env.storage().instance().has(&DataKey::Config) {
            return Err(GovernanceError::NotInitialized);
        }

        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Read a vote cast by a voter for a proposal.
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Result<Vote, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, voter))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Return the account currently receiving `delegator`'s voting power.
    pub fn get_delegation(env: Env, delegator: Address) -> Option<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Delegation(delegator))
    }

    /// Return all accounts whose voting power is currently delegated to `delegatee`.
    pub fn get_delegators(env: Env, delegatee: Address) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Delegators(delegatee))
            .unwrap_or(Vec::new(&env))
    }
}

fn remove_delegator(env: &Env, delegatee: &Address, delegator: &Address) {
    let mut delegators: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Delegators(delegatee.clone()))
        .unwrap_or(Vec::new(env));

    let mut index = 0_u32;
    while index < delegators.len() {
        if delegators.get(index) == Some(delegator.clone()) {
            delegators.remove(index);
            break;
        }
        index += 1;
    }

    if delegators.is_empty() {
        env.storage()
            .instance()
            .remove(&DataKey::Delegators(delegatee.clone()));
    } else {
        env.storage()
            .instance()
            .set(&DataKey::Delegators(delegatee.clone()), &delegators);
    }
}

fn participation_basis_points(
    participation: i128,
    total_supply: i128,
) -> Result<u32, GovernanceError> {
    let basis_points = participation
        .checked_mul(10_000)
        .ok_or(GovernanceError::Overflow)?
        .checked_div(total_supply)
        .ok_or(GovernanceError::InvalidInput)?;

    Ok(if basis_points > 10_000 {
        10_000
    } else {
        basis_points as u32
    })
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{vec, Env};

    fn setup_test() -> (
        Env,
        Address,
        Address,
        Address,
        GovernanceContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000_000);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = sac.address();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &token, &86400, &5000, &10_000);

        (env, admin, token_admin, token, client)
    }

    // Helper: create a proposal and advance past its voting window

    /// Creates a proposal, optionally mints tokens to `voter` and casts a FOR
    /// vote, then advances the ledger past `voting_ends_at` and calls
    /// `finalize_proposal`.  Returns `(proposal_id, voter_address)`.
    fn create_and_finalize(
        env: &Env,
        client: &GovernanceContractClient,
        token: &Address,
        voter_balance: i128,
    ) -> (u64, Address) {
        let proposer = Address::generate(env);
        let voter = Address::generate(env);

        if voter_balance > 0 {
            StellarAssetClient::new(env, token).mint(&voter, &voter_balance);
        }

        let title = String::from_str(env, "Community Grant");
        let desc = String::from_str(env, "Fund local water project");
        let actions = vec![
            env,
            String::from_str(env, "disburse_treasury:500"),
            String::from_str(env, "notify_members"),
        ];

        let id = client.create_proposal(&proposer, &title, &desc, &actions);

        if voter_balance > 0 {
            client.cast_vote(&id, &VoteChoice::For, &voter);
        }

        // Advance past voting_ends_at (1_000_000 + 86400 = 1_086_400)
        env.ledger().set_timestamp(1_086_401);
        client.finalize_proposal(&id);

        (id, voter)
    }

    // Existing tests

    #[test]
    fn test_initialize_and_get_config() {
        let (_env, admin, _token_admin, token, client) = setup_test();
        let config = client.get_config();
        assert_eq!(config.admin, admin);
        assert_eq!(config.governance_token, token);
        assert_eq!(config.voting_period, 86400);
        assert_eq!(config.quorum_bps, 5000);
        assert_eq!(config.total_supply, 10_000);
    }

    #[test]
    fn test_create_proposal_succeeds() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let proposer = Address::generate(&env);

        let title = String::from_str(&env, "Community Treasury Grant");
        let description = String::from_str(&env, "Allocate 500 tokens for local water project");
        let actions = vec![&env, String::from_str(&env, "disburse_treasury:500")];

        let proposal_id = client.create_proposal(&proposer, &title, &description, &actions);
        assert_eq!(proposal_id, 1);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.proposal_id, 1);
        assert_eq!(proposal.proposer, proposer);
        assert_eq!(proposal.title, title);
        assert_eq!(proposal.description, description);
        assert_eq!(proposal.votes_for, 0);
        assert_eq!(proposal.votes_against, 0);
        assert_eq!(proposal.status, ProposalStatus::Active);
        assert_eq!(proposal.created_at, 1_000_000);
        assert_eq!(proposal.voting_ends_at, 1_000_000 + 86400);
    }

    #[test]
    fn test_cast_vote_token_weighted_tally() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        // Mint governance tokens to voters
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&voter1, &1000);
        sac.mint(&voter2, &500);

        let title = String::from_str(&env, "Upgrade Protocol");
        let description = String::from_str(&env, "Upgrade contract WASM");
        let actions = vec![&env, String::from_str(&env, "upgrade")];

        let id = client.create_proposal(&proposer, &title, &description, &actions);

        // Voter 1 votes FOR (1000 weight)
        client.cast_vote(&id, &VoteChoice::For, &voter1);
        let p1 = client.get_proposal(&id);
        assert_eq!(p1.votes_for, 1000);
        assert_eq!(p1.votes_against, 0);

        let vote1 = client.get_vote(&id, &voter1);
        assert_eq!(vote1.weight, 1000);
        assert_eq!(vote1.choice, VoteChoice::For);

        // Voter 2 votes AGAINST (500 weight)
        client.cast_vote(&id, &VoteChoice::Against, &voter2);
        let p2 = client.get_proposal(&id);
        assert_eq!(p2.votes_for, 1000);
        assert_eq!(p2.votes_against, 500);
    }

    #[test]
    fn test_delegatee_votes_with_current_delegated_power() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&delegator, &700);
        sac.mint(&delegatee, &300);

        client.delegate(&delegator, &delegatee);
        sac.mint(&delegator, &100);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Delegated ballot"),
            &String::from_str(&env, "Count represented voting power"),
            &vec![&env],
        );
        client.cast_vote(&id, &VoteChoice::For, &delegatee);

        assert_eq!(client.get_delegation(&delegator), Some(delegatee.clone()));
        assert_eq!(client.get_delegators(&delegatee), vec![&env, delegator]);
        assert_eq!(client.get_proposal(&id).votes_for, 1_100);
        assert_eq!(client.get_vote(&id, &delegatee).weight, 1_100);
    }

    #[test]
    fn test_delegator_cannot_vote_until_delegation_is_revoked() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&delegator, &500);
        client.delegate(&delegator, &delegatee);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Direct ballot"),
            &String::from_str(&env, "Revoke before direct voting"),
            &vec![&env],
        );
        assert_eq!(
            client
                .try_cast_vote(&id, &VoteChoice::For, &delegator)
                .unwrap_err()
                .unwrap(),
            GovernanceError::VotingPowerDelegated
        );

        client.undelegate(&delegator);
        assert_eq!(client.get_delegation(&delegator), None);
        assert!(client.get_delegators(&delegatee).is_empty());
        client.cast_vote(&id, &VoteChoice::For, &delegator);
        assert_eq!(client.get_proposal(&id).votes_for, 500);
    }

    #[test]
    fn test_delegated_power_cannot_be_counted_after_direct_vote() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&delegator, &600);
        sac.mint(&delegatee, &400);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "No double count"),
            &String::from_str(&env, "One balance, one ballot"),
            &vec![&env],
        );
        client.cast_vote(&id, &VoteChoice::For, &delegator);
        client.delegate(&delegator, &delegatee);

        assert_eq!(
            client
                .try_cast_vote(&id, &VoteChoice::For, &delegatee)
                .unwrap_err()
                .unwrap(),
            GovernanceError::AlreadyVoted
        );
        assert_eq!(client.get_proposal(&id).votes_for, 600);
    }

    #[test]
    fn test_delegation_rejects_self_and_multi_hop_chains() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let first = Address::generate(&env);
        let second = Address::generate(&env);
        let third = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&first, &100);
        sac.mint(&second, &100);
        sac.mint(&third, &100);

        assert_eq!(
            client.try_delegate(&first, &first).unwrap_err().unwrap(),
            GovernanceError::CannotDelegateToSelf
        );

        client.delegate(&first, &second);
        assert_eq!(
            client.try_delegate(&second, &third).unwrap_err().unwrap(),
            GovernanceError::InvalidDelegation
        );
        assert_eq!(
            client.try_delegate(&third, &first).unwrap_err().unwrap(),
            GovernanceError::InvalidDelegation
        );
    }

    #[test]
    fn test_cast_vote_fails_without_tokens() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let proposer = Address::generate(&env);
        let broke_voter = Address::generate(&env);

        let title = String::from_str(&env, "Proposal 1");
        let desc = String::from_str(&env, "Desc 1");
        let actions = vec![&env];

        let id = client.create_proposal(&proposer, &title, &desc, &actions);

        let err = client
            .try_cast_vote(&id, &VoteChoice::For, &broke_voter)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::NoVotingPower);
    }

    #[test]
    fn test_cast_vote_prevents_double_voting() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &500);

        let title = String::from_str(&env, "Proposal 1");
        let desc = String::from_str(&env, "Desc 1");
        let actions = vec![&env];

        let id = client.create_proposal(&proposer, &title, &desc, &actions);

        client.cast_vote(&id, &VoteChoice::For, &voter);

        let err = client
            .try_cast_vote(&id, &VoteChoice::For, &voter)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::AlreadyVoted);
    }

    #[test]
    fn test_cast_vote_after_voting_period_fails() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &500);

        let title = String::from_str(&env, "Proposal 1");
        let desc = String::from_str(&env, "Desc 1");
        let actions = vec![&env];

        let id = client.create_proposal(&proposer, &title, &desc, &actions);

        // Fast forward ledger timestamp past voting_ends_at
        env.ledger().set_timestamp(1_000_000 + 86401);

        let err = client
            .try_cast_vote(&id, &VoteChoice::For, &voter)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::VotingPeriodEnded);
    }

    // finalize_proposal tests

    #[test]
    fn test_finalize_proposal_passed() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &1000);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env],
        );

        client.cast_vote(&id, &VoteChoice::For, &voter);

        env.ledger().set_timestamp(1_086_401);
        let status = client.finalize_proposal(&id);
        assert_eq!(status, ProposalStatus::Passed);
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Passed);
    }

    #[test]
    fn test_finalize_proposal_rejected() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &1000);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env],
        );

        client.cast_vote(&id, &VoteChoice::Against, &voter);

        env.ledger().set_timestamp(1_086_401);
        let status = client.finalize_proposal(&id);
        assert_eq!(status, ProposalStatus::Rejected);
    }

    #[test]
    fn test_finalize_proposal_fails_while_voting_open() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let proposer = Address::generate(&env);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env],
        );

        // Still within voting window — should fail
        let err = client.try_finalize_proposal(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernanceError::VotingPeriodEnded);
    }

    #[test]
    fn test_finalize_proposal_fails_if_already_finalized() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let (id, _) = create_and_finalize(&env, &client, &token, 1000);

        // Second call on an already-Passed proposal
        let err = client.try_finalize_proposal(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernanceError::ProposalNotActive);
    }

    // execute_proposal tests

    /// Happy path: a passed, quorate proposal executes successfully and is
    /// marked `Executed`.
    #[test]
    fn test_execute_proposal_success() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let executor = Address::generate(&env);

        // total_supply = 10_000 (from setup_test); quorum_bps = 5000 (50%)
        // required participation = 10_000 * 5000 / 10_000 = 5000
        // actual participation   = 6000 (FOR) >= 5000, so quorum is met
        let (id, _) = create_and_finalize(&env, &client, &token, 6000);

        client.execute_proposal(&id, &executor);

        let proposal = client.get_proposal(&id);
        assert_eq!(proposal.status, ProposalStatus::Executed);
    }

    /// Executing a proposal that is already `Executed` returns
    /// `ProposalExecutionFailed`.
    #[test]
    fn test_execute_proposal_already_executed() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let executor = Address::generate(&env);

        let (id, _) = create_and_finalize(&env, &client, &token, 6000);
        client.execute_proposal(&id, &executor);

        let err = client
            .try_execute_proposal(&id, &executor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::ProposalExecutionFailed);
    }

    /// Trying to execute a `Rejected` proposal returns `ProposalExecutionFailed`.
    #[test]
    fn test_execute_proposal_not_passed() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let executor = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &1000);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env],
        );

        // Vote AGAINST so it becomes Rejected
        client.cast_vote(&id, &VoteChoice::Against, &voter);
        env.ledger().set_timestamp(1_086_401);
        client.finalize_proposal(&id);

        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Rejected);

        let err = client
            .try_execute_proposal(&id, &executor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::ProposalExecutionFailed);
    }

    /// Trying to execute a still-`Active` proposal (not yet finalised) returns
    /// `ProposalExecutionFailed`.
    #[test]
    fn test_execute_proposal_still_active() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let proposer = Address::generate(&env);
        let executor = Address::generate(&env);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env],
        );

        let err = client
            .try_execute_proposal(&id, &executor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::ProposalExecutionFailed);
    }

    /// When total participation falls below the quorum threshold,
    /// `InsufficientQuorum` is returned and the proposal remains `Passed`
    /// (so it can be re-attempted once more votes are cast — but since
    /// the window is closed that is not possible; the proposal simply
    /// cannot execute).
    #[test]
    fn test_execute_proposal_quorum_not_met() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let bystander = Address::generate(&env);
        let executor = Address::generate(&env);

        // Mint 1000 to voter and 9000 to bystander (who does NOT vote).
        // total_supply = 10_000
        // quorum_bps   = 5000 (50%) → required = 5000
        // votes_for    = 1000 (only voter voted)
        // participation < required → InsufficientQuorum
        StellarAssetClient::new(&env, &token).mint(&voter, &1_000);
        StellarAssetClient::new(&env, &token).mint(&bystander, &9_000);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env, String::from_str(&env, "some_action")],
        );

        client.cast_vote(&id, &VoteChoice::For, &voter);

        env.ledger().set_timestamp(1_086_401);
        client.finalize_proposal(&id);

        // Proposal is Passed (more FOR than AGAINST) but quorum not met.
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Passed);

        let err = client
            .try_execute_proposal(&id, &executor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::InsufficientQuorum);

        // Status must remain Passed so nothing is lost.
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Passed);
    }

    /// When quorum is set to zero, any passed proposal can execute regardless
    /// of participation (edge case: permissionless communities).
    #[test]
    fn test_execute_proposal_zero_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000_000);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = sac.address();
        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        // quorum_bps = 0 → required = 0
        client.initialize(&admin, &token, &86400, &0, &1_000_000);

        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let executor = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&voter, &100);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &vec![&env, String::from_str(&env, "ping")],
        );

        client.cast_vote(&id, &VoteChoice::For, &voter);
        env.ledger().set_timestamp(1_086_401);
        client.finalize_proposal(&id);

        // Should succeed even though only 100 of 100 tokens voted
        // (participation = 100 >= required = 0)
        client.execute_proposal(&id, &executor);
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
    }

    /// Executing a non-existent proposal returns `ProposalNotFound`.
    #[test]
    fn test_execute_proposal_not_found() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let executor = Address::generate(&env);

        let err = client
            .try_execute_proposal(&99, &executor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernanceError::ProposalNotFound);
    }

    #[test]
    fn test_get_proposal_before_initialize_returns_not_initialized() {
        // A contract that has been deployed but never initialized has no config,
        // so the read path reports NotInitialized rather than pretending the
        // proposal simply does not exist.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let err = client.try_get_proposal(&1).unwrap_err().unwrap();
        assert_eq!(err, GovernanceError::NotInitialized);
    }

    #[test]
    fn test_get_proposal_unknown_id_returns_proposal_not_found() {
        let (_env, _admin, _token_admin, _token, client) = setup_test();

        let err = client.try_get_proposal(&42).unwrap_err().unwrap();
        assert_eq!(err, GovernanceError::ProposalNotFound);
    }

    #[test]
    fn test_get_proposal_returns_independent_records_per_id() {
        let (env, _admin, _token_admin, _token, client) = setup_test();
        let proposer = Address::generate(&env);

        let first_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "First"),
            &String::from_str(&env, "First description"),
            &vec![&env, String::from_str(&env, "action:a")],
        );
        let second_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Second"),
            &String::from_str(&env, "Second description"),
            &vec![
                &env,
                String::from_str(&env, "action:b"),
                String::from_str(&env, "action:c"),
            ],
        );

        assert_eq!(first_id, 1);
        assert_eq!(second_id, 2);

        let first = client.get_proposal(&first_id);
        let second = client.get_proposal(&second_id);

        assert_eq!(first.proposal_id, 1);
        assert_eq!(second.proposal_id, 2);
        assert_eq!(first.title, String::from_str(&env, "First"));
        assert_eq!(second.title, String::from_str(&env, "Second"));
        assert_eq!(
            first.description,
            String::from_str(&env, "First description")
        );
        assert_eq!(
            second.description,
            String::from_str(&env, "Second description")
        );
        assert_eq!(first.actions.len(), 1);
        assert_eq!(second.actions.len(), 2);
        assert_eq!(first.proposer, proposer);
        assert_eq!(second.proposer, proposer);

        // Reading one proposal must not disturb the other.
        let first_again = client.get_proposal(&first_id);
        assert_eq!(first_again.title, first.title);
        assert_eq!(first_again.actions, first.actions);
        assert_eq!(first_again.votes_for, 0);
    }

    #[test]
    fn test_get_proposal_tally_matches_votes_after_each_cast() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter_for = Address::generate(&env);
        let voter_against = Address::generate(&env);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&voter_for, &750);
        sac.mint(&voter_against, &250);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Tally"),
            &String::from_str(&env, "Tally description"),
            &vec![&env],
        );

        let fresh = client.get_proposal(&id);
        assert_eq!(fresh.votes_for, 0);
        assert_eq!(fresh.votes_against, 0);
        assert_eq!(fresh.status, ProposalStatus::Active);

        client.cast_vote(&id, &VoteChoice::Against, &voter_against);
        let after_against = client.get_proposal(&id);
        assert_eq!(after_against.votes_for, 0);
        assert_eq!(after_against.votes_against, 250);

        client.cast_vote(&id, &VoteChoice::For, &voter_for);
        let after_for = client.get_proposal(&id);
        assert_eq!(after_for.votes_for, 750);
        assert_eq!(after_for.votes_against, 250);
        assert_eq!(after_for.status, ProposalStatus::Active);
    }

    #[test]
    fn test_governance_analytics_are_zero_safe() {
        let (_env, _admin, _token_admin, _token, client) = setup_test();

        assert_eq!(
            client.get_analytics(),
            GovernanceAnalytics {
                total_proposals: 0,
                active_proposals: 0,
                finalized_proposals: 0,
                passed_proposals: 0,
                rejected_proposals: 0,
                executed_proposals: 0,
                total_voting_power_cast: 0,
                voter_turnout_bps: 0,
                average_quorum_bps: 0,
                proposal_pass_rate_bps: 0,
            }
        );
    }

    #[test]
    fn test_governance_analytics_report_turnout_quorum_and_pass_rate() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let proposer = Address::generate(&env);
        let voter_for = Address::generate(&env);
        let voter_against = Address::generate(&env);
        let active_voter = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&voter_for, &6_000);
        sac.mint(&voter_against, &2_000);
        sac.mint(&active_voter, &1_000);

        let passed_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Passed"),
            &String::from_str(&env, "Sixty percent turnout"),
            &vec![&env],
        );
        let rejected_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Rejected"),
            &String::from_str(&env, "Twenty percent turnout"),
            &vec![&env],
        );
        let active_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "Active"),
            &String::from_str(&env, "Ten percent live turnout"),
            &vec![&env],
        );

        client.cast_vote(&passed_id, &VoteChoice::For, &voter_for);
        client.cast_vote(&rejected_id, &VoteChoice::Against, &voter_against);
        client.cast_vote(&active_id, &VoteChoice::For, &active_voter);

        env.ledger().set_timestamp(1_086_401);
        client.finalize_proposal(&passed_id);
        client.finalize_proposal(&rejected_id);

        let analytics = client.get_analytics();
        assert_eq!(analytics.total_proposals, 3);
        assert_eq!(analytics.active_proposals, 1);
        assert_eq!(analytics.finalized_proposals, 2);
        assert_eq!(analytics.passed_proposals, 1);
        assert_eq!(analytics.rejected_proposals, 1);
        assert_eq!(analytics.executed_proposals, 0);
        assert_eq!(analytics.total_voting_power_cast, 9_000);
        assert_eq!(analytics.voter_turnout_bps, 3_000);
        assert_eq!(analytics.average_quorum_bps, 4_000);
        assert_eq!(analytics.proposal_pass_rate_bps, 5_000);
    }

    #[test]
    fn test_governance_analytics_count_executed_as_passed() {
        let (env, _admin, _token_admin, token, client) = setup_test();
        let executor = Address::generate(&env);
        let (proposal_id, _) = create_and_finalize(&env, &client, &token, 6_000);
        client.execute_proposal(&proposal_id, &executor);

        let analytics = client.get_analytics();
        assert_eq!(analytics.finalized_proposals, 1);
        assert_eq!(analytics.passed_proposals, 1);
        assert_eq!(analytics.executed_proposals, 1);
        assert_eq!(analytics.average_quorum_bps, 6_000);
        assert_eq!(analytics.proposal_pass_rate_bps, 10_000);
    }
}
