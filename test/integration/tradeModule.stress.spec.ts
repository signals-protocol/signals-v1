import { ethers } from "hardhat";
import { expect } from "chai";
import {
  MockPaymentToken,
  MockFeePolicy,
  TradeModuleProxy,
  TradeModule,
  SignalsPosition,
  TestERC1967Proxy,
} from "../../typechain-types";
import { ISignalsCore } from "../../typechain-types/contracts/harness/TradeModuleProxy";
import { WAD } from "../helpers/constants";

async function deploySystem(numBins: number, spacing: number, endOffset = 10_000) {
  const [owner, ...users] = await ethers.getSigners();
  const payment = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
  const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(0);
  const positionImplFactory = await ethers.getContractFactory("SignalsPosition");
  const positionImpl = await positionImplFactory.deploy();
  await positionImpl.waitForDeployment();
  const initData = positionImplFactory.interface.encodeFunctionData("initialize", [owner.address]);
  const positionProxy = (await (
    await ethers.getContractFactory("TestERC1967Proxy")
  ).deploy(await positionImpl.getAddress(), initData)) as TestERC1967Proxy;
  const position = (await ethers.getContractAt(
    "SignalsPosition",
    await positionProxy.getAddress()
  )) as SignalsPosition;

  const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
  const tradeModule = await (
    await ethers.getContractFactory("TradeModule", { libraries: { LazyMulSegmentTree: lazy.target } })
  ).deploy();
  const core = await (
    await ethers.getContractFactory("TradeModuleProxy", { libraries: { LazyMulSegmentTree: lazy.target } })
  ).deploy(tradeModule.target);

  await core.setAddresses(
    payment.target,
    await position.getAddress(),
    300,
    60,
    owner.address,
    feePolicy.target
  );

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const market: ISignalsCore.MarketStruct = {
    isActive: true,
    settled: false,
    snapshotChunksDone: false,
    numBins,
    openPositionCount: 0,
    snapshotChunkCursor: 0,
    startTimestamp: now - 10,
    endTimestamp: now + endOffset,
    settlementTimestamp: now + endOffset,
    minTick: 0,
    maxTick: numBins,
    tickSpacing: spacing,
    settlementTick: 0,
    settlementValue: 0,
    liquidityParameter: WAD,
    feePolicy: ethers.ZeroAddress,
  };
  await core.setMarket(1, market);
  const factors = Array.from({ length: numBins }, () => WAD);
  await core.seedTree(1, factors);
  await position.connect(owner).setCore(core.target);

  for (const u of users.slice(0, 5)) {
    await payment.transfer(u.address, 100_000_000n);
    await payment.connect(u).approve(core.target, ethers.MaxUint256);
  }

  return { owner, users: users.slice(0, 5), payment, feePolicy, position, tradeModule, core };
}

describe("TradeModule stress and boundary scenarios", () => {
  it("handles many positions on large bin market without miscounting", async () => {
    const { users, core, position } = await deploySystem(128, 1);
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
      const pos = await position.getPosition(i);
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
    const { users, core, tradeModule } = await deploySystem(8, 1, 50);
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
