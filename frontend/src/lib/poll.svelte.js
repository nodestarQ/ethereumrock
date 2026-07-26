// Auto-refresh preference, shared by every page that reads the chain.
//
// It lives outside the components so it survives navigation: turn it on in the market, open a rock,
// and it is still on. It is NOT written to storage, so a browser reload starts it off. That is the
// safe default for a switch whose whole job is to make repeated network calls.
//
// SECONDS is deliberately above one Ethereum block. Mainnet produces a block every ~12 seconds, so
// polling faster than that spends calls to be told nothing happened. Combined with the block-number
// check in Refresh.svelte, a tick where the chain has not moved costs exactly one `eth_blockNumber`,
// which is the cheapest call there is. That matters because every read here goes through the user's
// own wallet, which for most people means a shared public endpoint they did not choose.
class Poll {
  on = $state(false);
  seconds = 15;
}

export const poll = new Poll();
