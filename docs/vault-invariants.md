# Vault Invariants & TDD Checklist (Phase 4)

This document captures the invariants and test strategy for the Vault accounting system.
Use it to guide implementation in `VaultAccountingLib.sol` and related modules.

## Scope

- Libraries: `VaultAccountingLib`
- State structs: `VaultState`, `VaultQueue`, `VaultRequest`
- Modules: `LPVaultModule`
- Entry points: `processBatch`, `requestDeposit`, `requestWithdraw`, `cancelDeposit`, `cancelWithdraw`, `seedVault`

---

## 1. Daily P&L Spine (Whitepaper Sec 3, Appendix A.2)

### 1.1 수식 정의

| 변수             | 정의                                   | 단위     |
| ---------------- | -------------------------------------- | -------- |
| `N_{t-1}`        | 전일 NAV                               | WAD      |
| `L_t`            | 당일 P&L (signed, 음수 가능)           | WAD      |
| `F_t`            | 당일 LP Vault 귀속 수수료              | WAD      |
| `G_t`            | Backstop Grant (손실 보전 지원금)      | WAD      |
| `Π_t`            | 당일 총 income = `L_t + F_t + G_t`     | WAD      |
| `N^pre_t`        | 배치 전 NAV = `N_{t-1} + Π_t`          | WAD      |
| `S_{t-1}`        | 전일 총 shares                         | WAD      |
| `P^e_t`          | 배치 가격 = `N^pre_t / S_{t-1}`        | WAD      |
| `D_t`, `W_t`     | 당일 deposit/withdraw 금액 (pending)   | WAD      |
| `d_t`, `w_t`     | 당일 발행/소각 shares                  | WAD      |
| `N_t`            | 배치 후 NAV                            | WAD      |
| `S_t`            | 배치 후 shares = `S_{t-1} + d_t - w_t` | WAD      |
| `P_t`            | 배치 후 가격 = `N_t / S_t`             | WAD      |

### 1.2 인바리언트

#### INV-V1: Pre-batch NAV 계산
```
N^pre_t = N_{t-1} + L_t + F_t + G_t
```
- **보장 함수**: `VaultAccountingLib.computePreBatch()`
- **NAV Underflow**: If `N_{t-1} + Π_t < 0`, reverts with `NAVUnderflow(navPrev, loss)`
  - Safety Layer (Phase 5) should prevent this via Backstop Grants
- **테스트 검증**: 
  - Given: `(navPrev=1000e18, L=-50e18, F=30e18, G=10e18)`
  - Expected: `N^pre = 990e18`
  - Tolerance: 0 (exact arithmetic)

#### INV-V2: Batch 가격 불변
```
P^e_t = N^pre_t / S_{t-1}  (S_{t-1} > 0)
```
- **보장 함수**: `VaultAccountingLib.computePreBatch()`
- **테스트 검증**:
  - Given: `(N^pre=990e18, sharesPrev=900e18)`
  - Expected: `P^e = 1.1e18`
  - Tolerance: 1 wei (rounding)

#### INV-V3: Shares=0 초기화 (Seeding)
```
IF S_{t-1} == 0 AND isSeeded == false:
  require first deposit >= MIN_SEED_AMOUNT
  set isSeeded = true
  P^e = 1e18 (initial price = 1.0)
  N = seedAmount, S = seedAmount
```
- **보장 함수**: `LPVaultModule.seedVault()`, `VaultAccountingLib.computePreBatchForSeed()`
- **테스트 검증**:
  - First deposit with `D >= MIN_SEED_AMOUNT` succeeds, sets `isSeeded=true`
  - Subsequent batch with `S > 0` computes `P^e` normally
  - Attempt deposit before seed → revert `VaultNotSeeded()`

---

## 2. Deposit & Withdraw (Whitepaper Sec 3.2, Appendix C)

### 2.1 수식 정의 (Updated per Appendix C.1)

| 연산    | NAV 변화                          | Shares 변화           | 가격 보존 조건             |
| ------- | --------------------------------- | --------------------- | -------------------------- |
| Deposit | `N' = N + A_used` (NOT full A)    | `S' = S + S_mint`     | `N'/S' ≈ P` (within 1 wei) |
| Withdraw| `N'' = N - x·P`                   | `S'' = S - x`         | `N''/S'' ≈ P` (within 1 wei)|

