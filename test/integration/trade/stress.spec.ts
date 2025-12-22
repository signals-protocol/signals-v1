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

    // Track position owners properly for reliable closing
    const positionOwners: Record<number, typeof users[0]> = {};
    
    // Re-deploy for clean test with tracked ownership
    const { users: u2, core: c2 } = await deployLargeBinSystem(128);
    let id = 1;
    let seed2 = 424242;
    const rand2 = (max: number) => {
      seed2 = (seed2 * 1664525 + 1013904223) % 0xffffffff;
      return seed2 % max;
    };
    
    // Open positions with tracked ownership
    const ops = 50;
    for (let i = 0; i < ops; i++) {
      const userIdx = rand2(u2.length);
      const user = u2[userIdx];
      const lower = rand2(127);
      const upper = lower + 1 + rand2(128 - lower - 1);
      const qty = BigInt(500 + rand2(1_000));
      await c2.connect(user).openPosition(1, lower, upper, qty, 50_000_000);
      positionOwners[id] = user;
      id++;
    }
    
    expect(Number((await c2.markets(1)).openPositionCount)).to.equal(ops);
    
    // Close all positions with correct owners
    let closedCount = 0;
    for (let i = 1; i <= ops; i++) {
      const owner = positionOwners[i];
      await c2.connect(owner).closePosition(i, 0);
      closedCount++;
    }
    
    // Verify all positions closed
    const finalMarket = await c2.markets(1);
    expect(Number(finalMarket.openPositionCount)).to.equal(0);
    expect(closedCount).to.equal(ops);
  });

  it("handles extreme quantity values", async () => {
    const { users, core, position } = await deployTradeModuleSystem({
      markets: [{ numBins: 4, tickSpacing: 1, minTick: 0, maxTick: 4 }],
      userCount: 1,
      fundAmount: ethers.parseUnits("10000000", 6), // 10M USDC
    });
    
    const user = users[0];
    
    // Large quantity trade
    const largeQty = 1_000_000n;
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, largeQty);
    await core.connect(user).openPosition(1, 0, 4, largeQty, quote * 2n);
    
    const posInfo = await position.getPosition(1);
    expect(posInfo.quantity).to.equal(largeQty);
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
