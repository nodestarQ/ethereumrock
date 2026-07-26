<script>
  // Renders an address, preferring its Gwei Name Service name when it has one, and showing "you" when
  // it is the connected wallet's own address so a row that refers to the reader says so plainly
  // instead of making them recognise their own address or name. `stacked` keeps the full address on a
  // second line (used where there is room, e.g. the Owner trait). The complete address is always in
  // the title, so nothing is hidden. Pass `you={false}` where the literal identity is wanted
  // regardless of who is connected.
  import { resolveName } from "../lib/contracts.js";
  import { wallet } from "../lib/wallet.svelte.js";

  let { address, stacked = false, you = true } = $props();

  let name = $state(null);

  // Reactive to account switches: connect or change accounts and every "you" on the page follows.
  const self = $derived(
    you && !!address && !!wallet.account && address.toLowerCase() === wallet.account.toLowerCase(),
  );

  $effect(() => {
    let alive = true;
    name = null;
    const a = address;
    if (a) {
      resolveName(a)
        .then((n) => { if (alive) name = n; })
        .catch(() => {});
    }
    return () => { alive = false; };
  });
</script>

{#if self}
  <span class="named you" title={name ?? address}>
    <span class="nm">you</span>
    {#if stacked}<span class="raw">{address}</span>{/if}
  </span>
{:else if name}
  <span class="named" title={address}>
    <span class="nm">{name}</span>
    {#if stacked}<span class="raw">{address}</span>{/if}
  </span>
{:else}
  <span class="raw only" title={address}>{address}</span>
{/if}

<style>
  .named { display: inline-flex; flex-direction: column; gap: 0.1rem; vertical-align: top; }
  .nm { font-family: var(--font-mono); }
  /* "you" is not an address or a name, so it drops the mono and picks up the accent to read as a
     label about the reader rather than another identity string. */
  .you .nm { font-family: inherit; font-style: italic; color: var(--accent); }
  .raw { font-family: var(--font-mono); font-size: 0.82em; color: var(--ink-3); overflow-wrap: anywhere; }
  .raw.only { color: inherit; font-size: inherit; }
</style>
