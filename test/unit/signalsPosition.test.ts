import { ethers } from "hardhat";
import { expect } from "chai";
import { SignalsPosition, TestERC1967Proxy } from "../../typechain-types";

async function deployPosition(initialCore: string): Promise<SignalsPosition> {
  const implFactory = await ethers.getContractFactory("SignalsPosition");
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const initData = implFactory.interface.encodeFunctionData("initialize", [initialCore]);
  const proxy = (await (await ethers.getContractFactory("TestERC1967Proxy")).deploy(
    await impl.getAddress(),
    initData
  )) as TestERC1967Proxy;
  return (await ethers.getContractAt("SignalsPosition", await proxy.getAddress())) as SignalsPosition;
}

describe("SignalsPosition", () => {
  it("enforces core-only mint/burn/update", async () => {
    const [core, user] = await ethers.getSigners();
    const position = await deployPosition(core.address);

    await expect(
      position.connect(user).mintPosition(user.address, 1, 0, 1, 1_000)
    ).to.be.revertedWithCustomError(position, "UnauthorizedCaller").withArgs(user.address);

    await position.connect(core).mintPosition(user.address, 1, 0, 1, 1_000);
    await expect(position.connect(core).updateQuantity(1, 0)).to.be.revertedWithCustomError(
      position,
      "InvalidQuantity"
    );
    await position.connect(core).updateQuantity(1, 2_000);

    await expect(position.connect(user).burn(1)).to.be.revertedWithCustomError(
      position,
      "UnauthorizedCaller"
    );
    await position.connect(core).burn(1);
    await expect(position.getPosition(1)).to.be.revertedWithCustomError(position, "PositionNotFound");
  });

  it("tracks owner indices across mint/transfer/burn", async () => {
    const [core, alice, bob] = await ethers.getSigners();
    const position = await deployPosition(core.address);
    await position.connect(core).mintPosition(alice.address, 1, 0, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 1, 2, 4, 1_000);

    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([1n, 2n]);

    await position.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1);
    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([2n]);
    expect(await position.getPositionsByOwner(bob.address)).to.deep.equal([1n]);

    await position.connect(core).burn(2);
    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([]);
  });

  it("provides market indexing with hole markers", async () => {
    const [core, alice] = await ethers.getSigners();
    const position = await deployPosition(core.address);
    await position.connect(core).mintPosition(alice.address, 7, 0, 1, 1_000);
    await position.connect(core).mintPosition(alice.address, 7, 1, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 7, 2, 3, 1_000);

    expect(await position.getMarketTokenLength(7)).to.equal(3);
    await position.connect(core).burn(2);
    expect(await position.getMarketTokenLength(7)).to.equal(3); // hole remains
    expect(await position.getMarketTokenAt(7, 1)).to.equal(0);
    expect(await position.getMarketPositions(7)).to.deep.equal([1n, 0n, 3n]);
  });

  it("filters user positions per market", async () => {
    const [core, alice, bob] = await ethers.getSigners();
    const position = await deployPosition(core.address);
    await position.connect(core).mintPosition(alice.address, 5, 0, 1, 1_000);
    await position.connect(core).mintPosition(bob.address, 5, 1, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 6, 0, 1, 1_000);

    expect(await position.getUserPositionsInMarket(alice.address, 5)).to.deep.equal([1n]);
    expect(await position.getUserPositionsInMarket(bob.address, 5)).to.deep.equal([2n]);
    expect(await position.getUserPositionsInMarket(alice.address, 6)).to.deep.equal([3n]);
  });
});
