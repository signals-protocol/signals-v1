import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployLazyMulSegmentTreeTest } from "../../helpers/deploy";
import {
  WAD,
  TWO_WAD,
  HALF_WAD,
  MIN_FACTOR,
  MAX_FACTOR,
} from "../../helpers/constants";
import { approx, createPrng, randomFactors } from "../../helpers/utils";

describe("LazyMulSegmentTree", () => {
  async function deployFixture() {
    const test = await deployLazyMulSegmentTreeTest();
    return { test };
  }

  async function deployMediumTreeFixture() {
    const test = await deployLazyMulSegmentTreeTest();
    await test.init(100);
    return { test };
  }

  async function deploySeededTreeFixture() {
    const test = await deployLazyMulSegmentTreeTest();
    // Seed with uniform distribution [1, 1, 1, 1]
    await test.initAndSeed([WAD, WAD, WAD, WAD]);
    return { test };
  }

  // ============================================================
  // Initialization
  // ============================================================
  describe("init", () => {
    it("initializes tree with correct size", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.init(100);
      expect(await test.getTreeSize()).to.equal(100);
    });

    it("reverts on zero size", async () => {
      const { test } = await loadFixture(deployFixture);
      // CE.TreeSizeZero defined in CLMSRErrors
      await expect(test.init(0)).to.be.reverted;
    });

    it("harness allows re-initialization (reset for testing)", async () => {
      // Note: Harness resets tree before init for testing convenience
      // Actual library reverts on double init, but harness overrides this
      const { test } = await loadFixture(deployFixture);
      await test.init(10);
      await test.init(20); // Harness allows this
      expect(await test.getTreeSize()).to.equal(20);
    });

    it("reverts on size too large", async () => {
      const { test } = await loadFixture(deployFixture);
      const maxU32 = 2n ** 32n - 1n;
      // CE.TreeSizeTooLarge defined in CLMSRErrors
      await expect(test.init(maxU32)).to.be.reverted;
    });
  });

  // ============================================================
  // Seeding
  // ============================================================
  describe("initAndSeed", () => {
    it("seeds tree with given factors", async () => {
      const { test } = await loadFixture(deployFixture);
      const factors = [
        WAD,
        TWO_WAD,
        ethers.parseEther("3"),
        ethers.parseEther("4"),
      ];
      await test.initAndSeed(factors);

      expect(await test.getTreeSize()).to.equal(4);

      // Total sum should be 1 + 2 + 3 + 4 = 10 WAD
      const total = await test.getTotalSum();
      expect(total).to.equal(ethers.parseEther("10"));
    });

    it("reverts on empty factors", async () => {
      const { test } = await loadFixture(deployFixture);
      await expect(test.initAndSeed([])).to.be.reverted;
    });
  });

  // ============================================================
  // Range Sum
  // ============================================================
  describe("getRangeSum", () => {
    it("returns correct sum for single element", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const sum = await test.getRangeSum(0, 0);
      expect(sum).to.equal(WAD);
    });

    it("returns correct sum for full range", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const sum = await test.getRangeSum(0, 3);
      expect(sum).to.equal(ethers.parseEther("4"));
    });

    it("returns correct sum for partial range", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const sum = await test.getRangeSum(1, 2);
      expect(sum).to.equal(TWO_WAD);
    });

    it("reverts on invalid range (lo > hi)", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      // CE.InvalidRange defined in CLMSRErrors
      await expect(test.getRangeSum(3, 1)).to.be.reverted;
    });

    it("reverts on out of bounds index", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      // CE.IndexOutOfBounds defined in CLMSRErrors
      await expect(test.getRangeSum(0, 10)).to.be.reverted;
    });
  });

  // ============================================================
  // Apply Range Factor
  // ============================================================
  describe("applyRangeFactor", () => {
    it("multiplies single element by factor", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      await test.applyRangeFactor(0, 0, TWO_WAD);

      const val = await test.getNodeValue(0);
      expect(val).to.equal(TWO_WAD);

      // Other elements unchanged
      expect(await test.getNodeValue(1)).to.equal(WAD);
    });

    it("multiplies range by factor", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      await test.applyRangeFactor(0, 3, TWO_WAD);

      // All elements doubled: 4 * 2 = 8 WAD total
      const total = await test.getTotalSum();
      expect(total).to.equal(ethers.parseEther("8"));
    });

    it("applies multiple factors correctly", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);

      // First: multiply [0,1] by 2
      await test.applyRangeFactor(0, 1, TWO_WAD);
      // Second: multiply [1,2] by 3
      await test.applyRangeFactor(1, 2, ethers.parseEther("3"));

      // Element 0: 1 * 2 = 2
      // Element 1: 1 * 2 * 3 = 6
      // Element 2: 1 * 3 = 3
      // Element 3: 1
      const total = await test.getTotalSum();
      expect(total).to.equal(ethers.parseEther("12"));
    });

    it("reverts on factor below MIN_FACTOR", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const tooSmall = ethers.parseEther("0.001"); // < 0.01
      // CE.InvalidFactor defined in CLMSRErrors
      await expect(test.applyRangeFactor(0, 0, tooSmall)).to.be.reverted;
    });

    it("reverts on factor above MAX_FACTOR", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const tooLarge = ethers.parseEther("200"); // > 100
      // CE.InvalidFactor defined in CLMSRErrors
      await expect(test.applyRangeFactor(0, 0, tooLarge)).to.be.reverted;
    });

    it("reverts on invalid range", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      // CE.InvalidRange defined in CLMSRErrors
      await expect(test.applyRangeFactor(3, 1, TWO_WAD)).to.be.reverted;
    });
  });

  // ============================================================
  // Lazy Propagation
  // ============================================================
  describe("Lazy propagation", () => {
    it("handles deferred propagation correctly", async () => {
      const { test } = await loadFixture(deployMediumTreeFixture);
      await test.seedWithFactors(Array(100).fill(WAD));

      // Multiple overlapping range operations
      await test.applyRangeFactor(10, 30, TWO_WAD);
      await test.applyRangeFactor(20, 40, ethers.parseEther("3"));
      await test.applyRangeFactor(5, 25, HALF_WAD);

      // Query specific values
      // Index 15: 1 * 2 * 0.5 = 1
      expect(await test.getNodeValue(15)).to.equal(WAD);

      // Index 25: 1 * 2 * 3 * 0.5 = 3
      approx(await test.getNodeValue(25), ethers.parseEther("3"), 10n);

      // Index 35: 1 * 3 = 3
      expect(await test.getNodeValue(35)).to.equal(ethers.parseEther("3"));

      // Index 50: unchanged = 1
      expect(await test.getNodeValue(50)).to.equal(WAD);
    });
  });

  // ============================================================
  // Edge Cases
  // ============================================================
  describe("Edge cases", () => {
    it("handles tree of size 1", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed([WAD]);

      expect(await test.getTotalSum()).to.equal(WAD);

      await test.applyRangeFactor(0, 0, TWO_WAD);
      expect(await test.getTotalSum()).to.equal(TWO_WAD);
    });

    it("handles minimum valid factor (0.01)", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      await test.applyRangeFactor(0, 0, MIN_FACTOR);

      // 1 * 0.01 = 0.01
      approx(await test.getNodeValue(0), MIN_FACTOR, 10n);
    });

    it("handles maximum valid factor (100)", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      await test.applyRangeFactor(0, 0, MAX_FACTOR);

      // 1 * 100 = 100
      expect(await test.getNodeValue(0)).to.equal(MAX_FACTOR);
    });

    it("handles factor of exactly 1 (no change)", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);
      const before = await test.getTotalSum();
      await test.applyRangeFactor(0, 3, WAD);
      const after = await test.getTotalSum();
      expect(after).to.equal(before);
    });
  });

  // ============================================================
  // Property: Sum Consistency
  // ============================================================
  describe("Property: sum consistency", () => {
    it("total sum equals sum of all individual nodes", async () => {
      const { test } = await loadFixture(deployMediumTreeFixture);
      const prng = createPrng(42n);
      const factors = randomFactors(prng, 100, MIN_FACTOR, MAX_FACTOR);
      await test.seedWithFactors(factors);

      // Calculate expected total
      let expected = 0n;
      for (let i = 0; i < 100; i++) {
        expected += await test.getNodeValue(i);
      }

      const total = await test.getTotalSum();
      approx(total, expected, 100n); // Allow small rounding
    });

    it("operations preserve sum consistency", async () => {
      const { test } = await loadFixture(deployMediumTreeFixture);
      await test.seedWithFactors(Array(100).fill(WAD));

      const prng = createPrng(123n);

      // Apply 10 random range operations
      for (let i = 0; i < 10; i++) {
        const lo = prng.nextInt(100);
        const hi = lo + prng.nextInt(100 - lo);
        const factor = prng.nextInRange(MIN_FACTOR, MAX_FACTOR);
        await test.applyRangeFactor(lo, hi, factor);
      }

      // Verify sum consistency
      let computed = 0n;
      for (let i = 0; i < 100; i++) {
        computed += await test.getNodeValue(i);
      }

      const total = await test.getTotalSum();
      // Allow larger tolerance due to accumulated WAD rounding
      approx(total, computed, 10000n);
    });
  });

  // ============================================================
  // Property: Monotonicity (buy increases sum)
  // ============================================================
  describe("Property: monotonicity", () => {
    it("factor > 1 increases range sum", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);

      const before = await test.getRangeSum(0, 1);
      await test.applyRangeFactor(0, 1, TWO_WAD);
      const after = await test.getRangeSum(0, 1);

      expect(after).to.be.gt(before);
    });

    it("factor < 1 decreases range sum", async () => {
      const { test } = await loadFixture(deploySeededTreeFixture);

      const before = await test.getRangeSum(0, 1);
      await test.applyRangeFactor(0, 1, HALF_WAD);
      const after = await test.getRangeSum(0, 1);

      expect(after).to.be.lt(before);
    });
  });

  // ============================================================
  // Non-uniform Distribution
  // ============================================================
  describe("Non-uniform distribution", () => {
    it("handles non-uniform initial factors", async () => {
      const { test } = await loadFixture(deployFixture);
      const factors = [
        ethers.parseEther("1"),
        ethers.parseEther("2"),
        ethers.parseEther("4"),
        ethers.parseEther("8"),
      ];
      await test.initAndSeed(factors);

      // Total: 1 + 2 + 4 + 8 = 15
      expect(await test.getTotalSum()).to.equal(ethers.parseEther("15"));

      // Apply factor to middle range
      await test.applyRangeFactor(1, 2, TWO_WAD);

      // New total: 1 + 4 + 8 + 8 = 21
      expect(await test.getTotalSum()).to.equal(ethers.parseEther("21"));
    });
  });

  // ============================================================
  // Edge Cases: Cancellation (combinedPending == ONE_WAD)
  // ============================================================
  describe("Edge cases: cancellation (f then 1/f)", () => {
    it("cancellation case: f=2 then f=0.5 on same range preserves subrange query", async () => {
      const { test } = await loadFixture(deployFixture);
      // 8 bins for better coverage of internal nodes
      await test.initAndSeed(Array(8).fill(WAD));

      const totalBefore = await test.getTotalSum();
      const subrangeBefore = await test.getRangeSum(0, 3);

      // Apply f=2 to partial range [0,3]
      await test.applyRangeFactor(0, 3, TWO_WAD);

      // Apply inverse f=0.5 to same range -> combinedPending should become ONE_WAD
      await test.applyRangeFactor(0, 3, HALF_WAD);

      // Total and subrange should return to original (within rounding tolerance)
      const totalAfter = await test.getTotalSum();
      const subrangeAfter = await test.getRangeSum(0, 3);

      approx(totalAfter, totalBefore, 10n);
      approx(subrangeAfter, subrangeBefore, 10n);
    });

    it("cancellation case: nested ranges with inverse factors", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(16).fill(WAD));

      // Apply f=4 to [0,7]
      await test.applyRangeFactor(0, 7, ethers.parseEther("4"));

      // Apply f=0.25 to [0,7] -> cancellation
      await test.applyRangeFactor(0, 7, ethers.parseEther("0.25"));

      // Subrange query should match original
      const subrangeSum = await test.getRangeSum(2, 5);
      // Original: 4 bins * 1 WAD = 4 WAD
      approx(subrangeSum, ethers.parseEther("4"), 10n);
    });

    it("cancellation case: overlapping ranges with partial inverse", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(8).fill(WAD));

      // Apply f=10 to [0,3]
      await test.applyRangeFactor(0, 3, ethers.parseEther("10"));

      // Apply f=0.1 to [2,5] -> partial cancellation on [2,3]
      await test.applyRangeFactor(2, 5, ethers.parseEther("0.1"));

      // Elements 0,1: 1 * 10 = 10
      // Elements 2,3: 1 * 10 * 0.1 = 1
      // Elements 4,5: 1 * 0.1 = 0.1
      // Elements 6,7: 1
      // Total: 20 + 2 + 0.2 + 2 = 24.2
      const total = await test.getTotalSum();
      approx(total, ethers.parseEther("24.2"), 100n);

      // Subrange [2,3] should be back to ~2 WAD
      const subrange23 = await test.getRangeSum(2, 3);
      approx(subrange23, ethers.parseEther("2"), 10n);
    });
  });

  // ============================================================
  // Edge Cases: Flush Threshold Stress
  // ============================================================
  describe("Edge cases: flush threshold stress", () => {
    it("repeated MAX_FACTOR triggers flush without overflow", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(4).fill(WAD));

      // Apply MAX_FACTOR (100) multiple times to trigger flush
      // pending will grow: 100 -> 10000 -> flush -> 100 -> ...
      for (let i = 0; i < 5; i++) {
        await test.applyRangeFactor(0, 3, MAX_FACTOR);
      }

      // Should not revert, and total should be 4 * 100^5 = 4e10 WAD
      const total = await test.getTotalSum();
      // 4 bins * 1 WAD each * 100^5 factor = 4e10 * 1e18 = 4e28
      // expected = 4 * 100^5 = 4 * 10^10 WAD
      const expected = ethers.parseEther("40000000000"); // 4e10 WAD
      approx(total, expected, expected / 100n); // 1% tolerance
    });

    it("repeated MIN_FACTOR triggers flush without underflow", async () => {
      const { test } = await loadFixture(deployFixture);
      // Start with larger values to avoid zero
      await test.initAndSeed(Array(4).fill(ethers.parseEther("1000000")));

      // Apply MIN_FACTOR (0.01) multiple times to trigger flush
      // pending will shrink: 0.01 -> 0.0001 -> flush -> 0.01 -> ...
      for (let i = 0; i < 5; i++) {
        await test.applyRangeFactor(0, 3, MIN_FACTOR);
      }

      // Should not revert
      const total = await test.getTotalSum();
      // 4 * 1e6 * 0.01^5 = 4e6 * 1e-10 = 4e-4 = 0.0004 WAD per bin
      const expected =
        (ethers.parseEther("4000000") * MIN_FACTOR ** 5n) / WAD ** 5n;
      approx(total, expected, expected / 10n + 1n); // Allow larger tolerance for small values
    });

    it("alternating MAX and MIN factors", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(4).fill(WAD));

      // Alternating: should roughly cancel out
      for (let i = 0; i < 3; i++) {
        await test.applyRangeFactor(0, 3, MAX_FACTOR); // *100
        await test.applyRangeFactor(0, 3, MIN_FACTOR); // *0.01
      }

      // Net effect: (100 * 0.01)^3 = 1^3 = 1
      const total = await test.getTotalSum();
      approx(total, ethers.parseEther("4"), 100n);
    });
  });

  // ============================================================
  // Edge Cases: View vs State-Changing Query Consistency
  // ============================================================
  describe("Edge cases: view vs state-changing query consistency", () => {
    it("getRangeSum (view) matches propagateLazy (state-changing)", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(8).fill(WAD));

      // Apply some factors
      await test.applyRangeFactor(0, 3, TWO_WAD);
      await test.applyRangeFactor(2, 5, ethers.parseEther("3"));

      // View query
      const viewSum = await test.getRangeSum(1, 4);

      // State-changing query (propagateLazy) - call staticCall to get return value
      const propagatedSum = await test.propagateLazy.staticCall(1, 4);

      expect(viewSum).to.equal(propagatedSum);
    });

    it("view query unchanged after propagateLazy", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(8).fill(WAD));

      await test.applyRangeFactor(0, 7, TWO_WAD);

      const viewBefore = await test.getRangeSum(2, 5);
      await test.propagateLazy(2, 5);
      const viewAfter = await test.getRangeSum(2, 5);

      expect(viewAfter).to.equal(viewBefore);
    });

    it("multiple propagateLazy calls are idempotent", async () => {
      const { test } = await loadFixture(deployFixture);
      await test.initAndSeed(Array(8).fill(WAD));

      await test.applyRangeFactor(0, 7, ethers.parseEther("5"));

      // Use staticCall to get return values
      const first = await test.propagateLazy.staticCall(0, 7);
      await test.propagateLazy(0, 7); // Actually execute to change state
      const second = await test.propagateLazy.staticCall(0, 7);
      await test.propagateLazy(0, 7);
      const third = await test.propagateLazy.staticCall(0, 7);

      expect(first).to.equal(second);
      expect(second).to.equal(third);
    });
  });

  // ============================================================
  // Property: Naive Model Comparison
  // ============================================================
  describe("Property: naive model comparison", () => {
    it("segment tree matches naive array model after random operations", async () => {
      const { test } = await loadFixture(deployFixture);
      const size = 16;
      await test.initAndSeed(Array(size).fill(WAD));

      // Naive model: array of values
      const naive: bigint[] = Array(size).fill(WAD);

      const prng = createPrng(777n);

      // Apply 20 random range operations
      for (let op = 0; op < 20; op++) {
        const lo = prng.nextInt(size);
        const hi = lo + prng.nextInt(size - lo);
        const factor = prng.nextInRange(MIN_FACTOR, MAX_FACTOR);

        // Apply to segment tree
        await test.applyRangeFactor(lo, hi, factor);

        // Apply to naive model
        for (let i = lo; i <= hi; i++) {
          naive[i] = (naive[i] * factor + WAD / 2n) / WAD; // wMulNearest
        }
      }

      // Compare individual node values
      for (let i = 0; i < size; i++) {
        const treeVal = await test.getNodeValue(i);
        // Allow 0.01% tolerance due to accumulated rounding differences
        const tolerance = naive[i] / 10000n + 10n;
        approx(treeVal, naive[i], tolerance);
      }

      // Compare total sum
      const naiveTotal = naive.reduce((a, b) => a + b, 0n);
      const treeTotal = await test.getTotalSum();
      approx(treeTotal, naiveTotal, naiveTotal / 1000n + 100n);
    });
  });
});
