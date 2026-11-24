#!/usr/bin/env node
// hermes-browser: one command for everything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, HOME_DIR, extensionToken, mcpToken } from "./common.mjs";

/* global __HB_BUNDLED__ */
const BUNDLED = typeof __HB_BUNDLED__ !== "undefined";
const SELF = fileURLToPath(import.meta.url);

const HELP = `hermes-browser v${VERSION}: let a Hermes agent use your real Chrome.

Usage: hermes-browser <command>

  setup        Install and pair everything (asks how you run Hermes).
               --local | --cloud | --both   skip the question
               --domain <name>              ngrok static domain (cloud)
               --extension-id <id>          also allow this extension ID to pair
               --yes                        accept the defaults
  doctor       Check the installation and whether the extension is connected.
  tunnel       Start the bridge + ngrok tunnel for cloud Hermes (keep it open).
  serve        Run the MCP bridge on stdio (what a local Hermes launches).
               --http   serve MCP over HTTP on 127.0.0.1:8766 instead
  token        Print the extension token (only needed for manual pairing).
  mcp-token    Print the bearer token for cloud Hermes.
  uninstall    Undo setup. --purge also deletes ~/.hermes-browser.
  version      Print the version.
`;

const [cmd = "help", ...rest] = process.argv.slice(2);
const has = (f) => rest.includes(f);
const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

// Commands that load the bridge itself see their own argv without the subcommand.
const passArgs = () => { process.argv = [process.argv[0], SELF, ...rest]; };

async function main() {
  switch (cmd) {
    case "serve":
      passArgs();
      await import("./server.mjs");
      return;
    case "tunnel":
      globalThis.__HB_CLI = SELF; // the tunnel starts the bridge as `<this file> serve --http`
      passArgs();
      await import("./tunnel.mjs");
      return;
    case "token":
      process.stdout.write(extensionToken() + "\n");
      return;
    case "mcp-token":
      process.stdout.write(mcpToken() + "\n");
      return;
    case "setup":
    case "doctor":
    case "uninstall": {
      const s = await import("./setup.mjs");
      const L = s.layout(SELF, BUNDLED);
      const id = val("--extension-id");
      if (id) {
        if (!/^[a-p]{32}$/.test(id)) { console.error("That doesn't look like an extension ID (32 letters a-p)."); process.exit(2); }
        const file = path.join(HOME_DIR, "config.json");
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        cfg.extensionIds = [...new Set([...(cfg.extensionIds || []), id])];
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      }
      const flags = {
        yes: has("--yes") || has("-y"),
        purge: has("--purge"),
        domain: val("--domain"),
        mode: has("--both") || (has("--local") && has("--cloud")) ? "both" : has("--local") ? "local" : has("--cloud") ? "cloud" : undefined,
      };
      const code = cmd === "setup" ? await s.setup(L, BUNDLED, flags) : cmd === "doctor" ? await s.doctor(L) : await s.uninstall(L, BUNDLED, flags);
      process.exit(code);
    }
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
