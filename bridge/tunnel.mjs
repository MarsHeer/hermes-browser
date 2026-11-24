#!/usr/bin/env node
// Starts the bridge in HTTP mode plus an ngrok tunnel to it, for a cloud Hermes.
//
//   hermes-browser tunnel                     (domain saved by `hermes-browser setup`)
//   hermes-browser tunnel <your-domain>       (set or change the domain)
//   hermes-browser tunnel --show-token        (also print the MCP token)
// From a source checkout, `node bridge/tunnel.mjs` works the same.
//
// Ctrl+C stops both. Only the MCP port (8766) is tunneled; the extension's
// socket (8765) stays local-only.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR, HTTP_PORT, mcpToken } from "./common.mjs";
import { findNgrok } from "./ngrok.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Run through the CLI (hermes-browser tunnel) or directly (node tunnel.mjs).
const bridgeArgs = globalThis.__HB_CLI ? [globalThis.__HB_CLI, "serve", "--http"] : [path.join(here, "server.mjs"), "--http"];
const domainFile = path.join(HOME_DIR, "ngrok-domain");
const say = (...a) => console.log("[tunnel]", ...a);

// ---- domain ----
let domain = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (domain) {
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(domainFile, domain);
} else if (fs.existsSync(domainFile)) {
  domain = fs.readFileSync(domainFile, "utf8").trim();
} else {
  console.error("No ngrok domain yet. Run: hermes-browser setup --cloud\n" +
    "(or pass it: hermes-browser tunnel <your-static-domain.ngrok-free.dev>; find it at https://dashboard.ngrok.com/domains)");
  process.exit(1);
}

const ngrokBin = findNgrok();
if (!ngrokBin) { console.error("ngrok not found. Run: hermes-browser setup --cloud (or install it and set NGROK_PATH)."); process.exit(1); }

// ---- start bridge ----
const children = [];
let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(code), 300);
};
process.on("SIGINT", () => { say("stopping..."); stopAll(0); });
process.on("SIGTERM", () => stopAll(0));

const bridge = spawn(process.execPath, bridgeArgs, { stdio: ["ignore", "inherit", "pipe"] });
children.push(bridge);
bridge.on("exit", (c) => { if (!stopping) { say(`bridge exited (${c}); stopping tunnel.`); stopAll(1); } });

let ngrokStarted = false;
bridge.stderr.on("data", (d) => {
  process.stderr.write(d);
  if (!ngrokStarted && /MCP over HTTP/.test(d)) { ngrokStarted = true; startNgrok(); }
});

// ---- start ngrok ----
function startNgrok() {
const ngrok = spawn(ngrokBin, ["http", `127.0.0.1:${HTTP_PORT}`, "--url", `https://${domain}`, "--log", "stdout", "--log-format", "logfmt"], { stdio: ["ignore", "pipe", "pipe"] });
children.push(ngrok);
ngrok.on("exit", (c) => { if (!stopping) { say(`ngrok exited (${c}); stopping bridge.`); stopAll(1); } });

let announced = false;
const onNgrok = (d) => {
  for (const line of String(d).split(/\r?\n/)) {
    if (!line) continue;
    if (/lvl=(eror|crit)|ERR_NGROK/.test(line)) console.error("[ngrok]", line);
    if (!announced && /msg="started tunnel"/.test(line)) {
      announced = true;
      const url = (line.match(/url=(\S+)/) || [])[1] || `https://${domain}`;
      const token = mcpToken();
      if (process.platform === "win32") spawnSync("clip", { input: token });
      else if (process.platform === "darwin") spawnSync("pbcopy", { input: token });
      console.log(`
  Tunnel is up. In your Hermes cloud dashboard, add an MCP server:

    URL:     ${url}/mcp
    Header:  Authorization: Bearer <MCP token>   (token copied to your clipboard${process.argv.includes("--show-token") ? `: ${token}` : ""})

  Keep this window open. Ctrl+C stops the bridge and the tunnel.
`);
    }
  }
};
ngrok.stdout.on("data", onNgrok);
ngrok.stderr.on("data", (d) => console.error("[ngrok]", String(d).trim()));
}
