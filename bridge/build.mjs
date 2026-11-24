// Builds the publishable package: dist/cli.mjs (one dependency-free file) plus
// dist/extension (the Chrome extension that setup installs).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
fs.rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, "cli.mjs")],
  outfile: path.join(dist, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  define: { __HB_BUNDLED__: "true" },
  // ws optionally loads these native speedups; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS dependencies (ws) call require(); give ESM output one.
  banner: { js: 'import { createRequire as __hbCreateRequire } from "node:module"; const require = __hbCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "info",
});

fs.cpSync(path.join(here, "..", "extension"), path.join(dist, "extension"), { recursive: true });
fs.copyFileSync(path.join(here, "..", "README.md"), path.join(here, "README.md"));
console.log("built dist/cli.mjs and dist/extension");
