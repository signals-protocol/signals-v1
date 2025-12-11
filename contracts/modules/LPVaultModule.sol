// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/storage/SignalsCoreStorage.sol";
import "../vault/lib/VaultAccountingLib.sol";
import "../errors/ModuleErrors.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LPVaultModule
 * @notice Delegate-only module for LP Vault operations
 * @dev Phase 4 implementation - no Risk enforcement yet
 *
 * Implements:
 * - Deposit/withdraw request queue
 * - Daily batch processing
 * - NAV/shares/price updates per whitepaper Section 3
 *
 * Phase 4 Scope Notes:
 * - Withdrawal lag (D_lag) is stored but NOT enforced in processBatch.
 *   All pending withdrawals are processed immediately regardless of requestTimestamp.
 *   This is intentional for Phase 4 testing. Phase 5 will add eligibility checks:
 *   `block.timestamp >= requestTimestamp + withdrawLag`
 * 
 * - Deposit dust refund: Per whitepaper C.1(b1), A_used = S_mint * P is added to NAV,
 *   and A - A_used is refunded. In Phase 4, per-user refund tracking is not implemented;
 *   dust accumulates in the contract. Phase 5 will add individual request IDs and refunds.
 *
 * - NAV underflow: If P&L would make NAV negative, processBatch reverts with NAVUnderflow.
 *   The Safety Layer (Phase 5) should prevent this via Backstop Grants (G_t).
 */
