# Vault Fee Waterfall Specification (Phase 5)

> **백서 Appendix A.2/A.3 · Sec 4.3~4.6의 Fee Waterfall 수학을 온체인 라이브러리로 구현하기 위한 상세 스펙**

## 1. Overview

Fee Waterfall은 각 배치(일일) 결산 시 발생하는 P&L과 수수료를 다음 순서로 처리합니다:

```
Settlement → Loss Compensation → Drawdown Floor & Grant → Backstop Fill → Residual Split → NAV Update
```

## 2. Input Variables

### 2.1 From Settlement/Trade

| 변수 | 타입 | 설명 | 소스 |
|------|------|------|------|
| `Lt` | int256 | 해당 배치의 CLMSR P&L (양수=이익, 음수=손실) | `settleMarket()` 집계 |
| `Ftot,t` | uint256 | 해당 배치의 총 gross fee | `TradeModule` fee 집계 |

### 2.2 From Previous State

| 변수 | 타입 | 설명 | 소스 |
|------|------|------|------|
| `Nt-1` | uint256 | 이전 배치 종료 후 Vault NAV | `VaultState.nav` |
| `Bt-1` | uint256 | 이전 배치 종료 후 Backstop NAV | `CapitalStackState.backstopNav` |
| `Tt-1` | uint256 | 이전 배치 종료 후 Treasury NAV | `CapitalStackState.treasuryNav` |

### 2.3 From RiskModule

| 변수 | 타입 | 설명 | 소스 |
|------|------|------|------|
| `ΔEt` | uint256 | 해당 배치에서 사용 가능한 Backstop 지원 한도 | `RiskModule.getDeltaEt()` |

### 2.4 Config Parameters

| 파라미터 | 타입 | 설명 | 제안 초기값 |
|----------|------|------|-------------|
| `pdd` | int256 | Drawdown floor (음수, e.g., -0.3 = -30%) | -0.3e18 |
| `ρBS` | uint256 | Backstop coverage target ratio | 0.2e18 (20%) |
| `ϕLP` | uint256 | LP residual fee share | 0.7e18 (70%) |
| `ϕBS` | uint256 | Backstop residual fee share | 0.2e18 (20%) |
| `ϕTR` | uint256 | Treasury residual fee share | 0.1e18 (10%) |

**제약조건:** `ϕLP + ϕBS + ϕTR = 1e18`

---

## 3. Fee Waterfall Algorithm

### Step 1: Loss Compensation

**목적:** 손실이 발생한 경우, 수수료에서 먼저 손실을 메꿈

```
L⁻t = max(0, -Lt)                    // 손실의 절대값 (이익이면 0)
Floss,t = min(Ftot,t, L⁻t)           // 손실 보전에 사용되는 수수료
Fpool,t = Ftot,t - Floss,t           // 잔여 수수료 풀
Nraw,t = Nt-1 + Lt + Floss,t         // 손실 보전 후 raw NAV
```

**인바리언트:** `Floss,t + Fpool,t = Ftot,t` (수수료 보존)

### Step 2: Drawdown Floor & Grant

**목적:** NAV가 drawdown floor 아래로 떨어지는 것을 방지하기 위해 Backstop에서 Grant 지원

```
Nfloor,t = Nt-1 × (1 + pdd)          // Drawdown floor NAV (pdd는 음수)
grantNeed = max(0, Nfloor,t - Nraw,t) // 필요한 지원 금액
Gt = min(ΔEt, grantNeed)             // 실제 Grant (ΔEt로 상한)

// Backstop 검증
require(Gt ≤ Bt-1, "InsufficientBackstopForGrant")

Ngrant,t = Nraw,t + Gt               // Grant 적용 후 NAV
Bgrant,t = Bt-1 - Gt                 // Grant 지급 후 Backstop
```

### Step 3: Backstop Coverage Target

**목적:** Backstop이 목표 coverage ratio를 유지하도록 수수료에서 충당

```
Btarget,t = ρBS × Ngrant,t           // 목표 Backstop NAV
ΔBneed = max(0, Btarget,t - Bgrant,t) // 필요한 Backstop 충당액
Ffill,t = min(ΔBneed, Fpool,t)       // 실제 충당액 (수수료 풀 한도)
Fremain,t = Fpool,t - Ffill,t        // 충당 후 잔여 수수료
```

### Step 4: Residual Split

**목적:** 남은 수수료를 LP/Backstop/Treasury에 분배

```
FcoreLP,t = floor(Fremain,t × ϕLP / WAD)
FcoreBS,t = floor(Fremain,t × ϕBS / WAD)
FcoreTR,t = floor(Fremain,t × ϕTR / WAD)

// Dust는 LP에게 귀속 (백서 규정)
Fdust,t = Fremain,t - FcoreLP,t - FcoreBS,t - FcoreTR,t
```

