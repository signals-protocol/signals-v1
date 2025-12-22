// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathU} from "../../../lib/FixedPointMathU.sol";
import {SignalsErrors as SE} from "../../../errors/SignalsErrors.sol";

/// @notice Dense lazy multiplication segment tree for CLMSR math.
/// @dev Uses 1-based implicit indexing: root=1, left=2i, right=2i+1.
///      Lazy sentinel: lazy[i]==0 means ONE_WAD (saves SSTORE on seed).
///      Maintains rebalanceChildren for numerical stability.
///      CRITICAL: Leaves NEVER store lazy (always ONE_WAD), only internal nodes do.
///      CRITICAL: Push path applies flush policy to prevent lazy underflow/overflow.
library LazyMulSegmentTree {
    using FixedPointMathU for uint256;

    uint256 public constant ONE_WAD = 1e18;
    uint256 public constant MIN_FACTOR = 0.01e18;
    uint256 public constant MAX_FACTOR = 100e18;
    uint256 public constant FLUSH_THRESHOLD = 1e21;
    uint256 public constant UNDERFLOW_FLUSH_THRESHOLD = 1e15;

    /// @dev Maximum supported bin count (prevents excessive gas)
    uint32 private constant MAX_BINS = 512;

    /// @dev Root index for 1-based implicit indexing
    uint32 private constant ROOT = 1;

    /// @notice Dense segment tree storage (SoA layout for gas efficiency)
    /// @dev 1-based indexing: sum[1] is root, sum[2*i] is left child, sum[2*i+1] is right child.
    ///      lazy[i]==0 is sentinel for ONE_WAD (no pending factor).
    struct Tree {
        uint256[] sum; // Node sums (1-based)
        uint256[] lazy; // Pending factors (1-based, 0 = ONE_WAD sentinel)
        uint32 size; // Number of leaves (bins)
    }

    // ============================================================
    // Public API
    // ============================================================

    /// @notice Initialize tree with given size
    /// @dev Arrays are allocated but not filled; seedWithFactors must be called next.
    function init(Tree storage tree, uint32 treeSize) external {
        require(treeSize != 0, SE.TreeSizeZero());
        require(tree.size == 0, SE.TreeAlreadyInitialized());
        require(treeSize <= MAX_BINS, SE.TreeSizeTooLarge());

        // Capacity: 4*size + 4 is safe upper bound for segment tree nodes
        uint32 cap = 4 * treeSize + 4;
        uint256 length = uint256(cap) + 1;

        tree.size = treeSize;

        // Allocate arrays with capacity (1-based, so cap+1)
        // Using assembly to set length without zeroing (gas optimization)
        // Note: This is safe only if seedWithFactors is called immediately after,
        //       which explicitly initializes all accessed slots.
        // Storage layout: Tree { sum[] (slot 0), lazy[] (slot 1), size (slot 2) }
        // Dynamic array slot stores length directly; data is at keccak256(slot)
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(tree.slot, length) // sum.length
            sstore(add(tree.slot, 1), length) // lazy.length
        }
    }

    /// @notice Apply multiplicative factor to range [lo, hi]
    function applyRangeFactor(Tree storage tree, uint32 lo, uint32 hi, uint256 factor) external {
        require(tree.size != 0, SE.TreeNotInitialized());
        require(lo <= hi, SE.InvalidRange(lo, hi));
        require(hi < tree.size, SE.IndexOutOfBounds(hi, tree.size));
        require(factor >= MIN_FACTOR && factor <= MAX_FACTOR, SE.InvalidFactor(factor));

        _applyFactorRecursive(tree, ROOT, 0, tree.size - 1, lo, hi, factor);
    }

    /// @notice Get sum of range [lo, hi] (view, no state change)
    function getRangeSum(Tree storage tree, uint32 lo, uint32 hi) external view returns (uint256) {
        require(tree.size != 0, SE.TreeNotInitialized());
        require(lo <= hi, SE.InvalidRange(lo, hi));
        require(hi < tree.size, SE.IndexOutOfBounds(hi, tree.size));

        return _sumRangeWithAccFactor(tree, ROOT, 0, tree.size - 1, lo, hi, ONE_WAD);
    }

    /// @notice Propagate lazy values and return range sum (state-changing)
    function propagateLazy(Tree storage tree, uint32 lo, uint32 hi) external returns (uint256) {
        require(tree.size != 0, SE.TreeNotInitialized());
        require(lo <= hi, SE.InvalidRange(lo, hi));
        require(hi < tree.size, SE.IndexOutOfBounds(hi, tree.size));

        return _queryRecursive(tree, ROOT, 0, tree.size - 1, lo, hi);
    }

    /// @notice Get total sum of all leaves (Z value for CLMSR)
    function totalSum(Tree storage tree) internal view returns (uint256) {
        require(tree.size != 0, SE.TreeNotInitialized());
        return tree.sum[ROOT];
    }

    /// @notice Build tree from array of factors
    /// @dev Must be called after init(). Builds entire tree structure.
    ///      CRITICAL: Explicitly initializes lazy to 0 (sentinel) to handle re-initialization.
    function seedWithFactors(Tree storage tree, uint256[] memory factors) internal {
        require(tree.size != 0, SE.TreeNotInitialized());
        require(factors.length == tree.size, SE.ArrayLengthMismatch());

        _buildFromArray(tree, ROOT, 0, tree.size - 1, factors);
    }

    // ============================================================
    // Internal Helpers
    // ============================================================

    /// @dev Get left child index (implicit indexing)
    function _left(uint32 i) private pure returns (uint32) {
        return i << 1;
    }

    /// @dev Get right child index (implicit indexing)
    function _right(uint32 i) private pure returns (uint32) {
        return (i << 1) | 1;
    }

    /// @dev Read lazy value with sentinel: 0 means ONE_WAD
    function _lazyVal(Tree storage tree, uint32 i) private view returns (uint256) {
        uint256 v = tree.lazy[i];
        return v == 0 ? ONE_WAD : v;
    }

    /// @dev Store lazy value with sentinel: ONE_WAD stored as 0
    function _storeLazy(Tree storage tree, uint32 i, uint256 val) private {
        tree.lazy[i] = (val == ONE_WAD) ? 0 : val;
    }

    /// @dev Multiply value by factor with WAD compensation
    function _mulWithCompensation(uint256 value, uint256 factor) private pure returns (uint256) {
        if (value == 0 || factor == ONE_WAD) return value;
        return value.wMulNearest(factor);
    }

    /// @dev Combine two factors via WAD multiplication (with ONE_WAD shortcut)
    function _combineFactors(uint256 lhs, uint256 rhs) private pure returns (uint256) {
        if (rhs == ONE_WAD) return lhs;
        if (lhs == ONE_WAD) return rhs;
        return lhs.wMulNearest(rhs);
    }

    /// @dev Rebalance children sums to match parent's target sum
    /// @notice CRITICAL: This maintains numerical accuracy after factor multiplication
    function _rebalanceChildren(Tree storage tree, uint32 left, uint32 right, uint256 target) private {
        uint256 combined = tree.sum[left] + tree.sum[right];
        if (combined == target) return;

        if (combined < target) {
            tree.sum[right] += target - combined;
            return;
        }

        uint256 surplus = combined - target;
        uint256 rightSum = tree.sum[right];
        if (surplus <= rightSum) {
            tree.sum[right] = rightSum - surplus;
            return;
        }

        uint256 remaining = surplus - rightSum;
        tree.sum[right] = 0;
        uint256 leftSum = tree.sum[left];
        require(remaining <= leftSum, SE.MathMulOverflow());
        tree.sum[left] = leftSum - remaining;
    }

    /// @dev Apply factor to a child node with complete cover semantics (includes flush policy)
    /// @notice CRITICAL: This prevents lazy underflow (0) or overflow in push path
    /// @param tree The segment tree
    /// @param j Child node index
    /// @param l Left bound of child's range
    /// @param r Right bound of child's range
    /// @param factor Factor to apply
    function _applyFactorToChildWithFlush(
        Tree storage tree,
        uint32 j,
        uint32 l,
        uint32 r,
        uint256 factor
    ) private {
        if (factor == ONE_WAD) return;

        // Leaf node: NEVER store lazy, just update sum
        if (l == r) {
            tree.sum[j] = _mulWithCompensation(tree.sum[j], factor);
            // lazy[j] stays 0 (ONE_WAD sentinel) - leaves don't accumulate pending
            return;
        }

        // Internal node: apply with flush policy (same as complete cover in _applyFactorRecursive)
        uint256 priorPending = _lazyVal(tree, j);
        uint256 combinedPending = _combineFactors(priorPending, factor);

        // Flush if pending factor goes out of safe range OR if combined becomes exactly ONE
        // (exact ONE case: priorPending != ONE but combined rounds to ONE -> subrange query mismatch)
        if (
            priorPending != ONE_WAD &&
            (combinedPending < UNDERFLOW_FLUSH_THRESHOLD || combinedPending > FLUSH_THRESHOLD || combinedPending == ONE_WAD)
        ) {
            _pushPendingFactor(tree, j, l, r);
            priorPending = ONE_WAD; // After push, lazy is reset to ONE
            combinedPending = factor;
        }

        tree.sum[j] = _mulWithCompensation(tree.sum[j], factor);
        uint256 newPending = _combineFactors(priorPending, factor);

        if (newPending < UNDERFLOW_FLUSH_THRESHOLD) {
            // Underflow case: store just the factor and push immediately
            _storeLazy(tree, j, factor);
            _pushPendingFactor(tree, j, l, r);
        } else if (newPending > FLUSH_THRESHOLD) {
            // Overflow case: store just the factor and push immediately
            _storeLazy(tree, j, factor);
            _pushPendingFactor(tree, j, l, r);
        } else {
            // Safe range: accumulate
            require(newPending <= type(uint192).max, SE.LazyFactorOverflow());
            _storeLazy(tree, j, newPending);
        }
    }

    /// @dev Push pending factor to children
    /// @notice CRITICAL: Maintains rebalance for numerical stability
    ///         Uses _applyFactorToChildWithFlush to prevent lazy underflow/overflow
    function _pushPendingFactor(Tree storage tree, uint32 i, uint32 l, uint32 r) private {
        uint256 pending = _lazyVal(tree, i);
        if (pending == ONE_WAD) return;

        // Leaf node: no children to push to, just clear lazy
        if (l == r) {
            _storeLazy(tree, i, ONE_WAD);
            return;
        }

        uint32 leftChild = _left(i);
        uint32 rightChild = _right(i);
        uint32 mid = l + (r - l) / 2;

        // Apply factor to children WITH flush policy (prevents lazy underflow/overflow)
        _applyFactorToChildWithFlush(tree, leftChild, l, mid, pending);
        _applyFactorToChildWithFlush(tree, rightChild, mid + 1, r, pending);

        // CRITICAL: Rebalance to maintain sum invariant
        _rebalanceChildren(tree, leftChild, rightChild, tree.sum[i]);

        _storeLazy(tree, i, ONE_WAD);
    }

    /// @dev Apply factor to range [lo, hi] recursively
    function _applyFactorRecursive(
        Tree storage tree,
        uint32 i,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi,
        uint256 factor
    ) private {
        if (r < lo || l > hi) return;

        // Complete cover: apply factor to this node
        if (l >= lo && r <= hi) {
            // Leaf node: NEVER store lazy, just update sum
            if (l == r) {
                tree.sum[i] = _mulWithCompensation(tree.sum[i], factor);
                // lazy[i] stays 0 (ONE_WAD sentinel) - leaves don't accumulate pending
                return;
            }

            // Internal node: apply with flush policy
            uint256 priorPending = _lazyVal(tree, i);
            uint256 combinedPending = _combineFactors(priorPending, factor);

            // Flush if pending factor goes out of safe range OR if combined becomes exactly ONE
            // (exact ONE case: priorPending != ONE but combined rounds to ONE -> subrange query mismatch)
            if (
                priorPending != ONE_WAD &&
                (combinedPending < UNDERFLOW_FLUSH_THRESHOLD || combinedPending > FLUSH_THRESHOLD || combinedPending == ONE_WAD)
            ) {
                _pushPendingFactor(tree, i, l, r);
                priorPending = ONE_WAD; // After push, lazy is reset to ONE
            }

            tree.sum[i] = _mulWithCompensation(tree.sum[i], factor);
            uint256 newPending = _combineFactors(priorPending, factor);

            if (newPending < UNDERFLOW_FLUSH_THRESHOLD) {
                _storeLazy(tree, i, factor);
                _pushPendingFactor(tree, i, l, r);
            } else if (newPending > FLUSH_THRESHOLD) {
                _storeLazy(tree, i, factor);
                _pushPendingFactor(tree, i, l, r);
            } else {
                require(newPending <= type(uint192).max, SE.LazyFactorOverflow());
                _storeLazy(tree, i, newPending);
            }

            return;
        }

        // Partial overlap: push and recurse
        _pushPendingFactor(tree, i, l, r);

        uint32 mid = l + (r - l) / 2;
        uint32 leftChild = _left(i);
        uint32 rightChild = _right(i);

        if (lo <= mid) {
            _applyFactorRecursive(tree, leftChild, l, mid, lo, hi, factor);
        }
        if (hi > mid) {
            _applyFactorRecursive(tree, rightChild, mid + 1, r, lo, hi, factor);
        }

        // Pull up sum from children
        tree.sum[i] = tree.sum[leftChild] + tree.sum[rightChild];
    }

    /// @dev Query range sum with accumulated factor (view, no state change)
    function _sumRangeWithAccFactor(
        Tree storage tree,
        uint32 i,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi,
        uint256 accFactor
    ) private view returns (uint256) {
        if (r < lo || l > hi) return 0;

        // Complete cover: return scaled sum
        if (l >= lo && r <= hi) {
            return _mulWithCompensation(tree.sum[i], accFactor);
        }

        // Partial overlap: accumulate pending factor and recurse
        uint256 nodeLazy = _lazyVal(tree, i);
        uint256 newAccFactor = _combineFactors(accFactor, nodeLazy);
        uint32 mid = l + (r - l) / 2;

        uint256 leftSum = _sumRangeWithAccFactor(tree, _left(i), l, mid, lo, hi, newAccFactor);
        uint256 rightSum = _sumRangeWithAccFactor(tree, _right(i), mid + 1, r, lo, hi, newAccFactor);
        return leftSum + rightSum;
    }

    /// @dev Query range sum with lazy propagation (state-changing)
    function _queryRecursive(
        Tree storage tree,
        uint32 i,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi
    ) private returns (uint256) {
        if (r < lo || l > hi) return 0;

        // Complete cover: return sum
        if (l >= lo && r <= hi) {
            return tree.sum[i];
        }

        // Partial overlap: push and recurse
        _pushPendingFactor(tree, i, l, r);
        uint32 mid = l + (r - l) / 2;

        uint256 leftSum = _queryRecursive(tree, _left(i), l, mid, lo, hi);
        uint256 rightSum = _queryRecursive(tree, _right(i), mid + 1, r, lo, hi);
        return leftSum + rightSum;
    }

    /// @dev Build tree from factors array (recursive)
    /// @notice CRITICAL: Explicitly initializes lazy to 0 (sentinel) to handle re-initialization.
    function _buildFromArray(
        Tree storage tree,
        uint32 i,
        uint32 l,
        uint32 r,
        uint256[] memory factors
    ) private returns (uint256) {
        // CRITICAL: Explicitly set lazy to 0 (ONE_WAD sentinel) to handle re-initialization
        // This ensures stale lazy values from previous use are cleared
        tree.lazy[i] = 0;

        if (l == r) {
            // Leaf node
            uint256 leafValue = factors[l];
            tree.sum[i] = leafValue;
            return leafValue;
        }

        // Internal node: recursively build children
        uint32 mid = l + (r - l) / 2;
        uint256 leftSum = _buildFromArray(tree, _left(i), l, mid, factors);
        uint256 rightSum = _buildFromArray(tree, _right(i), mid + 1, r, factors);

        uint256 total = leftSum + rightSum;
        tree.sum[i] = total;
        return total;
    }
}