**Deposit Rounding (Appendix C.1 b1)**:
- `S_mint = floor(A / P)` - shares minted (round down)
- `A_used = S_mint * P` - actual amount added to NAV
- `refund = A - A_used` - dust refunded to depositor (at most ~1 wei)

### 2.2 인바리언트

#### INV-V4: Deposit 가격 보존 (Updated)
```
After deposit A at price P:
  S_mint = floor(A / P)
  A_used = S_mint * P
  N' = N + A_used  (NOT N + A)
  S' = S + S_mint
  refund = A - A_used
  |N'/S' - P| <= 1 wei
```
- **보장 함수**: `VaultAccountingLib.applyDeposit()`
- **반환값**: `(newNav, newShares, mintedShares, refundAmount)`
- **테스트 검증**:
  - Given: `(N=1000e18, S=1000e18, P=1e18, A=100e18)`
  - Expected: `(N'=1100e18, S'=1100e18, refund=0)`
  - Verify: `|N'/S' - P| <= 1`
  - Edge case: Non-divisible amounts produce small refund

#### INV-V5: Withdraw 가격 보존
```
After withdraw x shares at price P:
  N'' = N - x·P  (round down payout to favor protocol)
  S'' = S - x
  |N''/S'' - P| <= 1 wei
```
- **보장 함수**: `VaultAccountingLib.applyWithdraw()`
- **테스트 검증**:
  - Given: `(N=1000e18, S=1000e18, P=1e18, x=50e18)`
  - Expected: `(N''=950e18, S''=950e18)`
  - Verify: `|N''/S'' - P| <= 1`

#### INV-V6: 출금 상한
```
x <= S (cannot withdraw more shares than exist)
x·P <= N (cannot withdraw more NAV than exists)
```
- **보장 함수**: `VaultAccountingLib.applyWithdraw()`
- **테스트 검증**: 
  - Attempt `x > S` → revert `InsufficientShares()`
  - Attempt `x·P > N` → revert `InsufficientNAV()`

---

## 3. Peak & Drawdown (Whitepaper Sec 3.4)

### 3.1 수식 정의

| 변수         | 정의                            | 단위  |
| ------------ | ------------------------------- | ----- |
| `P^peak_t`   | `max_{τ≤t} P_τ` (역대 최고가)   | WAD   |
| `DD_t`       | `1 - P_t / P^peak_t` (Drawdown) | WAD   |

### 3.2 인바리언트

#### INV-V7: Peak 단조 증가
```
P^peak_t >= P^peak_{t-1}  (peak never decreases)
P^peak_t = max(P^peak_{t-1}, P_t)
```
- **보장 함수**: `VaultAccountingLib.updatePeak()`
- **테스트 검증**:
  - Sequence: `P = [1.0, 1.2, 1.1, 1.3]`
  - Expected peaks: `[1.0, 1.2, 1.2, 1.3]`

#### INV-V8: Drawdown 범위
```
0 <= DD_t <= 1e18  (0% to 100%)
DD_t = 0 when P_t == P^peak_t
DD_t = (P^peak_t - P_t) / P^peak_t
```
- **보장 함수**: `VaultAccountingLib.computeDrawdown()`
- **테스트 검증**:
  - `P_t = P^peak = 1e18` → `DD = 0`
  - `P_t = 0.8e18, P^peak = 1e18` → `DD = 0.2e18` (20%)
  - `P_t = 0, P^peak > 0` → `DD = 1e18` (100%)

#### INV-V8b: Empty Vault (S=0) 처리
```
IF S_t == 0 (all LPs exited):
  P_t = 1e18 (default price)
  P^peak_t = P^peak_{t-1} (preserve previous peak)
  DD_t = 0 (no active LP exposure)
```
- **보장 함수**: `VaultAccountingLib.computePostBatchState()`
- **테스트 검증**:
  - After all withdrawals, `shares=0`
  - Price defaults to 1.0, drawdown is 0
  - Peak is preserved for when LPs return

