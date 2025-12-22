import { expect } from "chai";
import { deployMultiMarketSystem } from "../../helpers/deploy";

describe("TradeModule randomized multi-market flows", () => {
  it("maintains openPositionCount and position existence across random ops", async () => {
    const { users, core, payment, position: positionContract } = await deployMultiMarketSystem();
    
    // Fund users with smaller amounts for this test
    for (const u of users) {
      await payment.transfer(u.address, 20_000_000n);
    }

    type Pos = { owner: number; market: number; qty: bigint; alive: boolean };
    const positions: Record<number, Pos> = {};
    let nextId = 1;
    let seed = 99991;
    const rand = (max: number) => {
      seed = (seed * 1664525 + 1013904223) % 0xffffffff;
      return seed % max;
    };

    const operations = 50;
    for (let i = 0; i < operations; i++) {
      const op = rand(4);
      const userIdx = rand(users.length);
      const user = users[userIdx];
      const marketId = rand(2) + 1; // 1 or 2
      const ticks =
        marketId === 1
          ? { lower: 0, upper: 4 }
          : (() => {
              const lo = -2 + rand(3); // -2,-1,0
              return { lower: lo, upper: lo + 1 };
            })();
      if (op === 0) {
        const qty = BigInt(500 + rand(1_000));
        await core.connect(user).openPosition(marketId, ticks.lower, ticks.upper, qty, 20_000_000);
        positions[nextId] = { owner: userIdx, market: marketId, qty, alive: true };
        nextId++;
      } else if (op === 1 && Object.keys(positions).length > 0) {
        const aliveIds = Object.entries(positions)
          .filter(([, p]) => p.alive)
          .map(([id]) => Number(id));
        if (aliveIds.length === 0) continue;
        const id = aliveIds[rand(aliveIds.length)];
        const pos = positions[id];
        const decQty = pos.qty / 2n;
        if (decQty === 0n) continue;
        await core.connect(users[pos.owner]).decreasePosition(id, decQty, 0);
        positions[id].qty -= decQty;
        if (positions[id].qty === 0n) positions[id].alive = false;
      } else if (op === 2 && Object.keys(positions).length > 0) {
        const aliveIds = Object.entries(positions)
          .filter(([, p]) => p.alive)
          .map(([id]) => Number(id));
        if (aliveIds.length === 0) continue;
        const id = aliveIds[rand(aliveIds.length)];
        const pos = positions[id];
        await core.connect(users[pos.owner]).closePosition(id, 0);
        positions[id].alive = false;
        positions[id].qty = 0n;
      } else if (op === 3) {
        // increase
        const aliveIds = Object.entries(positions)
          .filter(([, p]) => p.alive)
          .map(([id]) => Number(id));
        if (aliveIds.length === 0) continue;
        const id = aliveIds[rand(aliveIds.length)];
        const pos = positions[id];
        const addQty = BigInt(100 + rand(500));
        await core.connect(users[pos.owner]).increasePosition(id, addQty, 20_000_000);
        positions[id].qty += addQty;
      }
      // sanity: balances non-negative
      for (const u of users) {
        const bal = await payment.balanceOf(u.address);
        expect(bal).to.be.gte(0);
      }
    }

    // verify openPositionCount per market matches alive positions
    for (const marketId of [1, 2]) {
      const aliveCount = Object.values(positions).filter((p) => p.alive && p.market === marketId).length;
      const market = await core.markets(marketId);
      expect(Number(market.openPositionCount)).to.equal(aliveCount);
    }

    // verify position NFT existence matches alive state (using same position contract)
    for (const [id, pos] of Object.entries(positions)) {
      const exists = await positionContract.exists(Number(id));
      expect(exists).to.equal(pos.alive, `Position ${id} existence mismatch: expected ${pos.alive}, got ${exists}`);
    }
  });

  it("preserves position quantity after random increase/decrease", async () => {
    const { users, core, payment, position: positionContract } = await deployMultiMarketSystem();
    
    for (const u of users) {
      await payment.transfer(u.address, 50_000_000n);
    }

    const user = users[0];
    const marketId = 1;
    const initialQty = 1000n;
    
    // Open position
    await core.connect(user).openPosition(marketId, 0, 4, initialQty, 20_000_000);
    const positionId = 1n;
    
    // Perform random increases and decreases
    let expectedQty = initialQty;
    let seed = 12345;
    const rand = (max: number) => {
      seed = (seed * 1664525 + 1013904223) % 0xffffffff;
      return seed % max;
    };
    
    for (let i = 0; i < 20; i++) {
      const op = rand(2);
      if (op === 0) {
        // Increase
        const addQty = BigInt(100 + rand(300));
        await core.connect(user).increasePosition(positionId, addQty, 20_000_000);
        expectedQty += addQty;
      } else {
        // Decrease
        if (expectedQty > 100n) {
          const decQty = BigInt(rand(Number(expectedQty / 2n)) + 1);
          await core.connect(user).decreasePosition(positionId, decQty, 0);
          expectedQty -= decQty;
        }
      }
    }
    
    // Verify final quantity matches expectation
    const posInfo = await positionContract.getPosition(positionId);
    expect(posInfo.quantity).to.equal(expectedQty);
  });
});
