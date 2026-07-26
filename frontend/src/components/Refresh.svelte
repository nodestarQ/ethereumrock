<script>
  // "Show me the book as it is now", by hand or on a timer. The app never polls on its own and
  // reloading the browser drops the wallet connection, so without this the only way to see a sale
  // or a new bid land is to reconnect. Read-only, so it stays a white button by the same rule as
  // Load history and Load my rocks.
  //
  // On a local chain a refresh finishes faster than the eye catches, and an unchanged page looks
  // like a dead button, so a completed run says "Updated" for a moment. Failures are not shown
  // here: every caller already reports its own load errors in place.
  //
  // `run` is the button. `autoRun` is what a background tick does, and defaults to the same thing.
  // Pages whose manual refresh includes an opt-in log read (the account holdings scan, the price
  // history walk) pass a cheaper `autoRun` that leaves those alone: a timer must never quietly turn
  // into a log scan every 15 seconds.
  import Info from "./Info.svelte";
  import { poll } from "../lib/poll.svelte.js";
  import { raw } from "../lib/rpc.js";
  import { wallet } from "../lib/wallet.svelte.js";
  import { config } from "../config.js";

  let { run, autoRun = run, label = "Refresh" } = $props();

  let busy = $state(false);
  let done = $state(false);
  let timer;

  function flash() {
    done = true;
    clearTimeout(timer);
    timer = setTimeout(() => (done = false), 2000);
  }

  async function click() {
    busy = true;
    done = false;
    try {
      await run();
      flash();
    } finally {
      busy = false;
    }
  }

  const TOOLTIP =
    "Updates this page every " + poll.seconds + " seconds, so new bids and sales show up without " +
    "you reloading.";

  // The timer. Restarts whenever the toggle changes; the returned teardown stops it on navigation,
  // so leaving a page can never leave a poller behind.
  $effect(() => {
    if (!poll.on) return;

    let alive = true;
    let handle;
    let fails = 0;
    let lastBlock = null;

    async function tick() {
      if (!alive) return;
      let wait = poll.seconds * 1000;
      try {
        // Nothing to read from, and nothing to poll: reads go through the wallet unless the
        // operator set an endpoint of their own.
        const readable = wallet.current || config.rpcUrl;
        // A hidden tab is a tab nobody is looking at. Skipping keeps a forgotten window from
        // spending someone's rate limit all afternoon.
        if (readable && document.visibilityState === "visible" && !busy) {
          const block = await raw("eth_blockNumber", []);
          if (block !== lastBlock) {
            lastBlock = block;
            await autoRun();
            flash();
          }
        }
        fails = 0;
      } catch {
        // Almost always a rate limit or a dead endpoint. Back off hard rather than making it worse,
        // and recover on the first success.
        fails += 1;
        wait = Math.min(wait * 2 ** fails, 120000);
      }
      if (alive) handle = setTimeout(tick, wait);
    }

    handle = setTimeout(tick, poll.seconds * 1000);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  });
</script>

<span class="refresh">
  <label class="check">
    <input type="checkbox" bind:checked={poll.on} />
    Auto-refresh
  </label>
  <!-- this control sits at the right edge of the header, so the bubble has to open leftward or it
       widens the page even while it is hidden -->
  <Info text={TOOLTIP} label="What auto-refresh does" align="right" />
  <span class="said" role="status">{done ? "Updated" : ""}</span>
  <button type="button" onclick={click} disabled={busy}>{busy ? "Refreshing…" : label}</button>
</span>

<style>
  .refresh { display: inline-flex; align-items: center; gap: 0.5rem; }
  .check { display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; color: var(--ink-2); font-size: 0.85rem; }
  .check input { cursor: pointer; }
  .said {
    font-size: 0.78rem;
    color: var(--ink-2);
    /* holds its own width so the button never shifts when the word appears */
    min-width: 4.2rem;
    text-align: right;
  }
  /* On a phone that reserved gap is 4.2rem of nothing between the checkbox and the button, in a
     header that is already wrapping. A shift when "Updated" appears is the cheaper of the two. */
  @media (max-width: 560px) {
    .refresh { flex: 1 1 auto; justify-content: flex-end; }
    .said { min-width: 0; }
  }
</style>
