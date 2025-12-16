// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-point math utilities (WAD = 1e18) ported from v0.
library FixedPointMathU {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SCALE_DIFF = 1e12; // 6-dec → 18-dec
    uint256 internal constant HALF_SCALE = SCALE_DIFF / 2;

    error FP_DivisionByZero();
    error FP_InvalidInput();

    /// @dev 6-decimal → 18-decimal (multiply by 1e12)
    function toWad(uint256 x) internal pure returns (uint256) {
        unchecked {
            return x * SCALE_DIFF;
        }
    }

    /// @dev 18-decimal → 6-decimal (truncates)
    function fromWad(uint256 x) internal pure returns (uint256) {
        return x / SCALE_DIFF;
    }

    /// @dev 18-decimal → 6-decimal with round-up (prevents zero-cost attacks)
    function fromWadRoundUp(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        return ((x - 1) / SCALE_DIFF) + 1;
    }

    /// @dev 18-decimal → 6-decimal nearest (ties up)
    function fromWadNearest(uint256 x) internal pure returns (uint256) {
        uint256 quotient = x / SCALE_DIFF;
        uint256 remainder = x % SCALE_DIFF;
        if (remainder >= HALF_SCALE) {
            unchecked {
                quotient += 1;
            }
        }
        return quotient;
    }

    function fromWadNearestMin1(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 res = fromWadNearest(x);
        return res == 0 ? 1 : res;
    }

    function wMul(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            return (x * y) / WAD;
        }
    }

    /// @dev WAD multiply with round-up (ceil)
    /// @notice Used for conservative calculations where under-estimation is unsafe
    /// Per whitepaper: ceil semantics required for Nfloor calculation to ensure
    /// grantNeed is never under-estimated (drawdown floor is an invariant)
    function wMulUp(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            uint256 product = x * y;
            // (product + WAD - 1) / WAD, but handle zero case
            return product == 0 ? 0 : (product - 1) / WAD + 1;
        }
    }

    function wMulNearest(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            return (x * y + WAD / 2) / WAD;
        }
    }

    function wDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert FP_DivisionByZero();
        unchecked {
            return (x * WAD) / y;
        }
    }

    function wDivUp(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert FP_DivisionByZero();
        unchecked {
            return (x * WAD + y - 1) / y;
        }
    }

    function wDivNearest(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert FP_DivisionByZero();
        unchecked {
            return (x * WAD + y / 2) / y;
        }
    }

    /// @notice Exponential using Taylor series approximation (same as v0 PRB-math style).
    function wExp(uint256 xWad) internal pure returns (uint256) {
        // Adapted from PRBMathUD60x18 exp implementation.
        uint256 x = xWad;
        uint256 term = WAD;
        uint256 sum = WAD;
        for (uint256 i = 1; i < 20; i++) {
            term = (term * x) / (WAD * i);
            sum += term;
            if (term == 0) break;
        }
        return sum;
    }

    /// @notice Natural log using series approximation around 1; input must be > 0.
    function wLn(uint256 xWad) internal pure returns (uint256) {
        if (xWad == 0) revert FP_InvalidInput();
        // Simple iterative approximation: ln(x) ~ 2 * atanh((x-1)/(x+1))
        uint256 num = xWad > WAD ? xWad - WAD : WAD - xWad;
        uint256 den = xWad + WAD;
        uint256 z = wDiv(num, den);
        uint256 zPow = z;
        uint256 res = 0;
        // 10 terms of series
        for (uint256 i = 1; i < 20; i += 2) {
            uint256 term = wDiv(zPow, i);
            res += term;
            zPow = wMul(zPow, wMul(z, z));
        }
        res = wMul(res, 2);
        if (xWad < WAD) {
            return WAD - res;
        }
        return res + 0;
    }

    // ============================================================
    // Phase 7: Safe ln(n) for α Safety Bounds
    // ============================================================

    /// @notice Pre-computed ln values in WAD precision (rounded UP for safety)
    /// @dev ln(n) values computed with high precision, rounded up to ensure
    ///      α_base = λE/ln(n) is CONSERVATIVE (smaller α_base = safer)
    ///      
    ///      Per whitepaper v2: α_base must never exceed the safety bound.
    ///      By over-estimating ln(n), we under-estimate α_base, which is safe.
    uint256 internal constant LN_2 = 693147180559945310;      // ln(2) + 1 wei
    uint256 internal constant LN_5 = 1609437912434100375;     // ln(5) + 1 wei
    uint256 internal constant LN_10 = 2302585092994045685;    // ln(10) + 1 wei
    uint256 internal constant LN_20 = 2995732273553991095;    // ln(20) + 1 wei
    uint256 internal constant LN_50 = 3912023005428146060;    // ln(50) + 1 wei
    uint256 internal constant LN_100 = 4605170185988091369;   // ln(100) + 1 wei
    uint256 internal constant LN_200 = 5298317366548036678;   // ln(200) + 1 wei
    uint256 internal constant LN_500 = 6214608098422191781;   // ln(500) + 1 wei
    uint256 internal constant LN_1000 = 6907755278982137053;  // ln(1000) + 1 wei
    uint256 internal constant LN_2000 = 7600902459542082362;  // ln(2000) + 1 wei
    uint256 internal constant LN_5000 = 8517193191416237509;  // ln(5000) + 1 wei
    uint256 internal constant LN_10000 = 9210340371976182818; // ln(10000) + 1 wei

    /// @notice Calculate ln(n) with safe (upward) rounding for α calculation
    /// @dev Returns ln(n) in WAD, rounded UP to ensure α_base is conservative
    ///      
    ///      SAFETY CRITICAL: ln is concave, so linear interpolation underestimates.
    ///      Underestimating ln(n) → overestimating α_base → UNSAFE.
    ///      This function returns the NEXT higher lookup value's ln to ensure
    ///      we OVER-estimate ln(n), making α_base SMALLER (conservative/safe).
    ///
    /// @param n Number of bins (integer, not WAD)
    /// @return lnN ln(n) in WAD, rounded up for safety
    function lnWadUp(uint256 n) internal pure returns (uint256 lnN) {
        if (n <= 1) return 0; // ln(1) = 0
        
        // Use exact values for common cases (with +1 wei safety margin)
        if (n == 2) return LN_2;
        if (n <= 5) return LN_5;
        if (n <= 10) return LN_10;
        if (n <= 20) return LN_20;
        if (n <= 50) return LN_50;
        if (n <= 100) return LN_100;
        if (n <= 200) return LN_200;
        if (n <= 500) return LN_500;
        if (n <= 1000) return LN_1000;
        if (n <= 2000) return LN_2000;
        if (n <= 5000) return LN_5000;
        if (n <= 10000) return LN_10000;
        
        // For n > 10000, use conservative upper bound
        // ln(n) < ln(10000) + (n - 10000) / 10000 for large n
        // This over-estimates ln(n), making α_base smaller (safe)
        // Actually, use digits-based upper bound: ln(n) < digits * ln(10)
        uint256 digits = 0;
        uint256 temp = n;
        while (temp >= 10) {
            temp /= 10;
            digits++;
        }
        // Upper bound: (digits + 1) * ln(10) (always over-estimates)
        return (digits + 1) * LN_10;
    }
}