**인바리언트:** `FcoreLP,t + FcoreBS,t + FcoreTR,t + Fdust,t = Fremain,t`

### Step 5: Final Output Values

```
// LP에게 귀속되는 총 수수료
Ft = Floss,t + FcoreLP,t + Fdust,t

// Pre-batch NAV (VaultAccountingLib로 전달)
Npre,t = Ngrant,t + FcoreLP,t

// 최종 Capital Stack 상태
Bnext = Bgrant,t + Ffill,t + FcoreBS,t
Tnext = Tt-1 + FcoreTR,t
```

---

## 4. Solidity Interface

### 4.1 FeeWaterfallLib

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library FeeWaterfallLib {
    struct Params {
        int256 Lt;           // P&L (signed)
        uint256 Ftot;        // Total gross fees
        uint256 Nprev;       // Previous NAV
        uint256 Bprev;       // Previous Backstop NAV
        uint256 Tprev;       // Previous Treasury NAV
        uint256 deltaEt;     // Available backstop support
        int256 pdd;          // Drawdown floor (negative, WAD)
        uint256 rhoBS;       // Backstop coverage ratio (WAD)
        uint256 phiLP;       // LP fee share (WAD)
        uint256 phiBS;       // Backstop fee share (WAD)
        uint256 phiTR;       // Treasury fee share (WAD)
    }

    struct Result {
        // Intermediate values (for audit/debugging)
        uint256 Floss;       // Loss compensation
        uint256 Fpool;       // Remaining fee pool
        uint256 Nraw;        // NAV after loss compensation
        uint256 Gt;          // Backstop grant
        uint256 Ffill;       // Backstop coverage fill
        uint256 Fdust;       // Rounding dust (to LP)
        
        // Output values
        uint256 Ft;          // Total fee to LP (Floss + FcoreLP + Fdust)
        uint256 Npre;        // Pre-batch NAV (for VaultAccountingLib)
        uint256 Bnext;       // New Backstop NAV
        uint256 Tnext;       // New Treasury NAV
    }

    error InsufficientBackstopForGrant(uint256 required, uint256 available);
    error InvalidPhiSum(uint256 sum);

    function apply(Params memory p) internal pure returns (Result memory r);
}
```

### 4.2 Storage Structures

```solidity
// In SignalsCoreStorage.sol

/// @notice Capital stack (Backstop + Treasury) state
struct CapitalStackState {
    uint256 backstopNav;     // B_t
    uint256 treasuryNav;     // T_t
}

/// @notice Daily P&L snapshot for batch processing
struct DailyPnlSnapshot {
    int256 Lt;               // Aggregated P&L
    uint256 Ftot;            // Aggregated gross fees
    uint256 Npre;            // Pre-batch NAV (after Fee Waterfall)
    uint256 Pe;              // Batch equity price
    uint256 Gt;              // Grant used
    bool processed;          // Whether this batch has been processed
}

/// @notice Fee waterfall configuration
struct FeeWaterfallConfig {
    int256 pdd;              // Drawdown floor (negative WAD, e.g., -0.3e18)
    uint256 rhoBS;           // Backstop coverage ratio (WAD)
    uint256 phiLP;           // LP residual share (WAD)
    uint256 phiBS;           // Backstop residual share (WAD)
    uint256 phiTR;           // Treasury residual share (WAD)
}

// Storage slots
mapping(uint64 => DailyPnlSnapshot) internal _dailyPnl;
CapitalStackState internal capitalStack;
FeeWaterfallConfig internal feeWaterfallConfig;
```

---

## 5. Test Cases

### 5.1 Case Matrix

| Case | Lt | Ftot 조건 | Backstop 조건 | 예상 결과 |
|------|-----|-----------|---------------|-----------|
| 1 | ≥ 0 | > 0 | N/A | Grant=0, 전체 수수료 분배 |
| 2 | < 0 | ≥ \|Lt\| | N/A | Grant=0, Loss 커버 후 분배 |
| 3 | < 0 | < \|Lt\| | Gt ≤ Bt-1 | Grant 발생, Backstop 차감 |
| 4 | < 0 | < \|Lt\| | Gt > Bt-1 | Revert: InsufficientBackstopForGrant |

### 5.2 Example Calculation (Case 3)

```
Input:
  Lt = -100e18 (100 loss)
  Ftot = 20e18 (20 fees)
  Nprev = 1000e18
  Bprev = 200e18
  pdd = -0.3e18 (-30%)
  ρBS = 0.2e18 (20%)
  ϕLP = 0.7e18, ϕBS = 0.2e18, ϕTR = 0.1e18

