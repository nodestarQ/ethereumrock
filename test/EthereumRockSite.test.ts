// EthereumRockSite reconstructs the exact on-chain page from SSTORE2 chunks and serves it via EIP-5219.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { stringToHex, toFunctionSelector, decodeAbiParameters } from "viem";

// SSTORE2 write: init code that returns runtime `0x00 ++ data`. Deploying it yields a pointer whose
// bytecode is the data after a leading STOP, which is the layout EthereumRockSite._read expects.
function sstore2InitCode(dataHex: string): `0x${string}` {
  const dataLen = (dataHex.length - 2) / 2;
  const runtimeLen = dataLen + 1; // + STOP
  const lenHex = runtimeLen.toString(16).padStart(4, "0");
  return ("0x61" + lenHex + "80600a3d393df300" + dataHex.slice(2)) as `0x${string}`;
}

describe("EthereumRockSite (on-chain frontend, EIP-5219)", () => {
  it("reconstructs the exact page bytes across multiple chunks and serves text/html", async () => {
    const { viem } = await network.create();
    const [deployer] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();

    // a payload big enough to span several 24KB chunks, with non-ASCII to prove byte-exactness
    const content =
      "<!doctype html><html><head>" + "<meta>" + "rösk ⛰ rock ".repeat(4000) + "</head><body>x</body></html>";
    const bytes = Buffer.from(content, "utf8");
    const CHUNK = 24000;

    // chunk 0 ends just after <head>, the way a deployer has to split the page, because that is
    // where html() writes the ERC-8244 origin script in
    const seam = bytes.indexOf(Buffer.from("<head>")) + "<head>".length;
    const pieces = [bytes.subarray(0, seam)];
    for (let i = seam; i < bytes.length; i += CHUNK) pieces.push(bytes.subarray(i, i + CHUNK));

    const pointers: `0x${string}`[] = [];
    for (const piece of pieces) {
      const hash = await deployer.sendTransaction({ data: sstore2InitCode("0x" + piece.toString("hex")) });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      assert.ok(rcpt.contractAddress, "chunk deployed");
      pointers.push(rcpt.contractAddress!);
    }
    assert.ok(pointers.length >= 3, "payload should span the seam plus multiple chunks");

    const site = await viem.deployContract("EthereumRockSite", [pointers]);

    assert.equal(await site.read.resolveMode(), stringToHex("5219", { size: 32 }));
    assert.equal(Number(await site.read.chunkCount()), pointers.length);

    // html() is the stored file with the origin script spliced in at the seam, and nothing else:
    // strip the script back out and the original bytes must return exactly. This is what keeps the
    // same page usable from IPFS or file://, where nothing splices anything.
    const tag = await site.read.originScript();
    const page = Buffer.from(await site.read.html(), "utf8");
    const expected = Buffer.concat([bytes.subarray(0, seam), Buffer.from(tag, "utf8"), bytes.subarray(seam)]);
    assert.ok(page.equals(expected), "html() = file with the origin script at the seam");
    assert.ok(
      Buffer.concat([page.subarray(0, seam), page.subarray(seam + Buffer.byteLength(tag))]).equals(bytes),
      "removing the script gives back the stored file byte for byte",
    );

    // request() returns 200 + the same document + a text/html content type, for any path
    const [status, body, headers] = (await site.read.request([["index.html"], []])) as [bigint, string, any[]];
    assert.equal(Number(status), 200);
    assert.equal(body, page.toString("utf8"), "both routes serve one identical document");
    const ct = headers.find((h) => h.key.toLowerCase() === "content-type");
    assert.ok(ct && ct.value.includes("text/html"), "serves text/html");

    // each chunk's bytecode really is 0x00 ++ chunkBytes (verifiable on-chain)
    const first = await site.read.chunkAt([0n]);
    const code = await pub.getCode({ address: first });
    assert.ok(code && code.startsWith("0x00"), "chunk bytecode starts with the STOP byte");
  });

  // ERC-8244 has no ERC-165 flag and no registry entry: a client discovers support by calling
  // html() and seeing whether bytes come back. The selector IS the interface, so renaming or
  // re-typing this function would silently stop every 8244 client from finding the app, with
  // nothing failing loudly anywhere. Hence pinning it.
  it("answers the ERC-8244 discovery selector 0x33c34ac3 with the page", async () => {
    const { viem } = await network.create();
    const [deployer] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();

    const content = "<!doctype html><html><head>" + "</head><body>rock</body></html>";
    const seam = content.indexOf("<head>") + "<head>".length;
    const pointers: `0x${string}`[] = [];
    for (const piece of [content.slice(0, seam), content.slice(seam)]) {
      const hash = await deployer.sendTransaction({
        data: sstore2InitCode("0x" + Buffer.from(piece, "utf8").toString("hex")),
      });
      pointers.push((await pub.waitForTransactionReceipt({ hash })).contractAddress!);
    }
    const site = await viem.deployContract("EthereumRockSite", [pointers]);

    // exactly what an 8244 client sends: a raw eth_call of the bare selector, nothing else
    assert.equal(toFunctionSelector("function html() view returns (string)"), "0x33c34ac3");
    const returned = await pub.call({ to: site.address, data: "0x33c34ac3" });
    const doc = decodeAbiParameters([{ type: "string" }], returned.data!)[0] as string;

    // and it must be a plain view call: no state, no value, no revert
    const abi = (site as any).abi.find((f: any) => f.name === "html");
    assert.equal(abi.stateMutability, "view", "ERC-8244 requires html() to be a view function");

    // "Documents MUST identify their origin contract." Taken from address(this) at read time, so it
    // cannot be stale or wrong, and it lands inside <head> rather than before the doctype.
    assert.ok(doc.toLowerCase().includes(site.address.toLowerCase()), "the document names its own contract");
    const at = doc.indexOf("window.ERC8244_ORIGIN");
    assert.ok(at > doc.indexOf("<head>") && at < doc.indexOf("</head>"), "the origin script sits inside <head>");

    // the chain id goes in too: identical addresses on other chains hold different code, and the
    // spec's security section expects a client to be able to check that before transacting
    const chainId = await pub.getChainId();
    assert.match(doc, new RegExp("chainId:" + chainId + "\\}"));
  });
});
