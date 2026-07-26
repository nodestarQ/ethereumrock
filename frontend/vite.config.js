import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Inline the built JS and CSS into a single self-contained index.html, with ZERO new dependencies.
// One file has no relative-asset concerns at all: it serves from any IPFS gateway subpath, from
// file://, and IS the exact artifact the on-chain RockSite contract stores, so the whole frontend
// can live immutably on Ethereum L1 (matching the fully-on-chain art). `base: "./"` is kept as a
// belt-and-suspenders default in case someone disables inlining.
function singleFile() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    name: "rock-single-file",
    enforce: "post",
    generateBundle(_opts, bundle) {
      const html = bundle["index.html"];
      if (!html) return;
      let src = html.source;
      // Every replacement passes a FUNCTION, never a string. String.replace reads $&, $`, $', $1..
      // in a replacement STRING as substitution patterns, and minified JS is full of them: `$` is a
      // stock minified identifier, so `r=!$&(e&pe)` inside the Svelte runtime made `$&` splice the
      // matched <script src=...></script> tag into the middle of the code. That both broke the
      // bundle and closed the <script> element early, so the rest of the page parsed as HTML.
      // A replacer function's return value is always used verbatim.
      const inline = (tag, replacement) => {
        src = src.replace(tag, () => replacement);
      };
      for (const key of Object.keys(bundle)) {
        const f = bundle[key];
        if (f.type === "chunk" && f.fileName.endsWith(".js")) {
          const tag = new RegExp(`<script[^>]*\\bsrc="[^"]*${esc(f.fileName)}"[^>]*></script>`);
          // </script> only ever appears inside JS strings in bundled output, where <\/ is identical
          const code = f.code.replace(/<\/script>/g, "<\\/script>");
          inline(tag, `<script type="module">${code}</script>`);
          delete bundle[key];
        } else if (f.type === "asset" && f.fileName.endsWith(".css")) {
          const tag = new RegExp(`<link[^>]*\\bhref="[^"]*${esc(f.fileName)}"[^>]*>`);
          inline(tag, `<style>${f.source}</style>`);
          delete bundle[key];
        }
      }

      // The whole point of this plugin is that the page depends on nothing else, and a silent
      // failure here ships a file that 404s at runtime. Assert it instead of hoping.
      const dangling = [...src.matchAll(/\b(?:src|href)="([^"]*\/assets\/[^"]*)"/g)].map((m) => m[1]);
      if (dangling.length) {
        throw new Error(
          `single-file build left ${dangling.length} external reference(s), so the page is not self-contained: ` +
            dangling.join(", "),
        );
      }
      const opens = (src.match(/<script\b/g) || []).length;
      const closes = (src.match(/<\/script>/g) || []).length;
      if (opens !== closes) throw new Error(`unbalanced script tags after inlining: ${opens} open, ${closes} close`);

      html.source = src;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [svelte(), singleFile()],
  build: {
    target: "es2022",
    cssCodeSplit: false, // one CSS file, so the inliner folds it into the single page
    assetsInlineLimit: 100000000, // inline any incidental asset too
  },
});
