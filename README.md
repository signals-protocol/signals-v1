# Signals v1

Modular on-chain architecture for the Signals prediction market protocol, built on CLMSR (Continuous Logarithmic Market Scoring Rule).

## Current Status

**Phase 4 Complete** — Vault accounting spine implemented with full test coverage.

| Component               | Status | Description                                        |
| ----------------------- | ------ | -------------------------------------------------- |
| `SignalsCore`           | ✅     | UUPS upgradeable entry point with delegate routing |
| `TradeModule`           | ✅     | Position open/increase/decrease/close/claim        |
| `MarketLifecycleModule` | ✅     | Market creation, settlement, timing updates        |
| `OracleModule`          | ✅     | Settlement price feed with signature verification  |
| `SignalsPosition`       | ✅     | ERC721 position NFT with market indexing           |
| `LPVaultModule`         | ✅     | Deposit/withdraw queue, daily batch processing     |
| `VaultAccountingLib`    | ✅     | NAV, price, peak, drawdown calculations            |
| `LazyMulSegmentTree`    | ✅     | O(log n) range queries for CLMSR distribution      |

**372 tests passing** — SDK parity, fuzz, stress, invariants, vault batch flow, security.

### Progress

- [x] Phase 0: Repository bootstrap
- [x] Phase 1: Storage / Interface design
- [x] Phase 2: Core + module scaffolding
- [x] Phase 3: v0 logic porting (Trade, Lifecycle, Oracle, Position)
- [x] Phase 4: Vault accounting spine (VaultAccountingLib, LPVaultModule)
- [ ] Phase 5: LP Vault / Backstop / Fee Waterfall integration
- [ ] Phase 6: Mainnet preparation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SignalsCore (UUPS)                     │
│  - Storage holder (SignalsCoreStorage)                      │
│  - Module routing via delegatecall                          │
│  - Access control (Ownable, Pausable, ReentrancyGuard)      │
└─────────────────────────────────────────────────────────────┘
                              │
    ┌─────────────┬───────────┼───────────┬─────────────┐
    ▼             ▼           ▼           ▼             ▼
┌─────────┐ ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐
│ Trade   │ │ Lifecycle│ │ Oracle  │ │ LPVault │ │ Risk      │
│ Module  │ │ Module   │ │ Module  │ │ Module  │ │ Module    │
│ (v1)    │ │ (v1)     │ │ (v1)    │ │ (v0.1)  │ │ (Phase 5) │
└─────────┘ └──────────┘ └─────────┘ └─────────┘ └───────────┘

┌─────────────────────────────────────────────────────────────┐
│                    SignalsPosition (ERC721)                 │
│  - Position NFT with market/owner indexing                  │
│  - Core-only mint/burn/update                               │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
signals-v1/
├── contracts/
│   ├── core/
│   │   ├── SignalsCore.sol              # UUPS entry point
│   │   ├── storage/SignalsCoreStorage.sol
│   │   └── lib/
│   │       ├── SignalsClmsrMath.sol     # CLMSR math helpers
│   │       └── SignalsDistributionMath.sol
│   ├── modules/
│   │   ├── TradeModule.sol              # Trade execution
│   │   ├── MarketLifecycleModule.sol    # Market management
│   │   ├── OracleModule.sol             # Settlement oracle
│   │   └── LPVaultModule.sol            # Vault operations
│   ├── vault/
│   │   └── lib/VaultAccountingLib.sol   # Vault math
│   ├── position/
│   │   ├── SignalsPosition.sol          # ERC721 position token
│   │   └── SignalsPositionStorage.sol
│   ├── lib/
│   │   ├── LazyMulSegmentTree.sol       # Segment tree for CLMSR
│   │   └── FixedPointMathU.sol          # 18-decimal fixed point
│   ├── interfaces/
│   ├── errors/
│   ├── mocks/
│   └── harness/                         # Test helpers
├── test/
│   ├── unit/                            # Module-level tests
│   │   ├── lib/                         # Library tests
│   │   ├── position/                    # Position tests
│   │   └── vault/                       # Vault tests
│   ├── module/                          # Single module tests
│   │   ├── access/                      # Upgrade/access guards
│   │   ├── lifecycle/                   # Market lifecycle
│   │   ├── oracle/                      # Oracle tests
│   │   └── trade/                       # Trade validation
│   ├── integration/                     # Cross-module flows
│   │   ├── core/                        # Boundaries, events
│   │   ├── lifecycle/                   # Lifecycle flow
│   │   ├── settlement/                  # Settlement chunks
│   │   ├── trade/                       # Trade flows
│   │   └── vault/                       # Vault batch flow
│   ├── invariant/                       # Math invariants
│   ├── parity/                          # v0 SDK parity
│   ├── security/                        # Access control
│   └── e2e/                             # End-to-end (Phase 5)
│       └── vault/
├── docs/
│   ├── phase3/clmsr-invariants.md
│   └── vault-invariants.md              # Vault accounting spec
├── plan.md                              # Full migration plan
└── whitepaper.tex                       # Protocol specification
```

## Getting Started

```bash
# Install dependencies
yarn install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Run specific test suite
npx hardhat test test/integration/vault/VaultBatchFlow.spec.ts
```

## Key Design Decisions

1. **Thin Core + Delegate Modules** — Core holds storage and routes to modules via delegatecall. Modules can be upgraded independently.

2. **24KB Size Limit** — Heavy logic in modules, not Core. Trade/Lifecycle/Vault can be split further if needed.

3. **Clean Storage Layout** — v1 canonical layout with gaps for future upgrades. No legacy fields from v0.

4. **SDK Parity** — On-chain calculations match v0 SDK within ≤1 wei tolerance.

5. **Whitepaper-Driven** — All vault accounting follows whitepaper Section 3 formulas exactly.

## Vault Accounting (Phase 4)

Implements whitepaper Section 3 batch accounting:

```
N^pre_t = N_{t-1} + Π_t     (pre-batch NAV)
P^e_t = N^pre_t / S_{t-1}   (batch price)
DD_t = 1 - P_t / P^peak_t   (drawdown)
```

Key invariants tested:

- Price preservation: |N'/S' - P| ≤ 1 wei after deposit/withdraw
- Peak monotonicity: P^peak_t ≥ P^peak_{t-1}
- Drawdown range: 0 ≤ DD_t ≤ 100%
- Deposit dust refund: A_used = S_mint × P, refund = A - A_used (whitepaper C.1)
- NAV underflow protection: Reverts if loss > NAV (Safety Layer should prevent)

### Phase 4 Scope Notes

The following features are **intentionally deferred to Phase 5**:

| Feature | Phase 4 Behavior | Phase 5 Implementation |
|---------|------------------|------------------------|
| Withdrawal lag (D_lag) | Stored but not enforced; all withdrawals processed immediately | Eligibility check: `timestamp >= requestTimestamp + D_lag` |
| Deposit dust refund | Dust accumulates in contract | Per-request ID tracking with immediate refund |
| NAV underflow | Reverts with `NAVUnderflow` | Safety Layer prevents via Backstop Grants (G_t) |
| Empty vault (S=0) | Price=1.0, peak preserved, drawdown=0 | Documented edge case behavior |

## Documentation

- [plan.md](./plan.md) — Detailed architecture and migration plan
- [docs/vault-invariants.md](./docs/vault-invariants.md) — Vault accounting spec
- [docs/phase3/clmsr-invariants.md](./docs/phase3/clmsr-invariants.md) — CLMSR math invariants
- [test/TESTING.md](./test/TESTING.md) — Test architecture conventions

## License

MIT