contract LPVaultModule is SignalsCoreStorage {
    using SafeERC20 for IERC20;
    using VaultAccountingLib for *;

    address private immutable self;

    // ============================================================
    // Events
    // ============================================================
    event DepositRequested(address indexed user, uint256 amount, uint64 timestamp);
    event WithdrawRequested(address indexed user, uint256 shares, uint64 timestamp);
    event DepositCancelled(address indexed user, uint256 amount);
    event WithdrawCancelled(address indexed user, uint256 shares);
    event BatchProcessed(
        uint256 indexed batchId,
        uint256 navPre,
        uint256 batchPrice,
        uint256 navPost,
        uint256 sharesPost,
        uint256 pricePost
    );
    event VaultSeeded(address indexed seeder, uint256 amount, uint256 shares);

    // ============================================================
    // Errors
    // ============================================================
    error NotDelegated();
    error VaultNotSeeded();
    error VaultAlreadySeeded();
    error InsufficientSeedAmount(uint256 provided, uint256 required);
    error NoPendingRequest();
    /// @dev Phase 5: Used in processBatch to enforce withdrawal lag (D_lag)
    ///      `if (block.timestamp < req.requestTimestamp + withdrawLag) revert RequestLagNotMet(...)`
    error RequestLagNotMet(uint64 requestTime, uint64 requiredTime);
    /// @dev Used in requestWithdraw to prevent DoS via excessive withdrawal requests
    error InsufficientShareBalance(uint256 requested, uint256 available);
    error ZeroAmount();
    /// @dev Prevents duplicate batch processing in the same block
    error BatchAlreadyProcessed();

    // ============================================================
    // Modifiers
    // ============================================================
    modifier onlyDelegated() {
        if (address(this) == self) revert NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    // ============================================================
    // Seeding
    // ============================================================

    /**
     * @notice Seed the vault with initial capital
     * @dev Must be called before any batch processing
     * @param seedAmount Initial deposit amount
     */
    function seedVault(uint256 seedAmount) external onlyDelegated {
        if (lpVault.isSeeded) revert VaultAlreadySeeded();
        if (seedAmount < minSeedAmount) {
            revert InsufficientSeedAmount(seedAmount, minSeedAmount);
        }

        // Transfer tokens from sender
        paymentToken.safeTransferFrom(msg.sender, address(this), seedAmount);

        // Initialize vault: 1:1 ratio at genesis
        lpVault.nav = seedAmount;
        lpVault.shares = seedAmount;
        lpVault.price = VaultAccountingLib.WAD;
        lpVault.pricePeak = VaultAccountingLib.WAD;
        lpVault.lastBatchTimestamp = uint64(block.timestamp);
        lpVault.isSeeded = true;

        emit VaultSeeded(msg.sender, seedAmount, seedAmount);
    }

    // ============================================================
    // Request Queue
    // ============================================================

    /**
     * @notice Request a deposit into the vault
     * @param amount Amount to deposit (will be transferred immediately)
     */
    function requestDeposit(uint256 amount) external onlyDelegated {
        if (amount == 0) revert ZeroAmount();
        if (!lpVault.isSeeded) revert VaultNotSeeded();

        // Transfer tokens immediately (held until batch)
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);

        // Record request
        VaultRequest storage req = userRequests[msg.sender];
        
        // If user has existing request, add to it
        if (req.isDeposit && req.amount > 0) {
            req.amount += amount;
        } else {
            // New request or convert from withdraw
            if (!req.isDeposit && req.amount > 0) {
                // User has pending withdraw - cannot have both
                revert NoPendingRequest(); // TODO: better error
            }
            req.amount = amount;
            req.requestTimestamp = uint64(block.timestamp);
            req.isDeposit = true;
        }

        // Update queue totals
        vaultQueue.pendingDeposits += amount;

        emit DepositRequested(msg.sender, amount, uint64(block.timestamp));
    }

    /**
     * @notice Request a withdrawal from the vault
     * @dev Phase 4: Validates total pending withdraws <= vault shares to prevent DoS.
     *      Phase 5 will add per-user share balance validation via ERC-4626 token.
     * @param shares Number of shares to withdraw
     */
    function requestWithdraw(uint256 shares) external onlyDelegated {
        if (shares == 0) revert ZeroAmount();
        if (!lpVault.isSeeded) revert VaultNotSeeded();

        // Phase 4 DoS prevention: ensure total pending withdraws don't exceed vault shares
        // This prevents attackers from requesting more shares than exist, which would
        // cause processBatch to revert with InsufficientShares and block all batches.
        // 
        // Phase 5 TODO: Add per-user share balance check via ERC-4626 token:
        // if (shareToken.balanceOf(msg.sender) < shares) revert InsufficientShareBalance(shares, shareToken.balanceOf(msg.sender));
        uint256 newTotalPendingWithdraws = vaultQueue.pendingWithdraws + shares;
        if (newTotalPendingWithdraws > lpVault.shares) {
            revert InsufficientShareBalance(newTotalPendingWithdraws, lpVault.shares);
        }

        VaultRequest storage req = userRequests[msg.sender];
        
        if (!req.isDeposit && req.amount > 0) {
            req.amount += shares;
        } else {
            if (req.isDeposit && req.amount > 0) {
                revert NoPendingRequest(); // TODO: better error - PendingDepositExists
            }
            req.amount = shares;
            req.requestTimestamp = uint64(block.timestamp);
            req.isDeposit = false;
        }

        vaultQueue.pendingWithdraws += shares;

        emit WithdrawRequested(msg.sender, shares, uint64(block.timestamp));
    }

    /**
     * @notice Cancel a pending deposit request
     */
    function cancelDeposit() external onlyDelegated {
        VaultRequest storage req = userRequests[msg.sender];
        if (!req.isDeposit || req.amount == 0) revert NoPendingRequest();

        uint256 amount = req.amount;
        
        // Clear request
        req.amount = 0;
        req.requestTimestamp = 0;

        // Update queue
        vaultQueue.pendingDeposits -= amount;

        // Return tokens
        paymentToken.safeTransfer(msg.sender, amount);

        emit DepositCancelled(msg.sender, amount);
    }

    /**
     * @notice Cancel a pending withdrawal request
     */
    function cancelWithdraw() external onlyDelegated {
        VaultRequest storage req = userRequests[msg.sender];
        if (req.isDeposit || req.amount == 0) revert NoPendingRequest();

        uint256 shares = req.amount;

        // Clear request
        req.amount = 0;
        req.requestTimestamp = 0;

        // Update queue
        vaultQueue.pendingWithdraws -= shares;

        // TODO: Restore shares to user (requires LP share token)

        emit WithdrawCancelled(msg.sender, shares);
    }

    // ============================================================
    // Batch Processing
    // ============================================================

    /**
     * @notice Process daily batch
     * @dev Applies P&L, then processes withdrawals, then deposits
     * 
     *      IMPORTANT: This function resets all pending requests to prevent
     *      cancel underflow bugs. After batch processing, userRequests[user].amount
     *      is cleared via _clearProcessedRequests().
     * 
     * @param pnl CLMSR P&L for the day (signed, WAD)
     * @param fees LP-attributed fees (WAD)
     * @param grant Backstop grant (WAD)
     * @param processedUsers Array of users whose requests were processed
     */
    function processBatch(
        int256 pnl,
        uint256 fees,
        uint256 grant,
        address[] calldata processedUsers
    ) external onlyDelegated {
        if (!lpVault.isSeeded) revert VaultNotSeeded();
        
        // Prevent duplicate batch in same block
        if (lpVault.lastBatchTimestamp == uint64(block.timestamp)) {
            revert BatchAlreadyProcessed();
        }

        // Step 1: Compute pre-batch NAV and price
        VaultAccountingLib.PreBatchInputs memory inputs = VaultAccountingLib.PreBatchInputs({
            navPrev: lpVault.nav,
            sharesPrev: lpVault.shares,
            pnl: pnl,
            fees: fees,
            grant: grant
        });

        VaultAccountingLib.PreBatchResult memory preBatch = VaultAccountingLib.computePreBatch(inputs);

        // Step 2: Process withdrawals first (at batch price)
        uint256 currentNav = preBatch.navPre;
        uint256 currentShares = lpVault.shares;

        if (vaultQueue.pendingWithdraws > 0) {
            (currentNav, currentShares, ) = VaultAccountingLib.applyWithdraw(
                currentNav,
                currentShares,
                preBatch.batchPrice,
                vaultQueue.pendingWithdraws
            );
            vaultQueue.pendingWithdraws = 0;
        }

        // Step 3: Process deposits (at batch price)
        // Per whitepaper C.1(b1): refund any deposit dust immediately
        uint256 totalRefund = 0;
        if (vaultQueue.pendingDeposits > 0) {
            uint256 refundAmount;
            (currentNav, currentShares, , refundAmount) = VaultAccountingLib.applyDeposit(
                currentNav,
                currentShares,
                preBatch.batchPrice,
                vaultQueue.pendingDeposits
            );
            totalRefund = refundAmount;
            vaultQueue.pendingDeposits = 0;
        }
        
        // Note: In Phase 4, per-user refund tracking is not implemented.
        // The totalRefund amount stays in the contract and will be handled
        // in Phase 5 when individual deposit requests are tracked with IDs.
        // For now, this dust (at most 1 wei per deposit) accumulates in the contract.

        // Step 4: Clear processed user requests to prevent cancel underflow
        // This is critical: without this, users could call cancelDeposit() after
        // their request was already processed, causing pendingDeposits underflow.
        _clearProcessedRequests(processedUsers);

        // Step 5: Compute final state
        VaultAccountingLib.PostBatchState memory postBatch = VaultAccountingLib.computePostBatchState(
            currentNav,
            currentShares,
            lpVault.pricePeak
        );

        // Step 6: Update storage
        lpVault.nav = postBatch.nav;
        lpVault.shares = postBatch.shares;
        lpVault.price = postBatch.price;
        lpVault.pricePeak = postBatch.pricePeak;
        lpVault.lastBatchTimestamp = uint64(block.timestamp);

        emit BatchProcessed(
            block.timestamp, // batchId = timestamp for now
            preBatch.navPre,
            preBatch.batchPrice,
            postBatch.nav,
            postBatch.shares,
            postBatch.price
        );
    }

    /**
     * @notice Clear processed user requests after batch
     * @dev Prevents cancel underflow by resetting userRequests[user].amount to 0
     *      for all users whose requests were processed in this batch.
     * 
     *      Phase 5 will replace this with request ID-based tracking.
     * 
     * @param users Array of user addresses whose requests were processed
     */
    function _clearProcessedRequests(address[] calldata users) internal {
        for (uint256 i = 0; i < users.length; i++) {
            VaultRequest storage req = userRequests[users[i]];
            req.amount = 0;
            req.requestTimestamp = 0;
        }
    }

    // ============================================================
    // View Functions
    // ============================================================

    /**
     * @notice Get vault NAV
     */
    function getVaultNav() external view returns (uint256) {
        return lpVault.nav;
    }

    /**
     * @notice Get vault shares
     */
    function getVaultShares() external view returns (uint256) {
        return lpVault.shares;
    }

    /**
     * @notice Get vault price
     */
    function getVaultPrice() external view returns (uint256) {
        return lpVault.price;
    }

    /**
     * @notice Check if vault is seeded
     */
    function isVaultSeeded() external view returns (bool) {
        return lpVault.isSeeded;
    }

    /**
     * @notice Get pending deposits total
     */
    function getPendingDeposits() external view returns (uint256) {
        return vaultQueue.pendingDeposits;
    }

    /**
     * @notice Get pending withdrawals total
     */
    function getPendingWithdraws() external view returns (uint256) {
        return vaultQueue.pendingWithdraws;
    }
}

