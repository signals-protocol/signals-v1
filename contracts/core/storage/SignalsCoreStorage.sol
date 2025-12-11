// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../interfaces/ISignalsCore.sol";
import "../../interfaces/ISignalsPosition.sol";
import "../../lib/LazyMulSegmentTree.sol";

abstract contract SignalsCoreStorage {
    // Governance-configurable settlement windows (set via initializer/setter in Core).
    uint64 public settlementSubmitWindow;
    uint64 public settlementFinalizeDeadline;

    IERC20 public paymentToken;
    ISignalsPosition public positionContract;

    mapping(uint256 => ISignalsCore.Market) public markets;
    mapping(uint256 => LazyMulSegmentTree.Tree) public marketTrees;
    uint256 public nextMarketId;

    struct SettlementOracleState {
        int256 candidateValue;
        uint64 candidatePriceTimestamp;
    }

    mapping(uint256 => SettlementOracleState) internal settlementOracleState;
    address public settlementOracleSigner;

    mapping(uint256 => bool) public positionSettledEmitted;

    address public feeRecipient;
    address public defaultFeePolicy;

    // ============================================================
    // LP Vault State (Phase 4)
    // ============================================================
    
    /// @notice LP Vault accounting state
    struct VaultState {
        uint256 nav;           // N_t: current NAV (WAD)
        uint256 shares;        // S_t: current total shares (WAD)
        uint256 price;         // P_t: current price (WAD)
        uint256 pricePeak;     // P^peak_t: running peak price (WAD)
        uint64 lastBatchTimestamp; // Timestamp of last batch
        bool isSeeded;         // Has vault been seeded
    }
    
    /// @notice Backstop vault state
    struct BackstopState {
        uint256 nav;           // B_t: Backstop NAV (WAD)
        uint256 targetCoverage; // ρ_BS target coverage ratio (WAD)
    }

    /// @notice Treasury state
    struct TreasuryState {
        uint256 nav;           // T_t: Treasury NAV (WAD)
    }

    /// @notice User deposit/withdraw request
    struct VaultRequest {
        uint256 amount;        // Deposit: asset amount, Withdraw: shares
        uint64 requestTimestamp;
        bool isDeposit;        // true = deposit, false = withdraw
    }

    /// @notice Pending queue totals
    struct VaultQueue {
        uint256 pendingDeposits;    // Total pending deposit amount (WAD)
        uint256 pendingWithdraws;   // Total pending withdraw shares (WAD)
    }

    VaultState internal lpVault;
    BackstopState internal backstop;
    TreasuryState internal treasury;
    VaultQueue internal vaultQueue;

    /// @notice User request queue: user => request
    mapping(address => VaultRequest) internal userRequests;

    /// @notice Withdrawal lag in seconds
    uint64 public withdrawLag;

    /// @notice Minimum seed amount for first deposit
    uint256 public minSeedAmount;

    /// @notice Fee distribution ratios (must sum to WAD)
    uint256 public feeRatioLP;      // ϕ_LP
    uint256 public feeRatioBackstop; // ϕ_BS
    uint256 public feeRatioTreasury; // ϕ_TR

    // ============================================================
    // Phase 5: Fee Waterfall & Capital Stack
    // ============================================================

    /// @notice Capital stack configuration (Backstop + Treasury)
    struct CapitalStackState {
        uint256 backstopNav;     // B_t: Backstop NAV (WAD)
        uint256 treasuryNav;     // T_t: Treasury NAV (WAD)
    }

    /// @notice Fee waterfall configuration parameters
    struct FeeWaterfallConfig {
        int256 pdd;              // Drawdown floor (negative WAD, e.g., -0.3e18 = -30%)
        uint256 rhoBS;           // ρ_BS: Backstop coverage target ratio (WAD)
        uint256 phiLP;           // ϕ_LP: LP residual fee share (WAD)
        uint256 phiBS;           // ϕ_BS: Backstop residual fee share (WAD)
        uint256 phiTR;           // ϕ_TR: Treasury residual fee share (WAD)
    }

    /// @notice Daily P&L snapshot for batch processing
    /// @dev Fields match whitepaper Appendix A naming for easy verification
    struct DailyPnlSnapshot {
        // Input values
        int256 Lt;               // CLMSR P&L (signed)
        uint256 Ftot;            // Total gross fees
        
        // Fee Waterfall intermediate values
        uint256 Floss;           // Loss compensation: min(Ftot, |L^-|)
        uint256 Fpool;           // Remaining pool: Ftot - Floss
        uint256 Nraw;            // NAV after loss comp: N_{t-1} + Lt + Floss
        uint256 Gt;              // Grant from Backstop
        uint256 Ffill;           // Backstop coverage fill
        
        // Fee splits
        uint256 FLP;             // Fee to LP: Floss + F_core_LP + dust
        uint256 FBS;             // Fee to Backstop: F_fill + F_core_BS
        uint256 FTR;             // Fee to Treasury: F_core_TR
        uint256 Fdust;           // Rounding dust (to LP)
        
        // Output values
        uint256 Ft;              // Total fee credited to LP NAV
        uint256 Npre;            // Pre-batch NAV
        uint256 Pe;              // Batch equity price: Npre / S_{t-1}
        
        // State
        bool processed;          // Whether this batch has been processed
    }

    /// @notice Unified capital stack state (Phase 5)
    CapitalStackState internal capitalStack;

    /// @notice Fee waterfall configuration (Phase 5)
    FeeWaterfallConfig internal feeWaterfallConfig;

    /// @notice Daily P&L snapshots by batch ID
    mapping(uint64 => DailyPnlSnapshot) internal _dailyPnl;

    // ============================================================
    // Phase 6: Request ID-based Queue (Placeholder)
    // ============================================================

    /// @notice Request status enum for ID-based queue (Phase 6)
    enum RequestStatus {
        Pending,
        Processed,
        Claimed,
        Cancelled
    }

    /// @notice Deposit request with ID (Phase 6)
    struct DepositRequest {
        uint64 id;
        address owner;
        uint256 amount;
        uint64 eligibleBatchId;
        RequestStatus status;
    }

    /// @notice Withdraw request with ID (Phase 6)
    struct WithdrawRequest {
        uint64 id;
        address owner;
        uint256 shares;
        uint64 eligibleBatchId;
        RequestStatus status;
    }

    /// @notice Batch aggregation result (Phase 6)
    struct BatchAggregation {
        uint256 totalDepositAssets;
        uint256 totalWithdrawShares;
        uint256 depositPrice;
        uint256 withdrawPrice;
        bool processed;
    }

    // Phase 6 storage slots (not used until Phase 6)
    // mapping(uint64 => DepositRequest) internal depositRequests;
    // mapping(uint64 => WithdrawRequest) internal withdrawRequests;
    // mapping(uint64 => BatchAggregation) internal batchAggregations;
    // uint64 public nextDepositRequestId;
    // uint64 public nextWithdrawRequestId;

    // Reserve ample slots for future upgrades; do not change after first deployment.
    uint256[25] internal __gap;
}
