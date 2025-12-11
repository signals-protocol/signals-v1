import { ethers } from "hardhat";
import { expect } from "chai";
import {
  SignalsPosition,
  TestERC1967Proxy,
} from "../../typechain-types";
import { ISignalsCore } from "../../typechain-types/contracts/harness/TradeModuleProxy";
import { WAD } from "../helpers/constants";

async function deploy(marketOverrides: Partial<ISignalsCore.MarketStruct> = {}) {
  const [owner, user] = await ethers.getSigners();
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
    numBins: 4,
    openPositionCount: 0,
    snapshotChunkCursor: 0,
    startTimestamp: now - 10,
    endTimestamp: now + 1_000,
    settlementTimestamp: now + 1_000,
    minTick: 0,
    maxTick: 4,
    tickSpacing: 1,
    settlementTick: 0,
    settlementValue: 0,
    liquidityParameter: WAD,
    feePolicy: ethers.ZeroAddress,
    ...marketOverrides,
  };
  await core.setMarket(1, market);
  await core.seedTree(1, [WAD, WAD, WAD, WAD]);
  await position.connect(owner).setCore(core.target);

  await payment.transfer(user.address, 10_000_000n);
  await payment.connect(user).approve(core.target, ethers.MaxUint256);

  return { core, tradeModule, user, payment };
}

describe("TradeModule slippage and bounds", () => {
  it("reverts open when cost exceeds maxCost near boundary", async () => {
    const { core, tradeModule, user } = await deploy();
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, quote - 1n)).to.be.revertedWithCustomError(
      tradeModule,
      "CostExceedsMaximum"
    );
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote + 1_000n);
  });

  it("reverts decrease when proceeds fall below minProceeds", async () => {
    const { core, tradeModule, user } = await deploy();
    await core.connect(user).openPosition(1, 0, 4, 2_000, 10_000_000);
    const quote = await core.calculateDecreaseProceeds.staticCall(1, 1_000);
    await expect(core.connect(user).decreasePosition(1, 1_000, quote + 1n)).to.be.revertedWithCustomError(
      tradeModule,
      "ProceedsBelowMinimum"
    );
    await core.connect(user).decreasePosition(1, 1_000, quote);
  });

  it("rejects trades on settled market", async () => {
    const { core, user } = await deploy({ settled: true, isActive: false });
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 1_000_000)).to.be.reverted;
  });
});