Step 1: Loss Compensation
  L⁻t = 100e18
  Floss = min(20e18, 100e18) = 20e18
  Fpool = 0
  Nraw = 1000e18 - 100e18 + 20e18 = 920e18

Step 2: Drawdown Floor & Grant
  Nfloor = 1000e18 × (1 - 0.3) = 700e18
  grantNeed = max(0, 700e18 - 920e18) = 0  // Nraw > Nfloor, no grant needed
  Gt = 0
  Ngrant = 920e18
  Bgrant = 200e18

Step 3: Backstop Fill
  Btarget = 0.2 × 920e18 = 184e18
  ΔBneed = max(0, 184e18 - 200e18) = 0  // Already above target
  Ffill = 0
  Fremain = 0

Step 4: Residual Split
  FcoreLP = 0, FcoreBS = 0, FcoreTR = 0, Fdust = 0

Output:
  Ft = 20e18 (all fees went to loss compensation)
  Npre = 920e18
  Bnext = 200e18 (unchanged)
  Tnext = Tprev (unchanged)
```

### 5.3 Example with Grant (Modified Case 3)

```
Input:
  Lt = -500e18 (500 loss - large)
  Ftot = 50e18 (50 fees)
  Nprev = 1000e18
  Bprev = 200e18
  deltaEt = 100e18
  pdd = -0.3e18 (-30%)

Step 1: Loss Compensation
  Floss = min(50e18, 500e18) = 50e18
  Fpool = 0
  Nraw = 1000e18 - 500e18 + 50e18 = 550e18

Step 2: Drawdown Floor & Grant
  Nfloor = 1000e18 × 0.7 = 700e18
  grantNeed = max(0, 700e18 - 550e18) = 150e18
  Gt = min(100e18, 150e18) = 100e18  // Limited by deltaEt
  Ngrant = 550e18 + 100e18 = 650e18
  Bgrant = 200e18 - 100e18 = 100e18

Output:
  Ft = 50e18
  Gt = 100e18
  Npre = 650e18
  Bnext = 100e18 (after grant payout)
```

---

## 6. Invariants

### 6.1 Must-hold Invariants

1. **Fee Conservation:** `Floss + Fpool = Ftot`
2. **Residual Conservation:** `FcoreLP + FcoreBS + FcoreTR + Fdust = Fremain`
3. **Grant Bound:** `Gt ≤ Bt-1` (or revert)
4. **Backstop Non-negative:** `Bnext ≥ 0`
5. **NAV Equation:** `Npre = Nprev + Lt + Ft + Gt`

### 6.2 Soft Invariants (Best-effort)

1. **Drawdown Floor:** `(Npre / Nprev - 1) ≥ pdd` when Gt > 0
2. **Backstop Target:** System attempts `Bnext ≥ ρBS × Npre`

---

## 7. Integration Points

### 7.1 processDailyBatch Flow

```
1. Aggregate P&L and fees from settled markets → (Lt, Ftot)
2. Get deltaEt from RiskModule
3. Call FeeWaterfallLib.apply() → Result
4. Pass Result.Npre to VaultAccountingLib.applyPreBatch()
5. Update capitalStack.backstopNav = Result.Bnext
6. Update capitalStack.treasuryNav = Result.Tnext
7. Process deposit/withdraw queue
8. Update VaultState with final NAV/shares/price
```

### 7.2 Event Emission

```solidity
event FeeWaterfallApplied(
    uint64 indexed batchId,
    int256 Lt,
    uint256 Ftot,
    uint256 Gt,
    uint256 Npre,
    uint256 Bnext,
    uint256 Tnext
);
```

---

## 8. Security Considerations

1. **Overflow Protection:** All WAD multiplication uses `wMul` with overflow checks
2. **Division by Zero:** Check `Nprev > 0` before drawdown floor calculation
3. **Reentrancy:** Pure library functions - no external calls
4. **Access Control:** Only callable through `processDailyBatch` (owner)
5. **Parameter Validation:**
   - `phiLP + phiBS + phiTR = WAD`
   - `pdd < 0` (drawdown floor is negative)
   - `rhoBS ≤ WAD` (coverage ratio max 100%)

---

## 9. Migration Notes

### From Phase 4 to Phase 5

1. Add `CapitalStackState` and `FeeWaterfallConfig` to storage
2. Initialize `backstopNav` and `treasuryNav` (likely via seed or admin)
3. Replace simple `computePreBatch(Lt, Ft, Gt)` with full Fee Waterfall
4. Add `_dailyPnl` mapping for batch processing

### Backwards Compatibility

- Existing `VaultState` unchanged
- Existing `VaultAccountingLib` receives `Npre` from Fee Waterfall
- No breaking changes to deposit/withdraw queue logic

