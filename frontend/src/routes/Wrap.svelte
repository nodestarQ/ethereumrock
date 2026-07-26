<script>
  import {
    createWarden, giftRockToWarden, wrap, wrapBatched, rescue, migrate, migrationSource, wardenOf, ownerOf,
    rawRockOwner,
  } from "../lib/contracts.js";
  import { atomicSupported } from "../lib/batch.js";
  import { config } from "../config.js";
  import { isZero, errText, filled, idIssue as numIssue } from "../lib/format.js";
  import { wallet } from "../lib/wallet.svelte.js";
  import RockArt from "../components/RockArt.svelte";

  let warden = $state(null);
  let oneClick = $state(false); // wallet can run gift+wrap as one atomic transaction (EIP-5792/7702)
  let done = $state(null); // { id, how } once the token is confirmed live on chain
  let stalled = $state(null); // recovery hint when the flow did not land
  let panelEl = $state(null);

  // form state
  let wrapId = $state("");
  let migId = $state("");
  // advanced / recovery
  let giftId = $state("");
  let wrapOnlyId = $state("");
  let rescueId = $state("");

  $effect(() => {
    wallet.account;
    if (wallet.account) {
      refresh();
      atomicSupported().then((v) => (oneClick = v));
    } else {
      oneClick = false;
    }
  });

  // bring the result into view; wrapping happens mid-page and the panel sits above it
  $effect(() => {
    if ((done || stalled) && panelEl) panelEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  async function refresh() {
    try { warden = await wardenOf(wallet.account); } catch (e) { /* not fatal */ }
  }
  // Failures show in the card that raised them; there is no toast layer to fall back on.
  const err = $state({});
  const busy = $state({}); // per-action pending flag, so a button can disable and say "…" while it runs
  async function run(key, fn) {
    if (busy[key]) return;
    err[key] = null;
    busy[key] = true;
    try { await fn(); await refresh(); } catch (e) { err[key] = errText(e); } finally { busy[key] = false; }
  }
  const B = (v) => BigInt(v);
  const hasWarden = $derived(warden && !isZero(warden));

  // A wrappable rock is a whole number 0-9999. Everything outside that fails for a specific reason,
  // so say which one here instead of letting the wallet surface a revert the user has to decode.
  const trimmed = (v) => String(v ?? "").trim();
  function idIssue(v) {
    const s = trimmed(v);
    if (!s) return null; // nothing typed yet is not an error
    if (!/^\d+$/.test(s)) return "Enter a whole rock id, 0 to 9999.";
    if (Number(s) >= 10000) {
      return `#${s} is a dust rock. Dust can't be wrapped, only absorbed into a rock you already own, from that rock's page.`;
    }
    return null;
  }
  // Same hazard as merge: BigInt("") is 0n, so a blank advanced field would mean rock #0.
  const giftIssue = $derived(numIssue(giftId, 0, Number.MAX_SAFE_INTEGER));
  const canGift = $derived(filled(giftId) && !giftIssue);
  const wrapOnlyIssue = $derived(numIssue(wrapOnlyId));
  const canWrapOnly = $derived(filled(wrapOnlyId) && !wrapOnlyIssue);
  const rescueIssue = $derived(numIssue(rescueId, 0, Number.MAX_SAFE_INTEGER));
  const canRescue = $derived(filled(rescueId) && !rescueIssue);

  const wrapIssue = $derived(idIssue(wrapId));
  const canWrap = $derived(!!trimmed(wrapId) && !wrapIssue);

  // Which old wrapper a rock lives in is a fact on chain, so it is looked up on submit rather than
  // asked for. Only on submit: scanning per keystroke would spend two eth_calls on every digit of
  // the number on the way to the one the user meant.
  const migIssue = $derived(idIssue(migId));
  const canMigrate = $derived(!!trimmed(migId) && !migIssue);
  let migError = $state(null); // set when a submitted id turned out to be in neither wrapper

  $effect(() => { migId; migError = null; }); // a stale "not found" clears as soon as the number changes

  // Confirm against chain state rather than assuming the sequence worked: on a wallet that cannot
  // batch this is several transactions, and any one of them can be rejected or run out of gas.
  async function settle(id, how) {
    const owner = await ownerOf(id).catch(() => null);
    if (owner && wallet.account && owner.toLowerCase() === wallet.account.toLowerCase()) {
      done = { id: Number(id), how };
      stalled = null;
      return true;
    }
    stalled = `Rock #${id} is not wrapped yet. If the raw rock already reached your warden, finish it with "Wrap only" under Advanced.`;
    done = null;
    return false;
  }

  // Gift the raw rock into your warden, then wrap it. One confirmation on a wallet that can batch
  // (EIP-5792/7702), otherwise a few. The warden is created first if you don't have one yet: its
  // deploy address can't be known ahead of time, so it can't be folded into the same batch.
  // Where a raw rock actually is, phrased as the next thing to do about it. Checked on submit
  // rather than while typing, so the field fires no RPC until you commit.
  async function wrapBlocker(idB) {
    const owner = (await rawRockOwner(idB)) || "";
    const is = (a) => a && owner.toLowerCase() === a.toLowerCase();
    if (is(wallet.account)) return null; // you hold it: nothing in the way
    if (isZero(owner)) return `Nobody holds raw rock #${idB} on the v1 contract, so there is nothing to wrap yet.`;
    if (is(config.rock)) return `Rock #${idB} is already wrapped here.`;
    if (is(warden)) return `Rock #${idB} is already sitting in your warden. Finish it with "Wrap only" under Advanced.`;
    if (is(config.wrapperSub100) || is(config.wrapper10k)) {
      return `You don't hold raw rock #${idB}: it is still wrapped in an old contract. Use "Migrate" below instead.`;
    }
    return `Raw rock #${idB} belongs to ${owner}, not you, so it cannot be wrapped from here.`;
  }

  async function giftAndWrap() {
    if (busy.wrap) return;
    const idB = B(wrapId);
    done = null;
    stalled = null;
    busy.wrap = true;
    try {
      err.wrap = null;
      // Without this the batch's first call (sellRock) reverts with a bare "not owner" and the
      // page repeats it verbatim, which says nothing about what to do next.
      const blocker = await wrapBlocker(idB);
      if (blocker) {
        err.wrap = blocker;
        return;
      }
      if (!hasWarden) await createWarden();
      await wrapBatched(idB);
      if (await settle(idB, "wrapped")) wrapId = "";
    } catch (e) {
      err.wrap = errText(e);
    } finally {
      busy.wrap = false;
    }
    await refresh();
  }

  async function doMigrate() {
    if (busy.migrate) return;
    const s = trimmed(migId);
    const idB = B(s);
    done = null;
    stalled = null;
    migError = null;
    err.migrate = null;
    busy.migrate = true;
    try {
      const source = await migrationSource(idB, wallet.account);
      if (source) {
        await migrate(source, idB);
        if (await settle(idB, "migrated")) migId = "";
      } else {
        migError = `You don't hold #${s} in either old wrapper. If you hold the raw 2017 rock, use "Wrap a raw rock" above.`;
      }
    } catch (e) {
      err.migrate = errText(e);
    } finally {
      busy.migrate = false;
    }
    await refresh();
  }

  async function doWrapOnly() {
    if (busy.wrapOnly) return;
    const idB = B(wrapOnlyId);
    done = null;
    stalled = null;
    busy.wrapOnly = true;
    try {
      err.wrapOnly = null;
      await wrap(idB);
      if (await settle(idB, "wrapped")) wrapOnlyId = "";
    } catch (e) {
      err.wrapOnly = errText(e);
    } finally {
      busy.wrapOnly = false;
    }
    await refresh();
  }
</script>

<h1>Wrap</h1>

{#if !wallet.account}
  <p>Connect a wallet to wrap a rock or migrate one from an old wrapper.</p>
{:else}
  {#if done}
    <div class="done" bind:this={panelEl}>
      <a class="thumb" href={"#/rock/" + done.id}><RockArt id={done.id} size={92} /></a>
      <div class="txt">
        <p><strong>Rock #{done.id} is {done.how}.</strong></p>
        <p class="muted">It is a live token now: you can list it, accept bids on it, or merge it.</p>
        <div class="actions">
          <a class="cta" href={"#/rock/" + done.id}>View rock #{done.id} →</a>
          <button type="button" onclick={() => (done = null)}>Wrap another</button>
        </div>
      </div>
    </div>
  {:else if stalled}
    <div class="stalled" bind:this={panelEl}>
      <p><strong>Not finished.</strong></p>
      <p class="muted">{stalled}</p>
      <p><button type="button" onclick={() => (stalled = null)}>Dismiss</button></p>
    </div>
  {/if}

  <h2>1. Your warden</h2>
  <div class="action-card">
    <p class="note">
      Think of it as a safe, which rocks pass through on the way to being wrapped. You only need to create it
      once.
    </p>
    <div class="row">
      <!-- in full: this is the address your raw rock has to be gifted to, so it gets copied out -->
      <div class="fields">Warden: <span class="mono addr">{hasWarden ? warden : "none yet"}</span></div>
      {#if !hasWarden}
        <div class="actions">
          <button type="button" class="primary" onclick={() => run("warden", createWarden)} disabled={busy.warden}>{busy.warden ? "creating…" : "Create my warden"}</button>
        </div>
      {/if}
    </div>
    {#if err.warden}<p class="failed">{err.warden}</p>{/if}
  </div>

  <h2>2. Wrap a raw rock</h2>
  <div class="action-card">
    <p class="note">
      Turns a 2017 rock you own into a token. Type its id, 0 to 9999.
    </p>
    <div class="row">
      <div class="fields">
        <label>Wrap rock #<input type="number" min="0" max="9999" bind:value={wrapId} size="6" /></label>
      </div>
      <div class="actions">
        <button type="button" class="primary" onclick={giftAndWrap} disabled={!canWrap || busy.wrap}>{busy.wrap ? "wrapping…" : "Gift & wrap"}</button>
      </div>
    </div>
    {#if wrapIssue}<p class="note bad">{wrapIssue}</p>{/if}
    {#if err.wrap}<p class="failed">{err.wrap}</p>{/if}
  </div>

  <h2>Or migrate from an old wrapper</h2>
  <div class="action-card">
    <p class="note">
      Moves a rock from an old GenesisRocks wrapper into this one.
    </p>
    <div class="row">
      <div class="fields">
        <label>Migrate rock #<input type="number" min="0" max="9999" bind:value={migId} size="6" /></label>
      </div>
      <div class="actions">
        <button type="button" class="primary" onclick={doMigrate} disabled={!canMigrate || busy.migrate}>{busy.migrate ? "migrating…" : "Migrate"}</button>
      </div>
    </div>
    {#if migIssue || migError}<p class="note bad">{migIssue ?? migError}</p>{/if}
    {#if err.migrate}<p class="failed">{err.migrate}</p>{/if}
  </div>

  <details>
    <summary>Advanced / recovery</summary>
    <p><small>Individual steps, for when a combined action stopped halfway or a rock is stuck in your warden.</small></p>
    <div class="action-card">
      <p class="note">
        Sends a raw 2017 rock you own into your warden without wrapping it. Use this if a wrap stopped
        after the price step.
      </p>
      <div class="row">
        <div class="fields">
          <label>Gift raw rock #<input type="number" min="0" bind:value={giftId} size="6" /></label> into warden
        </div>
        <div class="actions">
          <button type="button" onclick={() => run("gift", () => giftRockToWarden(B(giftId)))} disabled={!canGift || busy.gift}>{busy.gift ? "gifting…" : "giftRock"}</button>
        </div>
      </div>
      {#if giftIssue}<p class="note bad">{giftIssue}</p>{/if}
      {#if err.gift}<p class="failed">{err.gift}</p>{/if}
    </div>
    <div class="action-card">
      <p class="note">
        Makes the token for a rock that already reached your warden. Use this if a wrap stopped after
        the rock was sent.
      </p>
      <div class="row">
        <div class="fields">
          <label>Wrap a rock already in your warden #<input type="number" min="0" max="9999" bind:value={wrapOnlyId} size="6" /></label>
        </div>
        <div class="actions">
          <button type="button" onclick={doWrapOnly} disabled={!canWrapOnly || busy.wrapOnly}>{busy.wrapOnly ? "wrapping…" : "Wrap only"}</button>
        </div>
      </div>
      {#if wrapOnlyIssue}<p class="note bad">{wrapOnlyIssue}</p>{/if}
      {#if err.wrapOnly}<p class="failed">{err.wrapOnly}</p>{/if}
    </div>
    <div class="action-card">
      <p class="note">
        Sends a rock back out of your warden to your own address, if one ended up stuck there
        unwrapped.
      </p>
      <div class="row">
        <div class="fields">
          <label>Rescue a rock stuck in your warden #<input type="number" min="0" bind:value={rescueId} size="6" /></label>
        </div>
        <div class="actions">
          <button type="button" onclick={() => run("rescue", () => rescue(B(rescueId)))} disabled={!canRescue || busy.rescue}>{busy.rescue ? "rescuing…" : "Rescue"}</button>
        </div>
      </div>
      {#if rescueIssue}<p class="note bad">{rescueIssue}</p>{/if}
      {#if err.rescue}<p class="failed">{err.rescue}</p>{/if}
    </div>
  </details>
{/if}

<style>
  /* a full address is 42 characters and this sits in a flex row, which would let it push the card
     wide on a phone instead of wrapping */
  .addr { overflow-wrap: anywhere; min-width: 0; }
  /* small enough that the whole warden address lands on one line from ~360px up */
  @media (max-width: 560px) {
    .addr { font-size: 0.8em; }
  }
  .done {
    display: flex;
    gap: 1.1rem;
    align-items: center;
    border: 1px solid var(--accent);
    background: var(--accent-wash);
    padding: 1rem 1.15rem;
    margin-bottom: 1.9rem;
    flex-wrap: wrap;
  }
  .done .thumb { display: block; line-height: 0; }
  .done .txt p { margin: 0 0 0.3rem; }
  /* the result panel is not an action card, so it carries its own button row */
  .done .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-top: 0.7rem; }
  .cta {
    display: inline-block;
    padding: 0.45rem 1rem;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 550;
    font-size: 0.9rem;
  }
  .cta:hover { background: var(--accent-2); border-color: var(--accent-2); color: var(--on-accent); text-decoration: none; }

  .stalled {
    border: 1px solid var(--line-2);
    background: var(--surface);
    padding: 0.9rem 1.15rem;
    margin-bottom: 1.9rem;
  }
  .stalled p { margin: 0 0 0.4rem; }
  .stalled p:last-child { margin-bottom: 0; margin-top: 0.7rem; }
</style>
