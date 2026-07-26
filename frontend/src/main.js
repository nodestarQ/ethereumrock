//       ##
//       ####          E T H E R E U M R O C K
//     ########
//     ########        the frontend
//     ########
//       ######
//
// One file when built, served from the chain by EthereumRockSite. No backend, no indexer, no
// analytics, no storage: every read is an eth_call through the connected wallet.
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { wallet } from "./lib/wallet.svelte.js";

// start listening for injected wallets right away; the list fills in as they announce
wallet.discover();

export default mount(App, { target: document.getElementById("app") });
