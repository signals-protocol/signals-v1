# Risk Module Invariants & Fee Waterfall Checklist (Phase 5-7)

This document captures the behavior we must implement in Phases 5-7 for Safety Layer and Fee Waterfall.
Use it to write/extend tests as each component is built.

## Scope

### Phase 5: Fee Waterfall
- `FeeWaterfallLib.apply()`: Loss compensation, Grant calculation, Residual split
- Storage: `CapitalStackState`, `DailyPnlSnapshot`

### Phase 6: Vault Integration  
- `VaultAccountingLib.applyPreBatch()`: FeeWaterfall → Vault NAV
- `LPVaultModule.processDailyBatch()`: Full pipeline
- Request ID-based queue model

### Phase 7: Safety Layer
- `RiskModule`: α bound calculation and enforcement
- `TradeModule`: α enforcement integration
- `LPShareToken`: ERC-4626 LP token

---

## 1. Fee Waterfall Invariants (Phase 5)

### INV-FW1: Fee Conservation

**Invariant:** `F_loss,t + F_pool,t = F_tot,t`

- Total fees must be exactly split between loss compensation and remaining pool
- No fees can be created or destroyed

**Verification:**
```typescript
expect(result.Floss + result.Fpool).to.equal(params.Ftot);
```

### INV-FW2: Loss Compensation Bound

**Invariant:** `F_loss,t = min(F_tot,t, |L^-_t|)`

- Loss compensation cannot exceed total fees
- Loss compensation cannot exceed actual loss

**Verification:**
```typescript
const Lneg = Lt < 0 ? -Lt : 0;
expect(result.Floss).to.equal(Math.min(Ftot, Lneg));
```

### INV-FW3: Grant Bound

**Invariant:** `G_t ≤ B_{t-1}` (Grant cannot exceed Backstop)

- If grant would exceed backstop, revert with `InsufficientBackstopForGrant`
- Backstop NAV must remain non-negative

**Verification:**
```typescript
if (Gt > Bprev) {
  await expect(feeWaterfall.apply(...)).to.be.revertedWith("InsufficientBackstopForGrant");
}
expect(result.Bnext).to.be.gte(0);
```

### INV-FW4: Grant Calculation

**Invariant:** `G_t = min(ΔE_t, max(0, N_floor,t - N_raw,t))`

- Grant is the minimum of available delta and required support
- Grant only activates when N_raw < N_floor

**Verification:**
```typescript
const Nraw = Nprev + Lt + Floss;
const Nfloor = Nprev * (WAD + pdd) / WAD;
const grantNeed = Nfloor > Nraw ? Nfloor - Nraw : 0;
const expectedGt = Math.min(deltaEt, grantNeed);
expect(result.Gt).to.equal(expectedGt);
```

### INV-FW5: Backstop Equation

**Invariant:** `B_t = B_{t-1} + F_BS,t - G_t`

- Backstop receives its fee share and pays out grants

**Verification:**
```typescript
expect(result.Bnext).to.equal(Bprev + FBS - Gt);
```

### INV-FW6: Residual Split Conservation

**Invariant:** `F_LP + F_BS + F_TR + F_dust = F_remain`

- After backstop fill, remaining fees split exactly among LP/BS/TR
- Dust (rounding) goes to LP

**Verification:**
```typescript
expect(FcoreLP + FcoreBS + FcoreTR + Fdust).to.equal(Fremain);
```

---

## 2. NAV Equation Invariants (Phase 6)

### INV-NAV1: Pre-batch NAV Equation

**Invariant:** `N_pre,t = N_{t-1} + L_t + F_t + G_t`

- This is the fundamental NAV update equation
- Must hold exactly (within rounding)

**Verification:**
```typescript
const expectedNpre = Nprev + Lt + Ft + Gt;
expect(result.Npre).to.be.closeTo(expectedNpre, 1); // 1 wei tolerance
```

### INV-NAV2: Price Consistency

**Invariant:** `P_t = N_t / S_t` (when S_t > 0)

**Verification:**
```typescript
expect(state.price).to.equal(state.nav.wDiv(state.shares));
```

### INV-NAV3: Peak Price Monotonicity

**Invariant:** `P_peak,t ≥ P_peak,t-1` (non-decreasing)

**Verification:**
```typescript
expect(state.pricePeak).to.be.gte(prevPricePeak);
```

### INV-NAV4: Drawdown Calculation

**Invariant:** `DD_t = 1 - P_t / P_peak,t`

**Verification:**
```typescript
expect(state.drawdownWad).to.equal(WAD - state.price.wDiv(state.pricePeak));
```

---

## 3. Alpha Safety Bound Invariants (Phase 7)

### INV-α1: Alpha Range

**Invariant:** `α_base ≤ α_t ≤ α_limit`

- Alpha is bounded by base (minimum) and limit (maximum)
- Alpha decreases as drawdown increases