---

## 4. Queue Processing (Whitepaper Sec 3.3)

### 4.1 큐 상태 구조

```solidity
struct VaultQueue {
    uint256 pendingDeposits;    // 대기 중 입금 총액
    uint256 pendingWithdraws;   // 대기 중 출금 shares 총량
}

struct VaultRequest {
    uint256 amount;             // Deposit: asset amount, Withdraw: shares
    uint64 requestTimestamp;
    bool isDeposit;
}
```

### 4.2 인바리언트

#### INV-V9: 배치 순서 보장
```
Withdraws processed before deposits within same batch
```
- **보장 함수**: `LPVaultModule.processBatch()`
- **테스트 검증**:
  - Given pending `(W=100e18, D=200e18)` at price `P=1e18`
  - Process order: withdraw first, then deposit
  - Final state consistent with sequential application

#### INV-V10: D_lag 강제 (Phase 5)
```
Request at time T cannot be processed before T + D_lag
D_lag defined in governance parameters
```
- **Phase 4 Status**: `withdrawLag` is stored in `SignalsCoreStorage` but **NOT enforced**.
  - All pending requests are processed immediately regardless of `requestTimestamp`.
  - Effectively `D_lag = 0` for Phase 4 testing.
  - See `LPVaultModule.sol` lines 20-23 for explicit documentation.
- **Phase 5 Implementation**: 
  - Add eligibility check in `processBatch()`:
    ```solidity
    if (block.timestamp < req.requestTimestamp + withdrawLag) {
        revert RequestLagNotMet(req.requestTimestamp, req.requestTimestamp + withdrawLag);
    }
    ```
  - Only matured requests are processed; immature requests remain pending.
- **테스트 검증**:
  - Request at `T=100`, `D_lag=86400`
  - Process attempt at `T=100 + 86399` → revert `RequestLagNotMet()`
  - Process at `T=100 + 86400` → success

#### INV-V11: 큐 잔액 일관성
```
After batch:
  pendingDeposits = 0 (all processed)
  pendingWithdraws = 0 (all processed)
  userRequests[user].amount = 0 for all processed users
```
- **보장 함수**: `LPVaultModule.processBatch()`, `_clearProcessedRequests()`
- **Critical**: User requests MUST be cleared after batch to prevent cancel underflow
- **테스트 검증**:
  - After batch, `getUserRequest(user)` returns `amount=0`
  - Calling `cancelDeposit()` after batch → revert `NoPendingRequest()`

#### INV-V12: Withdraw DoS 방지
```
pendingWithdraws + newRequest <= lpVault.shares
```
- **보장 함수**: `LPVaultModule.requestWithdraw()`
- **테스트 검증**:
  - Attempt to request more shares than exist → revert `InsufficientShareBalance()`
  - This prevents attackers from blocking batch processing

#### INV-V13: 중복 배치 방지
```
lastBatchTimestamp must be < block.timestamp
```
- **보장 함수**: `LPVaultModule.processBatch()` checks `BatchAlreadyProcessed`
- **테스트 검증**:
  - Two `processBatch()` calls in same block → second reverts

---

## 5. Capital Stack Integration (Phase 5 - Whitepaper Sec 4.3-4.6)

### 5.1 Fee Waterfall 상호작용

| 변수    | 정의                                        |
| ------- | ------------------------------------------- |
| `F_LP`  | LP Vault 귀속 수수료 (ϕ_LP 비율)            |
| `F_BS`  | Backstop 귀속 수수료 (ϕ_BS 비율)            |
| `F_TR`  | Treasury 귀속 수수료 (ϕ_TR 비율)            |
| `G_t`   | Backstop → LP Grant (손실 보전)             |

### 5.2 인바리언트 (Phase 5)

#### INV-V14: Grant 한도
```
G_t <= B_{t-1}  (Grant cannot exceed Backstop NAV)
B_t = B_{t-1} + F_BS - G_t >= 0
```

#### INV-V15: Fee 분배 합산
```
F_LP + F_BS + F_TR = F_pool  (잔여 수수료 풀 완전 분배)
ϕ_LP + ϕ_BS + ϕ_TR = 1e18  (비율 합 = 100%)
```

