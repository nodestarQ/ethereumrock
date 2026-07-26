// Pre-wrap deposit-window regression (audit hardening).
//
// Wrapping is two user actions: giftRock(id, warden) on v1, then wrap(id) on EthereumRock. Between them the
// raw rock sits in the warden at its old price. v1 buyRock skips the owner payout for the single id
// equal to latestNewRockForSale, so the "non-payable warden reverts the payout" defense does NOT
// cover that one id during the window. These tests pin:
//   1. the naive flow is snipeable for the latestNewRockForSale id,
//   2. locking the rock at max price before gifting it in (the frontend's hardened wrap flow) closes
//      the window on any deployment,
//   3. a non-frontier rock is protected by non-payability alone, as before.
//
// On live 0x37504 latestNewRockForSale == 14 and rock 14 is frozen at 0x…dEaD / max price, so the
// window is unreachable there; this proves the mitigation regardless.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, maxUint256 } from "viem";

describe("pre-wrap deposit window", () => {
  async function setup() {
    const { viem } = await network.create();
    const [victim, attacker] = await viem.getWalletClients();
    const mock = await viem.deployContract("MockEtherRock");
    const renderer = await viem.deployContract("EthereumRockRenderer");
    const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
    const lower = (a: string) => a.toLowerCase();
    return { viem, victim, attacker, mock, rock, lower };
  }

  it("naive gift-then-wrap: the latestNewRockForSale rock is sniped out of the warden for 0 wei", async () => {
    const { victim, attacker, mock, rock, lower } = await setup();
    const id = 100n;
    await mock.write.setLatestNewRockForSale([id]);
    await mock.write.mint([id], { account: victim.account });
    await rock.write.createWarden({ account: victim.account });
    const warden = await rock.read.wardens([victim.account.address]);
    await mock.write.giftRock([id, warden], { account: victim.account });

    // price is 0 and the payout is skipped for latestNewRockForSale, so non-payability never fires
    await mock.write.buyRock([id], { account: attacker.account, value: 0n });
    assert.equal(lower(await mock.read.rockOwner([id])), lower(attacker.account.address));

    // the warden no longer owns the rock, so the victim can't wrap it
    await assert.rejects(rock.write.wrap([id], { account: victim.account }));
  });

  it("lock-at-max before gifting (the hardened wrap flow) blocks the snipe and still wraps", async () => {
    const { victim, attacker, mock, rock, lower } = await setup();
    const id = 101n;
    await mock.write.setLatestNewRockForSale([id]);
    await mock.write.mint([id], { account: victim.account });

    // hardened flow: sellRock(id, max) BEFORE giftRock
    await mock.write.sellRock([id, maxUint256], { account: victim.account });
    await rock.write.createWarden({ account: victim.account });
    const warden = await rock.read.wardens([victim.account.address]);
    await mock.write.giftRock([id, warden], { account: victim.account });

    // the attacker would need 2**256-1 wei to match the price; any affordable buy reverts
    await assert.rejects(mock.write.buyRock([id], { account: attacker.account, value: 0n }));

    // and the victim wraps normally
    await rock.write.wrap([id], { account: victim.account });
    assert.equal(lower(await rock.read.ownerOf([id])), lower(victim.account.address));
  });

  it("control: a non-frontier rock is protected by non-payability even without pre-locking", async () => {
    const { victim, attacker, mock, rock, lower } = await setup();
    const id = 200n; // != latestNewRockForSale (default 0)
    await mock.write.mint([id], { account: victim.account });
    await rock.write.createWarden({ account: victim.account });
    const warden = await rock.read.wardens([victim.account.address]);
    await mock.write.giftRock([id, warden], { account: victim.account });

    // buyRock routes the payout to the non-payable warden, which reverts even for 0 wei
    await assert.rejects(mock.write.buyRock([id], { account: attacker.account, value: 0n }));
    assert.equal(lower(await mock.read.rockOwner([id])), lower(warden));
  });
});
