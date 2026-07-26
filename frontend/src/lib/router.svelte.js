// Tiny hash router. Hash routing works on every IPFS gateway and from file://, needs no gateway
// config, and needs no SvelteKit. `router.path` is reactive, so components re-render on navigation.

function hashPath() {
  const h = location.hash.replace(/^#/, "");
  return h.startsWith("/") ? h : "/" + h;
}

class Router {
  path = $state(hashPath());

  constructor() {
    if (typeof window !== "undefined") {
      addEventListener("hashchange", () => { this.path = hashPath(); });
      if (!location.hash) location.hash = "/";
    }
  }
}

export const router = new Router();

export function navigate(p) {
  location.hash = p;
}

// Map a path to a route name + params. Add routes here as pages are added.
export function matchRoute(path) {
  if (path === "/" || path === "") return { name: "home", params: {} };
  if (path === "/market") return { name: "market", params: {} };
  if (path === "/account") return { name: "account", params: {} };
  if (path === "/wrap") return { name: "wrap", params: {} };
  const m = path.match(/^\/rock\/(\d+)$/);
  if (m) return { name: "rock", params: { id: m[1] } };
  return { name: "notfound", params: {} };
}