---

## 6. 테스트 전략

### 6.1 단위 테스트 (`test/unit/vault/`)

| 파일                         | 대상                    | 인바리언트              |
| ---------------------------- | ----------------------- | ----------------------- |
| `VaultAccountingLib.spec.ts` | 순수 수학 라이브러리    | INV-V1~V8               |
| `VaultQueue.spec.ts`         | 큐 상태 관리            | INV-V9~V13              |

### 6.2 통합 테스트 (`test/integration/vault/`)

| 파일                    | 대상                          | 인바리언트        |
| ----------------------- | ----------------------------- | ----------------- |
| `VaultBatchFlow.spec.ts`| Module + Lib 상호작용         | INV-V1~V13        |

### 6.3 E2E 테스트 (`test/e2e/vault/`)

| 파일                      | 대상                              | 시나리오                          |
| ------------------------- | --------------------------------- | --------------------------------- |
| `VaultWithMarkets.spec.ts`| Vault + Market P&L 연동           | 시장 손익 → Vault NAV 반영        |

### 6.4 Property-based / Fuzz 테스트

- `VaultAccountingLib` pure functions: 
  - 임의 입력에 대해 price preservation 검증
  - Overflow/underflow 경계 테스트
- `processBatch`:
  - 임의 deposit/withdraw 시퀀스에 대해 invariant 유지 검증

---

## 7. 허용 오차 (Tolerance)

| 연산              | 허용 오차    | 근거                           |
| ----------------- | ------------ | ------------------------------ |
| NAV 계산          | 0 wei        | 정수 덧셈/뺄셈                 |
| Price 계산        | 1 wei        | WAD 나눗셈 반올림              |
| Price preservation| 1-5 wei      | 연쇄 연산 누적 오차            |
| Drawdown 계산     | 1 wei        | WAD 나눗셈 반올림              |

---

## 8. Phase 4 Scope Notes

### 8.1 구현 완료

- ✅ `VaultAccountingLib`: NAV, price, peak, drawdown 계산
- ✅ `LPVaultModule`: deposit/withdraw 큐 + 배치 처리
- ✅ Deposit dust refund (A_used only added to NAV)
- ✅ NAV underflow → revert (not clamp)
- ✅ Empty vault (S=0) handling
- ✅ DoS prevention (withdraw request validation)
- ✅ Duplicate batch prevention

### 8.2 Phase 5로 연기

- ⏳ D_lag enforcement in processBatch
- ⏳ Per-user dust refund tracking
- ⏳ ERC-4626 share token integration
- ⏳ Fee waterfall (F_LP, F_BS, F_TR)
- ⏳ Backstop grants (G_t)
- ⏳ Request ID-based queue model

---

## Appendix: Error Codes

| 에러 코드                      | 조건                                      | 상태     |
| ------------------------------ | ----------------------------------------- | -------- |
| `VaultNotSeeded()`             | `!isSeeded` 상태에서 연산                 | 사용중   |
| `VaultAlreadySeeded()`         | 이미 seeded된 vault에 seedVault 호출      | 사용중   |
| `InsufficientSeedAmount()`     | `seedAmount < minSeedAmount`              | 사용중   |
| `NoPendingRequest()`           | 취소할 요청이 없음                        | 사용중   |
| `InsufficientShareBalance()`   | 요청 shares > vault shares                | 사용중   |
| `ZeroAmount()`                 | 0 금액 요청                               | 사용중   |
| `BatchAlreadyProcessed()`      | 같은 블록에서 중복 배치                   | 사용중   |
| `NAVUnderflow()`               | P&L로 NAV가 음수가 되는 경우              | 사용중   |
| `InsufficientShares()`         | `withdrawShares > totalShares`            | 사용중   |
| `InsufficientNAV()`            | `withdrawAmount > nav`                    | 사용중   |
| `ZeroPriceNotAllowed()`        | `price == 0` in operations                | 사용중   |
| `ZeroSharesNotAllowed()`       | `shares == 0` in computePreBatch          | 사용중   |
| `RequestLagNotMet()`           | `timestamp < requestTime + D_lag`         | Phase 5  |

