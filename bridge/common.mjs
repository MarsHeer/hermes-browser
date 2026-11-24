// Shared paths, constants and secrets for the bridge, tunnel and CLI.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.6.1";
export const HOME_DIR = process.env.HERMES_BROWSER_HOME || path.join(os.homedir(), ".hermes-browser");
export const PORT = Number(process.env.HERMES_BROWSER_PORT || 8765);
export const HTTP_PORT = Number(process.env.HERMES_BROWSER_HTTP_PORT || 8766);

// Extensions the bridge hands its token to at /pair. The first is the ID the
// manifest's "key" produces when loaded unpacked; add the Chrome Web Store ID
// here once the extension is published. `setup --extension-id` adds more.
export const EXTENSION_IDS = ["alioifdhmmimahjfnfccegannpnnlmgm"];

export function allowedExtensionIds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME_DIR, "config.json"), "utf8"));
    return [...new Set([...EXTENSION_IDS, ...(cfg.extensionIds || [])])];
  } catch { return [...EXTENSION_IDS]; }
}

// Name of the native messaging host older versions (0.5.0 pre-release) registered;
// kept only so setup/uninstall can clean it up.
export const LEGACY_NATIVE_HOST = "com.hermes_browser.bridge";

// "token": shared with the Chrome extension. "mcp-token": what an HTTP MCP client
// (cloud Hermes) must send as "Authorization: Bearer <mcp-token>".
export function loadSecret(file, envVar) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const p = path.join(HOME_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const t = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, t, { mode: 0o600 });
  return t;
}
export const extensionToken = () => loadSecret("token", "HERMES_BROWSER_TOKEN");
export const mcpToken = () => loadSecret("mcp-token", "HERMES_BROWSER_MCP_TOKEN");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
