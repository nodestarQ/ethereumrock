// Fetch a grid's art for the tiles you can see, in batches.
//
// loading="lazy" does nothing here: the art is a data: URI from an eth_call, so the cost is a round
// trip, not a fetch the browser could defer. The CALL is what becomes lazy. Each tile watches itself
// with an IntersectionObserver, and ids that come into view are batched into one request.
//
// MARGIN fetches ahead of the viewport so scrolling meets art rather than a placeholder.
// SETTLE batches the burst of intersections a flick-scroll fires in one frame.
// artOf then chunks whatever it gets at 12, its own gas budget.
import { artOf } from "./contracts.js";

const MARGIN = "400px 0px"; // start roughly a screen-and-a-half early on a phone
const SETTLE = 50;

// Art already fetched this session. Needed because the filter tabs destroy every tile that leaves
// the list, so All -> For sale -> All would re-fetch what the page already had. Sorting never needed
// it: the same tiles are reordered, not rebuilt.
//
// Bounded at 200 because a data: URI is ~1.5KB and a saturated collection would hold ten thousand.
// Oldest out first. Stale art is the accepted trade, as it was before: a merge rewrites the
// survivor's seed, so a thumbnail can be one merge old until clearArtCache runs, which the pages
// call on an explicit refresh.
const CACHE_MAX = 200;
const cache = new Map(); // id -> image, or null for an id the chain has no live token for

function remember(id, image) {
  cache.set(id, image);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function clearArtCache() {
  cache.clear();
}

let observer = null;
const watchers = new Map(); // element -> { id, deliver }
const queued = new Map(); // id -> Set<deliver>
let timer = null;

function flush() {
  timer = null;
  if (!queued.size) return;
  const ids = [...queued.keys()];
  const waiting = ids.map((id) => queued.get(id));
  queued.clear();
  artOf(ids)
    .then((map) => {
      ids.forEach((id, i) => {
        const image = map[id] ?? null; // null here means the batch answered and this id has no token
        remember(id, image);
        waiting[i].forEach((d) => d(image));
      });
    })
    // A failed batch hands every waiter null WITHOUT remembering it, so RockArt falls back to
    // fetching its own and a later attempt is free to succeed. That is what keeps this working
    // against a deployment with no tokenURIBatch, and stops one bad call poisoning an id for good.
    .catch(() => ids.forEach((_, i) => waiting[i].forEach((d) => d(null))));
}

function want(id, deliver) {
  const set = queued.get(id) ?? new Set();
  set.add(deliver);
  queued.set(id, set);
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE);
}

function ensureObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const w = watchers.get(e.target);
        if (!w) continue;
        observer.unobserve(e.target); // asked for once; the answer is kept by the component
        watchers.delete(e.target);
        want(w.id, w.deliver);
      }
    },
    { rootMargin: MARGIN },
  );
  return observer;
}

/**
 * Ask for `id`'s art when `el` is near the viewport. `deliver` is called once, with the image or
 * with null if it could not be batched. Returns a teardown for the caller's effect.
 */
export function watchArt(el, id, deliver) {
  if (cache.has(id)) {
    deliver(cache.get(id)); // already fetched this session: no observer, no call
    return () => {};
  }
  if (typeof IntersectionObserver === "undefined") {
    // No observer (an old browser, a non-DOM environment): ask immediately. Still batched.
    want(id, deliver);
    return () => {};
  }
  const io = ensureObserver();
  watchers.set(el, { id, deliver });
  io.observe(el);
  return () => {
    watchers.delete(el);
    io.unobserve(el);
  };
}
