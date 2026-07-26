// Injected-wallet connection, EIP-6963 only. No WalletConnect, no Coinbase SDK, no smart-wallet
// machinery: the app talks to whatever browser wallet the user already has. Every RPC call is
// proxied through the connected provider (see rpc.js), so the app ships no endpoint of its own.
//
// Reactive (Svelte 5 runes), so a `{#if wallet.account}` in any component tracks connection state.

class Wallet {
  providers = $state([]); // [{ info: {uuid,name,icon}, provider }] announced via EIP-6963
  current = $state(null); // the connected EIP-1193 provider
  account = $state(null);
  chainId = $state(null);

  // Start listening for wallet announcements. EIP-6963 wallets answer asynchronously, so the list
  // fills in after this returns; window.ethereum is a fallback if nothing announces.
  discover() {
    if (typeof window === "undefined") return;
    addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail;
      if (!this.providers.some((p) => p.info.uuid === d.info.uuid)) {
        this.providers = [...this.providers, d];
      }
    });
    dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      if (!this.providers.length && globalThis.ethereum) {
        this.providers = [{ info: { uuid: "injected", name: "Injected wallet" }, provider: globalThis.ethereum }];
      }
    }, 400);
  }

  async connect(uuid) {
    const pick = (uuid && this.providers.find((p) => p.info.uuid === uuid)) || this.providers[0];
    if (!pick) throw new Error("no injected wallet found");
    const p = pick.provider;
    const accts = await p.request({ method: "eth_requestAccounts" });
    this.current = p;
    this.account = accts[0] || null;
    this.chainId = Number(BigInt(await p.request({ method: "eth_chainId" })));
    p.on && p.on("accountsChanged", (a) => { this.account = a[0] || null; });
    p.on && p.on("chainChanged", (c) => { this.chainId = Number(BigInt(c)); });
  }

  // EIP-3326: ask the wallet to move to the chain this deployment is bound to. A wallet that has
  // never heard of the chain answers 4902, and EIP-3085 can add it, but only if we can name an
  // endpoint for it. On mainnet `config.rpcUrl` is deliberately empty and chain 1 is one every
  // wallet already knows, so the add path is really a local-chain convenience. MetaMask sometimes
  // buries the code one level down, hence the second lookup.
  async switchChain(chainId, { rpcUrl = "", chainName = "" } = {}) {
    const p = this.current;
    if (!p) throw new Error("connect a wallet first");
    const hex = "0x" + Number(chainId).toString(16);
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      if (code !== 4902) throw e;
      if (!rpcUrl) throw new Error("your wallet doesn't know chain " + chainId + ". Add it manually, then try again.");
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: chainName || "Chain " + chainId,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [rpcUrl],
        }],
      });
      // most wallets switch as part of adding, but not all of them do
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    }
    // chainChanged normally covers this; re-reading means the bar clears even if it never fires
    this.chainId = Number(BigInt(await p.request({ method: "eth_chainId" })));
  }

  disconnect() {
    this.current = null;
    this.account = null;
    this.chainId = null;
  }
}

export const wallet = new Wallet();
