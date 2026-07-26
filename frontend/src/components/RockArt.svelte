<script>
  import { tokenURIof } from "../lib/contracts.js";
  import { watchArt } from "../lib/artQueue.js";

  // `src` lets a caller that already holds the token's metadata hand the image straight over: the
  // rock page passes it from the metadata it has already read, which also keeps that page correct
  // after a merge rewrites the survivor's seed.
  //
  // Without `src` the tile fetches its own, and WHEN it does is the point. It waits until it is near
  // the viewport, and asks through a shared queue that batches everything arriving at the same
  // moment into one call. A market page therefore costs one request for the handful of tiles you
  // can see rather than four for all forty-eight, which on a phone is most of the page's work.
  let { id, size = 128, fluid = false, src = null } = $props();

  let node = $state(null); // the element the observer watches

  let img = $state(null);
  let note = $state("loading…");

  // The effect re-runs whenever the PROP OBJECT a parent passes is replaced, even when `id` comes
  // out the same number: the dependency is the parent's row, not the value read out of it. A market
  // refresh rebuilds every row, so without this guard each refresh refetched the art for every card
  // on screen, which is 48 extra calls a tick on a full page and lands on whatever RPC the user's
  // wallet happens to use. Fetch once per id instead.
  //
  // The cost: art can change while an id does not, since a merge rewrites the survivor's seed. That
  // is what `src` is for, and the detail page passes it from the metadata it already read, so the
  // page where it matters stays correct. A grid thumbnail can be one merge behind until you open it.
  let loadedKey = null;

  $effect(() => {
    const key = src ?? "#" + id;
    if (key === loadedKey) return;
    if (src) {
      loadedKey = key;
      img = src;
      return;
    }
    if (!node) return; // wait for the placeholder to exist, so there is something to observe
    loadedKey = key;
    let alive = true;
    img = null;
    note = "loading…";
    // Queue this tile. `deliver` fires once, with the image or with null when the batch could not
    // answer (an older deployment with no tokenURIBatch), and null falls through to a single read
    // for this one rock, which is what keeps the grid working either way.
    const stop = watchArt(node, id, (image) => {
      if (!alive) return;
      if (image) {
        img = image;
        return;
      }
      tokenURIof(BigInt(id))
        .then((uri) => {
          if (!alive) return;
          img = JSON.parse(atob(uri.slice(uri.indexOf(",") + 1))).image;
        })
        .catch(() => {
          if (alive) note = "no art";
        });
    });
    // Both halves matter: stop() unobserves a tile that never came into view, and `alive` swallows a
    // batch that resolves after this tile is gone, which is the normal case when a filter changes
    // while a request is in flight.
    return () => {
      alive = false;
      stop();
    };
  });

  const box = $derived(fluid ? "width:100%;aspect-ratio:1" : `width:${size}px;height:${size}px`);
</script>

{#if img}
  <img class="art" src={img} alt={"Rock #" + id} style={box} />
{:else}
  <!-- the placeholder is what the observer watches, so a tile has to occupy its space before its
       art arrives. `box` gives it the same size the image will take, which also stops the grid
       reflowing as tiles fill in. -->
  <span bind:this={node} class="art art--empty" style={box}>{note}</span>
{/if}

<style>
  .art {
    display: block;
    image-rendering: pixelated;
    background: var(--surface-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
  }
  .art--empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-3);
    font-size: 0.72rem;
    text-align: center;
  }
</style>
