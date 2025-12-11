import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { SignalsPosition } from "../../../typechain-types";

/**
 * Position Access Control Tests
 *
 * Tests authorization and access control:
 * - Core address management
 * - onlyCore modifier enforcement
 * - Owner-only functions
 */

describe("SignalsPosition Access Control", () => {
  async function deployPositionFixture() {
    const [owner, core, alice, bob] = await ethers.getSigners();

    const implFactory = await ethers.getContractFactory("SignalsPosition");
    const impl = await implFactory.deploy();
    await impl.waitForDeployment();

    const initData = implFactory.interface.encodeFunctionData("initialize", [
      core.address,
    ]);
    const proxy = await (
      await ethers.getContractFactory("TestERC1967Proxy")
    ).deploy(await impl.getAddress(), initData);

    const position = (await ethers.getContractAt(
      "SignalsPosition",
      await proxy.getAddress()
    )) as SignalsPosition;

    return { owner, core, alice, bob, position };
  }

  describe("Core Authorization", () => {
    it("exposes current core address", async () => {
      const { position, core } = await loadFixture(deployPositionFixture);
      expect(await position.core()).to.equal(core.address);
    });

    it("allows owner to update core address", async () => {
      const { position, owner, alice } = await loadFixture(
        deployPositionFixture
      );

      const newCore = ethers.Wallet.createRandom().address;
      await position.connect(owner).setCore(newCore);

      expect(await position.core()).to.equal(newCore);
    });

    it("restricts setCore to owner only", async () => {
      const { position, alice } = await loadFixture(deployPositionFixture);

      const newCore = ethers.Wallet.createRandom().address;

      await expect(
        position.connect(alice).setCore(newCore)
      ).to.be.revertedWithCustomError(position, "OwnableUnauthorizedAccount");
    });

    it("reverts setCore with zero address", async () => {
      const { position, owner } = await loadFixture(deployPositionFixture);

      await expect(
        position.connect(owner).setCore(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(position, "ZeroAddress");
    });
  });

  describe("onlyCore Modifier", () => {
    it("allows core to mint positions", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await expect(
        position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000)
      ).to.not.be.reverted;
    });

    it("reverts mintPosition from non-core", async () => {
      const { position, alice } = await loadFixture(deployPositionFixture);

      await expect(
        position.connect(alice).mintPosition(alice.address, 1, 0, 10, 1000)
      )
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });

    it("allows core to update quantity", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await expect(position.connect(core).updateQuantity(1, 2000)).to.not.be
        .reverted;

      const pos = await position.getPosition(1);
      expect(pos.quantity).to.equal(2000);
    });

    it("reverts updateQuantity from non-core", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      await expect(position.connect(alice).updateQuantity(1, 2000))
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });

    it("allows core to burn positions", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await expect(position.connect(core).burn(1)).to.not.be.reverted;
    });

    it("reverts burn from non-core", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      await expect(position.connect(alice).burn(1))
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });
  });

  describe("Owner-only Functions", () => {
    it("owner can transfer ownership", async () => {
      const { position, owner, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(owner).transferOwnership(alice.address);
      expect(await position.owner()).to.equal(alice.address);
    });

    it("non-owner cannot transfer ownership", async () => {
      const { position, alice } = await loadFixture(deployPositionFixture);

      await expect(
        position.connect(alice).transferOwnership(alice.address)
      ).to.be.revertedWithCustomError(position, "OwnableUnauthorizedAccount");
    });
  });

  describe("Edge Cases", () => {
    it("handles core change mid-operation", async () => {
      const { position, core, owner, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      // Mint with original core
      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      // Change core
      await position.connect(owner).setCore(bob.address);

      // Old core can no longer operate
      await expect(position.connect(core).updateQuantity(1, 2000))
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(core.address);

      // New core can operate
      await expect(position.connect(bob).updateQuantity(1, 2000)).to.not.be
        .reverted;
    });

    it("prevents operations after position is burned", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).burn(1);

      await expect(
        position.connect(core).updateQuantity(1, 2000)
      ).to.be.revertedWithCustomError(position, "PositionNotFound");
    });
  });
});
