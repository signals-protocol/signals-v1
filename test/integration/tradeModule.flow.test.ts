import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumberish } from "ethers";

const WAD = ethers.parseEther("1");

function toBN(v: BigNumberish) {
  return BigInt(v.toString());
}

describe("TradeModule flow (minimal parity)", () => {
  async function deploySystem(marketOverrides: Partial<any> = {}) {
    const [owner, user] = await ethers.getSigners();

    const payment = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
    const position = await (await ethers.getContractFactory("MockSignalsPosition")).deploy();
    const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(0);

    const lazyLib = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
    const tradeModule = await (await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })).deploy();

    const core = await (await ethers.getContractFactory("TradeModuleProxy", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })).deploy(tradeModule.target);

    await core.setAddresses(
      payment.target,
      position.target,
      1,
      1,
      owner.address,
      feePolicy.target
    );

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const market = {
      isActive: true,
      settled: false,
      snapshotChunksDone: false,
      numBins: 4,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      startTimestamp: now - 10,
      endTimestamp: now + 1000,
      settlementTimestamp: now + 1000,
      minTick: 0,
      maxTick: 4,
      tickSpacing: 1,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: ethers.ZeroAddress,
      ...marketOverrides,
    } as any;
    await core.setMarket(1, market);
    await core.seedTree(1, [WAD, WAD, WAD, WAD]);

    // fund user
    await payment.transfer(user.address, 10_000_000n); // 10 USDC (6 decimals)
    await payment.connect(user).approve(core.target, ethers.MaxUint256);

    return { owner, user, payment, position, core, feePolicy };
  }

  it("open -> increase -> decrease -> close updates balances and openPositionCount", async () => {
    const { user, payment, core, position } = await deploySystem();

    const startBal = await payment.balanceOf(user.address);

    const nextId = await position.nextId();
    const positionId = Number(nextId);
    await core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000); // 0.001 USDC

    let market = await core.markets(1);
    expect(market.openPositionCount).to.equal(1);

    await core.connect(user).increasePosition(positionId, 1_000, 5_000_000);
    await core.connect(user).decreasePosition(positionId, 1_000, 0);
    await core.connect(user).closePosition(positionId, 0);

    market = await core.markets(1);
    expect(market.openPositionCount).to.equal(0);
    expect(await position.exists(positionId)).to.equal(false);

    const endBal = await payment.balanceOf(user.address);
    expect(endBal).to.be.lessThan(startBal); // paid trading cost overall
  });

  it("reverts on inactive market and invalid ticks", async () => {
    const { user, core } = await deploySystem({ isActive: false });
    const tradeModule = await ethers.getContractAt("TradeModule", await core.module());
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000)).to.be.revertedWithCustomError(
      tradeModule,
      "MarketNotActive"
    );

    const { user: user2, core: core2 } = await deploySystem();
    const tradeModule2 = await ethers.getContractAt("TradeModule", await core2.module());
    await expect(core2.connect(user2).openPosition(1, 0, 5, 1_000, 5_000_000)).to.be.revertedWithCustomError(
      tradeModule2,
      "InvalidTick"
    );
  });

  it("calculateOpenCost matches actual debit (fee=0)", async () => {
    const { user, core, payment } = await deploySystem();
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote);
    const balAfter = await payment.balanceOf(user.address);
    expect(balBefore - balAfter).to.equal(quote);
  });
});
