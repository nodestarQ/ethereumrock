<script>
  import { wallet } from "../lib/wallet.svelte.js";
  import { config } from "../config.js";
  import { short, errText } from "../lib/format.js";
  import { resolveName } from "../lib/contracts.js";
  import { router } from "../lib/router.svelte.js";

  let selected = $state("");

  // EIP-6963 wallets answer after first paint, so the picker starts with nothing to select. Default
  // it to whichever wallet announced first (and re-default if that one disappears) so the select is
  // never blank. A user's own pick survives later announcements, since it stays in the list.
  $effect(() => {
    const list = wallet.providers;
    if (list.length && !list.some((p) => p.info.uuid === selected)) selected = list[0].info.uuid;
  });

  // The connected address' Gwei name, when it has one. Best-effort and purely cosmetic: no GNS on
  // this chain or no name set leaves it null and the chip shows the truncated address instead.
  let gname = $state(null);

  $effect(() => {
    const a = wallet.account;
    gname = null;
    if (!a) return;
    let alive = true;
    resolveName(a)
      .then((n) => { if (alive) gname = n; })
      .catch(() => {});
    return () => { alive = false; };
  });

  // A rejected connect is the wallet's own business, but "no injected wallet found" is ours, so it
  // gets a line under the bar rather than disappearing with the toasts.
  let connectError = $state(null);
  async function connect() {
    connectError = null;
    try {
      await wallet.connect(selected);
    } catch (e) {
      connectError = errText(e);
    }
  }

  // The wrong-network bar used to just tell you to go and fix it yourself. Wallets expose this
  // (EIP-3326), so the bar does it. A rejected switch is the user's call and reports in place.
  let switching = $state(false);
  let switchError = $state(null);
  async function doSwitch() {
    switchError = null;
    switching = true;
    try {
      await wallet.switchChain(config.chainId, {
        rpcUrl: config.rpcUrl,
        chainName: config.chainId === 31337 ? "Hardhat (31337)" : "Chain " + config.chainId,
      });
    } catch (e) {
      switchError = errText(e);
    }
    switching = false;
  }

  // No Account tab: the page is useless without a wallet, and once you have one the address chip
  // to the right IS the link to it. So the tabs stay the parts of the app anyone can browse.
  const links = [
    { href: "#/", path: "/", label: "Home" },
    { href: "#/market", path: "/market", label: "Market" },
    { href: "#/wrap", path: "/wrap", label: "Wrap" },
  ];
  const isActive = (p) => (p === "/" ? router.path === "/" : router.path.startsWith(p));
</script>

