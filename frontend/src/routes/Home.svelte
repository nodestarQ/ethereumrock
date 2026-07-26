<script>
  // Home is the story. No chain reads here, the live stats live on the Market page.
  import RockBanner from "../components/RockBanner.svelte";
</script>

<!-- One centred column at the story's reading width: title, then the band of rocks, then the prose.
     The page's own max-width is 76rem, so on a wide screen this leaves a generous margin either
     side; on a phone the column simply fills it. -->
<div class="home">
  <h1>EthereumRock</h1>

  <RockBanner />

  <article class="story">
  <p class="lede">
    On 12/26/2017 the EtherRock project launched, cementing itself as one of the first NFTs on Ethereum mainnet. What most people do
    not know is that there was a precursor, seventeen hours earlier. The same developer had already
    deployed a version of the smart contract with some bugs in it and replaced it the next morning. Let's call that one
    EtherRock v1.
  </p>

  <p>
    The collection was meant to be a hundred pet rocks. A single mistyped <code>=</code> in
    <code>buyRock</code> left every rock permanently "for sale" at whatever price it had stored and
    rocks above 100 had <code>0</code> stored, so anyone could claim those for the cost of gas.
  </p>

  <p>
    Both EtherRock contracts predate the ERC-721 standard, so nothing can list them without a proper
    wrapper. 2021 brought the first attempt at one for v1, which put the buyRock bug out of reach and arrived as two contracts: "Genesis
    Rocks" and "Genesis Rocks: 100-9999", effectively splitting the collectors into the elite hundred and everyone else. 
    The EtherRock developer had publicly disowned v1 by then and its collection was delisted, and between the split and 
    the disowning the whole thing was abandoned (again).
  </p>

  <p>
    EthereumRock is a new shot at this, a better and CROPS aligned one. It is an experiment for the
    first 10k rocks: merge two you own and the higher number burns into the lower, so the supply can
    shrink back to the 100 originally intended. The collectors have full control over whether it does.
  </p>

  <p>
    The art carries the same lineage. EtherRock used royalty-free clip art. Genesis Rocks pixelated
    it and pinned the result to IPFS, where the whole 100-9999 set shares the same hundred images.
    EthereumRock draws every rock on chain from its own seed, so each one is its own picture and
    there is nothing left to pin.
  </p>

  <p>
    The other mistake worth not repeating is a single point of failure, so everything here is on
    chain. The art and the metadata are on chain. The marketplace is on chain and takes zero fees.
    Even this website is on chain and can be read straight out of the smart contract. All of it
    should outlive me, for as long as Ethereum is up and running.
  </p>

    <div class="cta">
      <a class="btn primary" href="#/market">Browse the market</a>
      <a class="btn" href="#/wrap">Wrap a rock</a>
    </div>
  </article>
</div>

<style>
  /* The column keeps the width the prose already had; centring it is the whole layout. */
  .home { max-width: 44rem; margin: 0 auto; }

  /* Centred, and with the space under it opened up so the band reads as belonging to the title
     rather than to the first paragraph. */
  .home > h1 { text-align: center; margin: 0.45rem 0 1.4rem; }

  .lede { font-size: 1.12rem; color: var(--ink); }
  /* The band is the break between the title and the story, so the gap under it is the larger one. */
  .story { margin-top: 2rem; }
  .story p { color: var(--ink-2); }
  .story code { font-size: 0.9em; background: var(--surface-2); padding: 0.05rem 0.35rem; color: var(--ink); }

  /* Centred to match the title. The prose itself stays ragged-right: centring seven paragraphs would
     move the start of every line and make them harder to read. */
  .cta { display: flex; justify-content: center; gap: 0.8rem; margin-top: 2.25rem; flex-wrap: wrap; }
  .btn {
    display: inline-block;
    padding: 0.62rem 1.3rem;
    border-radius: var(--radius);
    border: 1px solid var(--line-2);
    background: var(--surface);
    color: var(--ink);
    font-weight: 550;
    text-decoration: none;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn.primary:hover { background: var(--accent-2); border-color: var(--accent-2); color: var(--on-accent); }
</style>