**Verification:**
```typescript
const alpha = await riskModule.calculateAlphaBound(drawdown);
expect(alpha).to.be.gte(alphaBase);
expect(alpha).to.be.lte(alphaLimit);
```

### INV-α2: Exposure Bound

**Invariant:** `exposure_t ≤ N_t × α_t`

- Total market exposure cannot exceed NAV times alpha
- New trades that would exceed this must revert

**Verification:**
```typescript
const maxExposure = nav.wMul(alpha);
if (newExposure > maxExposure) {
  await expect(trade.openPosition(...)).to.be.revertedWith("AlphaExceedsLimit");
}
```

### INV-α3: Drawdown Impact

**Invariant:** `α_t = α_limit × (1 - k × DD_t)` for some k > 0

- Higher drawdown → lower alpha → less liquidity
- At max drawdown (DD=1), alpha approaches alphaBase

**Verification:**
```typescript
// At DD=0, alpha = alphaLimit
expect(await riskModule.calculateAlphaBound(0)).to.equal(alphaLimit);
// At DD=maxDD, alpha = alphaBase
expect(await riskModule.calculateAlphaBound(maxDD)).to.equal(alphaBase);
```

---

## 4. Request Queue Invariants (Phase 6)

### INV-Q1: Request Eligibility

**Invariant:** Request can only be processed at `eligibleBatchId`

- `eligibleBatchId = requestBatchId + D_lag`
- Prevents instant deposit/withdraw exploits

**Verification:**
```typescript
const request = await vault.depositRequests(requestId);
expect(request.eligibleBatchId).to.equal(currentBatchId + Dlag);
```

### INV-Q2: No Double Processing

**Invariant:** Each request can only be processed/claimed once

- Status transitions: Pending → Processed → Claimed
- Cannot revert to previous state

**Verification:**
```typescript
await vault.claimDeposit(requestId);
await expect(vault.claimDeposit(requestId)).to.be.revertedWith("RequestAlreadyProcessed");
```

### INV-Q3: Batch Aggregation Accuracy

**Invariant:** `Σ(individual requests) = batch totals`

- Sum of all eligible deposits = totalDepositAssets
- Sum of all eligible withdraws = totalWithdrawShares

**Verification:**
```typescript
const batchAgg = await vault.batchAggregations(batchId);
expect(batchAgg.totalDepositAssets).to.equal(sumOfDeposits);
```

---

## 5. Backstop Invariants (Phase 7)

### INV-BS1: Non-negative NAV

**Invariant:** `B_t ≥ 0` always

- Backstop cannot go negative
- If grant would make it negative, revert

**Verification:**
```typescript
expect(capitalStack.backstopNav).to.be.gte(0);
```

### INV-BS2: Coverage Target

**Invariant:** System tries to maintain `B_t ≥ ρ_BS × N_t`

- ρ_BS is the target backstop coverage ratio
- Fee waterfall prioritizes filling this before residual split

**Verification:**
```typescript
const target = nav.wMul(rhoBS);
// After fee waterfall, backstop should be at or moving toward target
```

---

## Test Harness Coverage

### Phase 5 Tests (`test/unit/FeeWaterfallLib.spec.ts`)
- [ ] INV-FW1: Fee conservation
- [ ] INV-FW2: Loss compensation bound
- [ ] INV-FW3: Grant bound & revert
- [ ] INV-FW4: Grant calculation
- [ ] INV-FW5: Backstop equation
- [ ] INV-FW6: Residual split conservation
- [ ] Property test: JS reference parity

### Phase 6 Tests (`test/integration/vault/*.spec.ts`)
- [ ] INV-NAV1: Pre-batch NAV equation
- [ ] INV-NAV2: Price consistency
- [ ] INV-NAV3: Peak price monotonicity
- [ ] INV-NAV4: Drawdown calculation
- [ ] INV-Q1: Request eligibility
- [ ] INV-Q2: No double processing
- [ ] INV-Q3: Batch aggregation accuracy
- [ ] Scenario: Happy path (3-day)
- [ ] Scenario: Drawdown + Grant
- [ ] Scenario: Bank-run

### Phase 7 Tests (`test/integration/risk/*.spec.ts`)
- [ ] INV-α1: Alpha range
- [ ] INV-α2: Exposure bound
- [ ] INV-α3: Drawdown impact
- [ ] INV-BS1: Non-negative NAV
- [ ] INV-BS2: Coverage target
- [ ] ERC-4626 compliance tests

---

## Whitepaper Section References

| Invariant | Whitepaper Section |
|-----------|-------------------|
| INV-FW1~6 | Sec 4.3-4.6, Appendix A.2 |
| INV-NAV1~4 | Sec 3, Appendix A.3 |
| INV-α1~3 | Sec 3.4, 4.4 |
| INV-Q1~3 | Sec 3 (D_lag) |
| INV-BS1~2 | Sec 4.5, Appendix A.2 |

