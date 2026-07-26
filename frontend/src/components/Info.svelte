<script>
  // A small "i" affordance: shows an explanatory bubble on hover (desktop) and on focus (keyboard
  // and touch, since a tap focuses the button).
  //
  // The bubble hangs off the icon, `align` says from which corner, and then it is CLAMPED into the
  // viewport. The clamp is not decoration: this control appears in a header that wraps at some
  // widths, so the same icon can sit at the right edge of a wide window and 158px from the left of a
  // narrow one. Fixed breakpoints guessed that wrongly twice.
  //
  // Two things make the clamp safe:
  //   - a bubble is laid out even while hidden, because `visibility: hidden` still occupies space
  //     and still counts toward the document's scrollable width, so it is measured and corrected
  //     before anyone hovers it, not on the way in;
  //   - `align="right"` anchors it to the icon's right edge, so its natural position is already
  //     inside the page and the clamp only ever nudges it back from the left. It can never push the
  //     bubble out past the right edge and widen the document.
  let { text, label = "More information", align = "left" } = $props();

  let bubble;
  let shift = $state(0);

  function place() {
    if (!bubble) return;
    const r = bubble.getBoundingClientRect();
    // rects include the current shift, so unwind it to measure the natural position
    const left = r.left - shift;
    const right = r.right - shift;
    // clientWidth, not innerWidth: innerWidth counts the scrollbar, and clamping to it leaves the
    // bubble hanging exactly one scrollbar past the edge, which is enough to widen the document
    const vw = document.documentElement.clientWidth;
    const pad = 8;
    let dx = 0;
    if (left < pad) dx = Math.round(pad - left);
    else if (right > vw - pad) dx = Math.round(vw - pad - right);
    if (dx !== shift) shift = dx;
  }

  $effect(() => {
    text;
    align;
    place();
    addEventListener("resize", place);
    // The icon moves without the window changing size: these headers wrap once the page has loaded
    // its data, which is exactly when a hidden bubble would quietly end up in the wrong place.
    const ro = new ResizeObserver(place);
    ro.observe(document.body);
    return () => {
      removeEventListener("resize", place);
      ro.disconnect();
    };
  });
</script>

<!-- re-measured as it opens too: the row above it may have wrapped since the last layout -->
<span class="info" onpointerenter={place} onfocusin={place}>
  <button type="button" class="mark" aria-label={label}>i</button>
  <span
    class="bubble"
    class:right={align === "right"}
    style={shift ? `translate: ${shift}px` : ""}
    role="tooltip"
    bind:this={bubble}
  >{text}</span>
</span>

<style>
  .info { position: relative; display: inline-flex; vertical-align: middle; }
  .mark {
    width: 1.2rem;
    height: 1.2rem;
    padding: 0;
    line-height: 1;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 700;
    font-style: italic;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    color: var(--ink-2);
    border: 1px solid var(--line-2);
  }
  .mark:hover { color: var(--accent); border-color: var(--accent); background: var(--surface-2); }
  .bubble {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    z-index: 40;
    width: max-content;
    /* never wider than the window, so the clamp always has somewhere to put it */
    max-width: min(78vw, 22rem);
    background: var(--ink);
    color: var(--bg);
    font-family: var(--font-sans);
    font-weight: 400;
    font-size: 0.78rem;
    font-style: normal;
    line-height: 1.45;
    text-transform: none;
    letter-spacing: normal;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--ink);
    box-shadow: var(--shadow);
    visibility: hidden;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .bubble.right { left: auto; right: 0; }
  /* On a phone every bubble anchors to the icon's right edge, whatever `align` says. A left-anchored
     bubble is up to 78vw wide, so its natural position hangs off the page and the document is briefly
     wider than the screen before the clamp pulls it back. Right-anchored, it starts inside the page
     and the clamp only ever has to nudge it in from the left. */
  @media (max-width: 560px) {
    .bubble { left: auto; right: 0; }
  }
  .info:hover .bubble,
  .info:focus-within .bubble { visibility: visible; opacity: 1; }
</style>
