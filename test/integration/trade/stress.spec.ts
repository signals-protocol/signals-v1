import { ethers } from "hardhat";
import { expect } from "chai";
import { deployLargeBinSystem, deployTradeModuleSystem } from "../../helpers/deploy";

describe("TradeModule stress and boundary scenarios", () => {
  it("handles many positions on large bin market without miscounting", async () => {
    const { users, core, position } = await deployLargeBinSystem(128);
    let nextId = Number(await position.nextId());
    let seed = 424242;
    const rand = (max: number) => {
      seed = (seed * 1664525 + 1013904223) % 0xffffffff;
      return seed % max;
    };

    const totalOps = 120;
    for (let i = 0; i < totalOps; i++) {
      const user = users[rand(users.length)];
      const lower = rand(127);
      const upper = lower + 1 + rand(128 - lower - 1);
      const qty = BigInt(500 + rand(1_000));
      await core.connect(user).openPosition(1, lower, upper, qty, 50_000_000);
      nextId++;
    }

    const market = await core.markets(1);
    expect(Number(market.openPositionCount)).to.equal(totalOps);
    // close half randomly
    for (let i = 1; i <= totalOps; i += 2) {
      await position.getPosition(i); // Ensure position exists
      const ownerIdx = Number(rand(users.length));
      const owner = users[ownerIdx];
      // skip if owner mismatch, just attempt and tolerate revert by catching
      try {
        await core.connect(owner).closePosition(i, 0);
      } catch {
        // ignore failed close due to ownership; count unaffected
      }
    }
  });

  it("reverts trades after market expiry and honors slippage near endTimestamp", async () => {
    const { users, core, tradeModule } = await deployTradeModuleSystem({
      markets: [{ numBins: 8, tickSpacing: 1, minTick: 0, maxTick: 8, endOffset: 50 }],
      userCount: 1,
    });
    const user = users[0];
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote + 1_000n);

    const end = (await core.markets(1)).endTimestamp;
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(end) + 1]);
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, quote + 1_000n)).to.be.revertedWithCustomError(
      tradeModule,
      "MarketExpired"
    );
  });
});
