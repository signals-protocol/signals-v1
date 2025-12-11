# Signals v1 Test Architecture

## Directory Structure

```
test/
├── unit/                   # Pure functions/libraries (no external dependencies)
│   ├── lib/               # Math & data structure libraries
│   │   ├── fixedPointMath.spec.ts    # WAD arithmetic: wMul, wDiv, wExp, wLn
│   │   └── lazyMulSegmentTree.spec.ts # Segment tree operations
│   ├── position/          # SignalsPosition contract
│   │   └── signalsPosition.spec.ts   # ERC721 + position storage
│   └── vault/             # Vault libraries
│       ├── VaultAccountingLib.spec.ts # NAV, shares, price calculations
│       └── VaultQueue.spec.ts         # Deposit/withdraw queue management
│
├── module/                 # Individual module tests (delegatecall environment)
│   ├── trade/
│   │   ├── validation.spec.ts  # Input validation (ticks, quantity, time)
│   │   └── slippage.spec.ts    # Slippage protection
│   ├── lifecycle/
│   │   └── market.spec.ts      # Market creation, activation, settlement
│   ├── oracle/
│   │   └── oracle.spec.ts      # Oracle signing, settlement value
│   └── access/
│       └── upgrade.spec.ts     # UUPS upgrade security, onlyDelegated
│
├── integration/            # Multiple modules combined
│   ├── trade/
│   │   ├── flow.spec.ts       # Basic open/increase/decrease/close flow
│   │   ├── stress.spec.ts     # High volume, many users
│   │   └── fuzz.spec.ts       # Property-based random inputs
│   ├── lifecycle/
│   │   └── flow.spec.ts       # Create → trade → settle → claim
│   ├── settlement/
│   │   └── chunks.spec.ts     # Chunked settlement processing
│   ├── core/
│   │   ├── boundaries.spec.ts # Edge cases: quantity, ticks, time, cost
│   │   └── events.spec.ts     # Event emission verification
│   └── vault/
│       └── batchFlow.spec.ts  # Daily batch processing
│
├── parity/                 # v0 SDK parity tests
│   ├── clmsr.spec.ts          # Math parity: exp, ln, cost calculations
│   └── tradeModule.spec.ts    # Trading flow parity
│
├── invariant/              # Mathematical invariants
│   └── clmsr.invariants.spec.ts # Sum monotonicity, range isolation, symmetry
│
├── e2e/                    # Full system tests
│   └── vault/
│       └── VaultWithMarkets.spec.ts # Complete lifecycle with P&L flow
│
└── helpers/                # Shared utilities
    ├── constants.ts       # WAD, USDC_DECIMALS, tolerances
    ├── deploy.ts          # Fixture deployment helpers
    ├── utils.ts           # approx(), toBN(), createPrng()
    └── index.ts           # Consolidated exports
```

## Test Layers

### Layer 1: `unit/`
- **What**: Pure functions, libraries, isolated contracts
- **How**: No inter-contract calls, mock dependencies if needed
- **When**: Testing math, data structures, simple logic
- **Example**: `wMul(a, b)` returns correct WAD-scaled product

### Layer 2: `module/`
- **What**: Single module in delegatecall environment
- **How**: TradeModuleProxy or SignalsCore with one module wired
- **When**: Testing module-specific logic, validation, access control
- **Example**: `openPosition()` reverts on invalid tick range

### Layer 3: `integration/`
- **What**: Multiple modules working together
- **How**: Full SignalsCore with all modules, but controlled scenarios
- **When**: Testing flows, state transitions, module interactions
- **Example**: Open position → Settlement → Claim proceeds

### Layer 4: `parity/`
- **What**: v0 SDK vs v1 on-chain implementation
- **How**: Call SDK, call contract, compare results
- **When**: Ensuring backward compatibility and math correctness
- **Example**: SDK.calculateOpenCost() ≈ contract.calculateOpenCost()

### Layer 5: `invariant/`
- **What**: Properties that must always hold
- **How**: Random operations, check invariants after each
- **When**: Finding edge cases, ensuring protocol safety
- **Example**: Sum monotonicity: buy always increases total sum

### Layer 6: `e2e/`
- **What**: Complete user journeys
- **How**: Full system deployment, realistic scenarios
- **When**: Final validation before release
- **Example**: LP deposits → Markets trade → Settlement → LP withdraws with profit

## Naming Conventions

| Pattern | Meaning |
|---------|---------|
| `*.spec.ts` | All test files |
| `{module}.spec.ts` | Module-specific tests |
| `{feature}.{aspect}.spec.ts` | Feature + aspect (e.g., `trade.stress.spec.ts`) |
| `flow.spec.ts` | Standard flow tests |
| `boundaries.spec.ts` | Edge case tests |
| `invariants.spec.ts` | Invariant tests |

## Using Helpers

```typescript
// Import from centralized helpers
import { WAD, USDC_DECIMALS, SMALL_QUANTITY } from "../helpers/constants";
import { approx, toBN, createPrng } from "../helpers/utils";
import { deployTradeModuleProxy } from "../helpers/deploy";

// Or use the consolidated index
import { WAD, approx, deployTradeModuleProxy } from "../helpers";
```

## Writing New Tests

1. **Determine the layer**: Is this a pure function? Module? Integration?
2. **Pick the directory**: `unit/`, `module/`, `integration/`, etc.
3. **Follow naming**: `{feature}.spec.ts` or `{feature}.{aspect}.spec.ts`
4. **Use helpers**: Don't duplicate constants or utilities
5. **Document invariants**: Reference `docs/vault-invariants.md` if applicable

## Running Tests

```bash
# All tests
npx hardhat test

# Specific layer
npx hardhat test test/unit/**/*.spec.ts
npx hardhat test test/integration/**/*.spec.ts

# Specific file
npx hardhat test test/unit/lib/fixedPointMath.spec.ts
```

## Current Coverage

| Layer | Files | Tests |
|-------|-------|-------|
| unit/ | 5 | ~80 |
| module/ | 4 | ~25 |
| integration/ | 9 | ~120 |
| parity/ | 2 | ~30 |
| invariant/ | 1 | ~11 |
| e2e/ | 1 (skeleton) | ~34 (pending) |
| **Total** | **22** | **288** |

