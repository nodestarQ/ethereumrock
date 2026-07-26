<script>
  // The hero band that sits between the title and the story: a row of rocks standing on one
  // baseline, drawn in the same art the tokens and the favicon use. One SVG rather than a row of
  // separate images, so it holds its shape at every width and scales as a single picture instead of
  // reflowing. Decorative, and it reads nothing from the chain, so it renders with no wallet
  // connected. For a real rock's art use RockArt, which fetches the token's own picture.
  //
  // The six paths are byte-identical to EthereumRockRenderer's BASE_PATH and DETAIL, and to the two
  // files in artBuildingBlocks/ that both were cut from. If the art ever changes it has to change in
  // every one of those places.
  //
  // Colours come from the contract's own palette, in as close to its own proportion as six rocks
  // allow (see EthereumRockRenderer._color): four "stone", a warm hue 18-57 at saturation 0-44 and
  // lightness 32-81, to two "mineral", any hue at saturation 55-84 and lightness 46-61, against that
  // function's 70/30 split. The scales sit in both bands of _sizePct: 1 for the first hundred,
  // 0.67-0.90 above it. So the band is a fair sample of the collection rather than a prettier
  // version of it. None of these is a specific rock, which is why none is labelled or linked.
  //
  // Six and not more: the band is as wide as the prose, so every rock added takes width off all of
  // them, and seven were already thin enough on a phone to lose the pixels they are made of.
  //
  // `x` is where a rock's centre goes and every rock is scaled about the middle of its own base, so
  // they all stand on the same line and a small one looks short rather than floating. That differs
  // from the contract, which scales about the centre of a square picture, but only in framing: the
  // paths are what has to match, and they do.
  const BASELINE = 6.8; // 0.8 under the feet and 0.8 over the tallest rock, in a box 7.6 high
  const ROCKS = [
    { x: 3.5, scale: 0.88, h: 26, s: 10, l: 38 }, // stone, dark warm grey
    { x: 8.7, scale: 1.0, h: 190, s: 74, l: 52 }, // mineral, cyan
    { x: 13.9, scale: 0.74, h: 30, s: 34, l: 58 }, // stone, tan
    { x: 19.1, scale: 0.94, h: 46, s: 24, l: 76 }, // stone, sand
    { x: 24.3, scale: 0.67, h: 20, s: 22, l: 46 }, // stone, brown
    { x: 29.5, scale: 0.9, h: 348, s: 62, l: 56 }, // mineral, rose
  ];
</script>

<svg class="banner" viewBox="0 0 33 7.6" shape-rendering="crispEdges" aria-hidden="true">
  {#each ROCKS as r}
    <g transform="translate({r.x} {BASELINE}) scale({r.scale}) translate(-4 -7)">
      <path fill="hsl({r.h},{r.s}%,{r.l}%)" d="M3 1H4V2H5V3H6V7H3V6H2V3H3Z" />
      <path fill="#000" fill-opacity="0.90" d="M3 1H4V2H3ZM3 6H4V7H3Z" />
      <path fill="#fff" fill-opacity="0.25" d="M4 2H5V3H4Z" />
      <path fill="#000" fill-opacity="0.50" d="M2 3H3V5H2ZM5 6H6V7H5Z" />
      <path fill="#000" fill-opacity="0.25" d="M5 4H6V6H5Z" />
      <path fill="#000" fill-opacity="0.75" d="M2 5H3V6H2ZM4 6H5V7H4Z" />
    </g>
  {/each}
</svg>

<style>
  .banner {
    display: block;
    width: 100%;
    height: auto; /* the viewBox sets the ratio, so the band never needs a fixed height */
    background: var(--surface);
  }
</style>
