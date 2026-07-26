<script>
  import { router, matchRoute } from "./lib/router.svelte.js";
  import Nav from "./components/Nav.svelte";
  import Home from "./routes/Home.svelte";
  import Market from "./routes/Market.svelte";
  import Rock from "./routes/Rock.svelte";
  import Account from "./routes/Account.svelte";
  import Wrap from "./routes/Wrap.svelte";

  const route = $derived(matchRoute(router.path));
</script>

<Nav />

<main>
  {#if route.name === "home"}
    <Home />
  {:else if route.name === "market"}
    <Market />
  {:else if route.name === "rock"}
    {#key route.params.id}<Rock id={route.params.id} />{/key}
  {:else if route.name === "account"}
    <Account />
  {:else if route.name === "wrap"}
    <Wrap />
  {:else}
    <p>Not found. <a href="#/">Home</a></p>
  {/if}
</main>