<header>
  <div class="bar">
    <a class="brand" href="#/" aria-label="EthereumRock home">
      <svg class="logo" viewBox="0 0 8 8" shape-rendering="crispEdges" width="27" height="27" aria-hidden="true">
        <path fill="#78746b" d="M3 1H4V2H5V3H6V7H3V6H2V3H3Z" />
        <path fill="#000" fill-opacity="0.902" d="M3 1H4V2H3ZM3 6H4V7H3Z" />
        <path fill="#fff" fill-opacity="0.251" d="M4 2H5V3H4Z" />
        <path fill="#000" fill-opacity="0.502" d="M2 3H3V5H2ZM5 6H6V7H5Z" />
        <path fill="#000" fill-opacity="0.251" d="M5 4H6V6H5Z" />
        <path fill="#000" fill-opacity="0.749" d="M2 5H3V6H2ZM4 6H5V7H4Z" />
      </svg>
    </a>

    <nav class="tabs">
      {#each links as l (l.path)}
        <a href={l.href} class:active={isActive(l.path)}>{l.label}</a>
      {/each}
    </nav>

    <div class="right">
      {#if wallet.account}
        <a
          class="chip"
          class:warn={wallet.chainId !== config.chainId}
          class:active={isActive("/account")}
          href="#/account"
          title={"Your account · " + wallet.account}
        >
          <span class="dot"></span><span class="who">{gname ?? short(wallet.account)}</span>
        </a>
        <button type="button" onclick={() => wallet.disconnect()}>Disconnect</button>
      {:else}
        <select bind:value={selected} aria-label="Choose wallet">
          {#each wallet.providers as p (p.info.uuid)}
            <option value={p.info.uuid}>{p.info.name}</option>
          {/each}
          {#if !wallet.providers.length}<option value="">no wallet</option>{/if}
        </select>
        <button type="button" class="primary" onclick={connect}>Connect</button>
      {/if}
    </div>
  </div>

  {#if wallet.account && wallet.chainId !== config.chainId}
    <div class="netbar">
      <span>Wrong network. This app is on chain {config.chainId}, your wallet is on {wallet.chainId ?? "another chain"}.</span>
      <button type="button" onclick={doSwitch} disabled={switching}>
        {switching ? "switching…" : "Switch network"}
      </button>
      {#if switchError}<span class="why">{switchError}</span>{/if}
    </div>
  {/if}
  {#if connectError && !wallet.account}
    <div class="netbar bad">{connectError}</div>
  {/if}
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  .bar {
    max-width: var(--wrap);
    margin: 0 auto;
    padding: 0.65rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.25rem;
  }
  .brand { display: inline-flex; align-items: center; line-height: 0; }
  .logo { display: block; transition: opacity 0.12s; }
  .brand:hover .logo { opacity: 0.75; }
  .tabs { display: flex; gap: 0.15rem; flex-wrap: wrap; }
  .tabs a {
    color: var(--ink-2);
    font-weight: 550;
    font-size: 0.9rem;
    padding: 0.3rem 0.72rem;
    border-radius: var(--radius);
  }
  .tabs a:hover { color: var(--ink); background: var(--surface-2); text-decoration: none; }
  .tabs a.active { color: var(--accent); background: var(--accent-wash); }
  .right { margin-left: auto; display: flex; align-items: center; gap: 0.6rem; }
  /* The chip is the door to the account page, so it is a button in everything but tag: the box,
     border, weight and press are copied from the global `button` rule, which is what Disconnect
     beside it uses. Only the address keeps the monospace face. Keep these in sync with app.css. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--font-mono);
    font-size: 0.9rem;
    font-weight: 550;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: var(--radius);
    padding: 0.45rem 0.85rem;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s, color 0.12s, transform 0.04s;
  }
  .chip:hover { color: var(--accent); border-color: var(--accent); text-decoration: none; }
  .chip:active { transform: translateY(1px); } /* the press; .active below is the current page */
  .chip.active { color: var(--accent); border-color: var(--accent); background: var(--accent-wash); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .who { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.warn .dot { background: #b23a2a; }
  .netbar {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.75rem;
    background: var(--accent);
    color: var(--on-accent);
    text-align: center;
    font-size: 0.82rem;
    padding: 0.35rem 1rem;
  }
  .netbar.bad { background: #b23a2a; }
  /* pale on indigo, so it reads as the action in the bar without a second accent colour */
  .netbar button {
    font-size: 0.78rem;
    padding: 0.15rem 0.6rem;
    background: transparent;
    color: var(--on-accent);
    border-color: var(--on-accent);
  }
  .netbar button:hover:not(:disabled) { background: var(--on-accent); color: var(--accent); border-color: var(--on-accent); }
  .netbar button:disabled { background: transparent; color: var(--on-accent); border-color: var(--on-accent); opacity: 0.7; }
  .netbar .why { width: 100%; opacity: 0.9; }
  @media (max-width: 620px) {
    .bar { flex-wrap: wrap; gap: 0.6rem 1rem; }
    .right { width: 100%; }
  }
  @media (max-width: 560px) {
    /* same side padding as `main`, so the logo lines up with the content under it */
    .bar { padding: 0.6rem 1.1rem; }
    .tabs a { padding: 0.3rem 0.6rem; }
    /* the wallet row: chip takes the space it needs, Disconnect stays whole beside it */
    .chip { flex: 1 1 auto; min-width: 0; }
    .who { max-width: none; }
    .right > button { flex: none; }
  }
</style>
