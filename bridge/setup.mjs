// hermes-browser setup / doctor / uninstall.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";
import http from "node:http";
import { VERSION, HOME_DIR, PORT, LEGACY_NATIVE_HOST, extensionToken, mcpToken, allowedExtensionIds } from "./common.mjs";
import { findNgrok, ngrokHasAuthtoken } from "./ngrok.mjs";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const MCP_NAME = "chrome"; // name of the server in Hermes's config

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36);
const ok = (s) => console.log(`  ${green("✔")} ${s}`);
const warn = (s) => console.log(`  ${yellow("!")} ${s}`);
const bad = (s) => console.log(`  ${red("✘")} ${s}`);
const info = (s) => console.log(`    ${dim(s)}`);
const tilde = (p) => p.replace(os.homedir(), "~");

// ---------------------------------------------------------------- helpers

const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

async function ask(question, def = "", { hidden = false } = {}) {
  if (!interactive()) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, "*"));
  }
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim() || def;
}
const yes = async (q, def = true, flags = {}) =>
  flags.yes ? true : /^y/i.test(await ask(`  ${q} ${def ? "[Y/n]" : "[y/N]"} `, def ? "y" : "n"));

// Run a command found on PATH (handles .cmd/.exe shims on Windows).
function run(cmd, args, opts = {}) {
  if (!WIN) return spawnSync(cmd, args, { encoding: "utf8", ...opts });
  const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
  return spawnSync([cmd, ...args].map(q).join(" "), { encoding: "utf8", shell: true, ...opts });
}
const onPath = (cmd) => run(WIN ? "where" : "which", [cmd]).status === 0;

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

// ---------------------------------------------------------------- layout

// Where things live once installed. When run from the published package (npx),
// the bundled CLI and extension are copied into ~/.hermes-browser so they keep
// working after npm clears its cache. From a source checkout they're used in place.
export function layout(self, bundled) {
  const here = path.dirname(self);
  // How the user should type commands: npx leaves nothing on PATH.
  const viaNpx = /[\\/]_npx[\\/]/.test(self);
  const viaNpm = /[\\/]node_modules[\\/]/.test(self); // global/local npm install puts it on PATH
  const app = bundled ? path.join(HOME_DIR, "app", "hermes-browser.mjs") : self;
  return {
    self,
    // A bundle built from a git clone (npm run setup) isn't on PATH: point at the installed copy.
    cmd: !bundled ? `node "${self}"` : viaNpx ? "npx hermes-browser" : viaNpm ? "hermes-browser" : `node "${app}"`,
    shortcut: WIN ? path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Hermes Browser Tunnel.lnk") : null,
    app,
    extension: bundled ? path.join(HOME_DIR, "extension") : path.join(here, "..", "extension"),
    extensionSrc: bundled ? path.join(here, "extension") : path.join(here, "..", "extension"),
  };
}

const WIN_REG_ROOTS = [
  ["Chrome", "HKCU\\Software\\Google\\Chrome"],
  ["Edge", "HKCU\\Software\\Microsoft\\Edge"],
  ["Brave", "HKCU\\Software\\BraveSoftware\\Brave-Browser"],
  ["Chromium", "HKCU\\Software\\Chromium"],
];
function unixBrowserDirs() {
  const base = MAC ? path.join(os.homedir(), "Library", "Application Support") : path.join(os.homedir(), ".config");
  const names = MAC
    ? [["Chrome", "Google/Chrome"], ["Chrome Beta", "Google/Chrome Beta"], ["Edge", "Microsoft Edge"], ["Brave", "BraveSoftware/Brave-Browser"], ["Chromium", "Chromium"]]
    : [["Chrome", "google-chrome"], ["Chrome Beta", "google-chrome-beta"], ["Edge", "microsoft-edge"], ["Brave", "BraveSoftware/Brave-Browser"], ["Chromium", "chromium"]];
  return names.map(([label, rel]) => [label, path.join(base, rel)]);
}

// ---------------------------------------------------------------- steps

function installFiles(L, bundled) {
  if (bundled) {
    fs.mkdirSync(path.dirname(L.app), { recursive: true });
    // Re-running setup from the installed copy itself: everything is already in place.
    if (path.resolve(L.self) !== path.resolve(L.app)) fs.copyFileSync(L.self, L.app);
    if (fs.existsSync(L.extensionSrc)) copyDir(L.extensionSrc, L.extension);
  }
  ok(`Bridge installed: ${tilde(L.app)}`);
}

// A pre-release of 0.5 paired through a native messaging host; remove its
// registry keys / manifests and files if they're still around.
function removeLegacyNativeHost() {
  let found = false;
  if (WIN) {
    for (const [, root] of WIN_REG_ROOTS) {
      const r = spawnSync("reg", ["delete", `${root}\\NativeMessagingHosts\\${LEGACY_NATIVE_HOST}`, "/f"], { stdio: "ignore" });
      if (r.status === 0) found = true;
    }
  } else {
    for (const [, dir] of unixBrowserDirs()) {
      const f = path.join(dir, "NativeMessagingHosts", `${LEGACY_NATIVE_HOST}.json`);
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); found = true; }
    }
  }
  const nativeDir = path.join(HOME_DIR, "native");
  if (fs.existsSync(nativeDir)) { fs.rmSync(nativeDir, { recursive: true, force: true }); found = true; }
  return found;
}

// Ask a bridge's /pair endpoint for the token, posing as the given Origin.
function pairRequest(origin) {
  return new Promise((resolve) => {
    const req = http.request({ method: "POST", host: "127.0.0.1", port: PORT, path: "/pair", headers: origin ? { origin } : {}, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve({ status: res.statusCode, ...JSON.parse(body) }); } catch { resolve({ status: res.statusCode }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

// Pairing works when our extension gets the token and anyone else is refused.
async function checkPairing() {
  const good = await pairRequest(`chrome-extension://${allowedExtensionIds()[0]}`);
  const page = await pairRequest("https://example.com");
  if (good.token !== extensionToken()) return { ok: false, why: good.error || `bridge answered ${good.status}` };
  if (page.status !== 403 || page.token) return { ok: false, why: "the bridge gave the token to a web page" };
  return { ok: true };
}

function hermesHasServer() {
  const r = run("hermes", ["mcp", "list"]);
  return r.status === 0 && new RegExp(`(^|\\s)${MCP_NAME}(\\s|$)`, "m").test(r.stdout || "");
}

function registerWithHermes(L) {
  if (hermesHasServer()) run("hermes", ["mcp", "remove", MCP_NAME], { input: "y\n" });
  // --args must come last; Hermes asks whether to enable all tools, so answer Y.
  const r = run("hermes", ["mcp", "add", MCP_NAME, "--command", process.execPath,
    "--env", `HERMES_BROWSER_HOME=${HOME_DIR}`, "--args", L.app, "serve"], { input: "Y\n" });
  if (r.status !== 0 || !hermesHasServer()) {
    bad(`Could not add the "${MCP_NAME}" MCP server to Hermes.`);
    info((r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join("\n    "));
    return false;
  }
  ok(`Added to your local Hermes as the "${MCP_NAME}" MCP server`);
  const status = run("hermes", ["gateway", "status"]);
  if (/\brunning\b/i.test(status.stdout || "") && !/not running/i.test(status.stdout || "")) {
    run("hermes", ["gateway", "restart"]);
    ok("Restarted the Hermes gateway so it picks up the new tools");
  }
  return true;
}

function unregisterFromHermes() {
  if (!onPath("hermes") || !hermesHasServer()) return false;
  run("hermes", ["mcp", "remove", MCP_NAME], { input: "y\n" });
  return true;
}

function copyToClipboard(text) {
  if (WIN) return spawnSync("clip", { input: text }).status === 0;
  if (MAC) return spawnSync("pbcopy", { input: text }).status === 0;
  for (const [cmd, args] of [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]) {
    if (spawnSync(cmd, args, { input: text }).status === 0) return true;
  }
  return false;
}

// Start-menu shortcut that opens a console running the tunnel.
function createTunnelShortcut(L) {
  if (!L.shortcut) return false;
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:HB_LNK);` +
    `$s.TargetPath=$env:HB_NODE;$s.Arguments='"'+$env:HB_APP+'" tunnel';$s.WorkingDirectory=$env:HB_HOME;` +
    `$s.Description='Share this browser with cloud Hermes (close the window to stop)';$s.Save()`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, HB_LNK: L.shortcut, HB_NODE: process.execPath, HB_APP: L.app, HB_HOME: HOME_DIR },
    encoding: "utf8",
  });
  return r.status === 0 && fs.existsSync(L.shortcut);
}

async function setupCloud(L, flags) {
  console.log(`\n${bold("Cloud Hermes")} ${dim("(reaches this PC through an ngrok tunnel)")}`);
  let ngrok = findNgrok();
  if (!ngrok) {
    if (WIN && onPath("winget") && await yes("ngrok isn't installed. Install it now with winget?", true, flags)) {
      spawnSync("winget", ["install", "--id", "Ngrok.Ngrok", "-e"], { stdio: "inherit" });
      ngrok = findNgrok();
    } else if (MAC && onPath("brew") && await yes("ngrok isn't installed. Install it now with Homebrew?", true, flags)) {
      spawnSync("brew", ["install", "ngrok"], { stdio: "inherit" });
      ngrok = findNgrok();
    }
  }
  if (!ngrok) {
    bad("ngrok not found. Install it from https://ngrok.com/download, then run setup again.");
    return false;
  }
  ok(`ngrok found: ${tilde(ngrok)}`);

  if (ngrokHasAuthtoken(ngrok)) ok("ngrok account connected");
  else {
    console.log(`    Create a free account at ${cyan("https://dashboard.ngrok.com/signup")}, then copy your authtoken from`);
    console.log(`    ${cyan("https://dashboard.ngrok.com/get-started/your-authtoken")}`);
    const tok = await ask("    Paste your ngrok authtoken (hidden): ", "", { hidden: true });
    if (!tok) { warn("Skipped. Run setup again when you have it."); return false; }
    const r = spawnSync(ngrok, ["config", "add-authtoken", tok], { encoding: "utf8" });
    if (r.status !== 0) { bad("ngrok rejected that authtoken."); return false; }
    ok("ngrok account connected");
  }

  const domainFile = path.join(HOME_DIR, "ngrok-domain");
  const saved = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, "utf8").trim() : "";
  let domain = flags.domain || saved;
  if (!flags.domain) {
    if (!saved) console.log(`    Copy your free static domain from ${cyan("https://dashboard.ngrok.com/domains")}`);
    domain = await ask(`    Your ngrok domain${saved ? ` [${saved}]` : ""}: `, saved);
  }
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) { warn(`No domain yet. Run setup again, or pass it: ${L.cmd} tunnel <domain>`); return false; }
  fs.writeFileSync(domainFile, domain);
  ok(`Tunnel domain: ${domain}`);
  const shortcut = createTunnelShortcut(L);
  if (shortcut) ok(`Start menu shortcut: ${bold("Hermes Browser Tunnel")}`);

  const copied = copyToClipboard(mcpToken());
  console.log(`
    In your Hermes cloud dashboard, add a remote MCP server:
      URL:     ${cyan(`https://${domain}/mcp`)}
      Header:  ${cyan("Authorization")} = ${cyan("Bearer <MCP token>")}  ${dim(copied ? "(token copied to your clipboard)" : `(print it with: ${L.cmd} mcp-token)`)}

    Each time you want the cloud agent to use this browser, ${shortcut ? `open ${bold("Hermes Browser Tunnel")} from the Start menu, or run` : "run"}:  ${cyan(`${L.cmd} tunnel`)}`);
  return true;
}

function extensionSteps(L) {
  console.log(`\n${bold("Chrome extension")}`);
  console.log(`    1. Open ${cyan("chrome://extensions")} and turn on ${bold("Developer mode")} (top right).`);
  console.log(`    2. Click ${bold("Load unpacked")} and choose:  ${cyan(L.extension)}`);
  console.log(`       ${dim("Already loaded it? Click its reload button instead.")}`);
  console.log(`    3. That's it: whenever a bridge is running, the extension pairs itself. ${dim(`Check with: ${L.cmd} doctor`)}`);
}

// ---------------------------------------------------------------- commands

export async function setup(L, bundled, flags) {
  console.log(`\n${bold(`Hermes Browser setup`)} ${dim(`v${VERSION}`)}\n`);
  extensionToken();
  ok(`Tokens ready in ${tilde(HOME_DIR)}`);
  installFiles(L, bundled);
  if (removeLegacyNativeHost()) ok("Removed the old native-messaging pairing (no longer needed)");

  // Which Hermes? Default from what's on this machine.
  const hasCli = onPath("hermes");
  let cloudDesktop = false;
  try {
    const conn = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "Hermes", "connection.json"), "utf8"));
    cloudDesktop = conn.mode === "cloud";
  } catch {}
  let mode = flags.mode;
  if (!mode) {
    const def = hasCli && cloudDesktop ? "3" : cloudDesktop || !hasCli ? "2" : "1";
    console.log(`\n  How do you run Hermes?`);
    console.log(`    1) Locally on this computer (hermes CLI / gateway)${hasCli ? dim("  - found") : ""}`);
    console.log(`    2) In the cloud (hosted agent)${cloudDesktop ? dim("  - desktop app is in cloud mode") : ""}`);
    console.log(`    3) Both`);
    const a = await ask(`  Choose 1-3 [${def}]: `, def);
    mode = { 1: "local", 2: "cloud", 3: "both" }[a] || { 1: "local", 2: "cloud", 3: "both" }[def];
  }

  let good = true;
  if (mode === "local" || mode === "both") {
    console.log(`\n${bold("Local Hermes")}`);
    if (!hasCli) { bad("The hermes command isn't on PATH. Install Hermes, open a new terminal, and run setup again."); good = false; }
    else good = registerWithHermes(L) && good;
  }
  if (mode === "cloud" || mode === "both") good = (await setupCloud(L, flags)) && good;

  extensionSteps(L);
  console.log(`\n${good ? green("Setup complete.") : yellow("Setup finished with warnings (see above).")}\n`);
  return good ? 0 : 1;
}

// Ask a running bridge (as a peer) whether the extension is connected.
function bridgeStatus(timeout = 2000) {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/?role=peer&token=${encodeURIComponent(extensionToken())}`);
    const done = (v) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done({ running: false, why: "timeout" }), timeout);
    s.on("open", () => s.send(JSON.stringify({ type: "status", id: 1 })));
    s.on("message", (raw) => { try { const m = JSON.parse(raw); if (m.type === "status") done({ running: true, ...m }); } catch {} });
    s.on("error", (e) => done({ running: false, why: e.message }));
  });
}

export async function doctor(L) {
  console.log(`\n${bold("Hermes Browser doctor")} ${dim(`v${VERSION}`)}\n`);
  let problems = 0;
  const fail = (s, hint) => { problems++; bad(s); if (hint) info(hint); };

  const major = Number(process.versions.node.split(".")[0]);
  major >= 18 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} is too old`, "Install Node 18 or newer.");
  const rerun = `Run: ${L.cmd} setup`;
  fs.existsSync(path.join(HOME_DIR, "token")) ? ok(`Token in ${tilde(HOME_DIR)}`) : fail("No token yet", rerun);
  fs.existsSync(L.app) ? ok(`Bridge at ${tilde(L.app)}`) : fail("Bridge not installed", rerun);

  if (onPath("hermes")) {
    hermesHasServer() ? ok(`Local Hermes has the "${MCP_NAME}" MCP server`) : info(`Local Hermes found, but "${MCP_NAME}" isn't added (fine if you only use cloud Hermes).`);
  } else info("No local hermes CLI (fine if you only use cloud Hermes).");

  const domainFile = path.join(HOME_DIR, "ngrok-domain");
  if (fs.existsSync(domainFile)) {
    const ngrok = findNgrok();
    if (!ngrok) fail("Cloud tunnel configured but ngrok is missing", `${rerun} --cloud`);
    else if (!ngrokHasAuthtoken(ngrok)) fail("ngrok has no authtoken", `${rerun} --cloud`);
    else ok(`Cloud tunnel ready: https://${fs.readFileSync(domainFile, "utf8").trim()}/mcp ${dim(`(start it with: ${L.cmd} tunnel)`)}`);
  }

  // Is the extension reachable? Use a running bridge, or start one briefly.
  let st = await bridgeStatus();
  let temp = null;
  if (!st.running) {
    temp = spawn(process.execPath, [L.app, "serve"], { stdio: ["pipe", "ignore", "ignore"] });
    for (let i = 0; i < 10 && !st.running; i++) { await new Promise((r) => setTimeout(r, 300)); st = await bridgeStatus(); }
  } else if (st.version !== VERSION) {
    warn(`The running bridge is v${st.version || "?"} (this is v${VERSION}). Restart Hermes or the tunnel to update it.`);
  }
  if (st.running) {
    const p = await checkPairing();
    p.ok ? ok("Automatic pairing works (and web pages are refused)") : fail(`Automatic pairing failed: ${p.why}`, "Restart Hermes or the tunnel so the bridge is up to date.");
  }
  if (st.running && !st.extension) {
    info(`${temp ? "Started a temporary bridge; w" : "W"}aiting up to 35s for the extension to connect...`);
    // The extension retries every few seconds, or every 30s if Chrome put it to sleep.
    for (let i = 0; i < 35 && !st.extension; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await bridgeStatus();
    }
  }
  if (st.running && st.extension) ok(`Chrome extension connected${temp ? "" : " to the running bridge"}`);
  else if (st.running) fail("The Chrome extension isn't connected", `Load it from ${L.extension} (Load unpacked in chrome://extensions), make sure Chrome is open and the extension is enabled.`);
  else fail(`Couldn't start a bridge on port ${PORT} (${st.why})`, "Is something else using that port?");
  if (temp) temp.kill();

  console.log(problems ? `\n${yellow(`${problems} problem${problems > 1 ? "s" : ""} found.`)}\n` : `\n${green("Everything looks good.")}\n`);
  return problems ? 1 : 0;
}

export async function uninstall(L, bundled, flags) {
  console.log(`\n${bold("Hermes Browser uninstall")}\n`);
  if (removeLegacyNativeHost()) ok("Removed the old native-messaging pairing");
  if (unregisterFromHermes()) ok(`Removed "${MCP_NAME}" from your local Hermes`);
  if (L.shortcut && fs.existsSync(L.shortcut)) { fs.rmSync(L.shortcut, { force: true }); ok("Removed the Start menu shortcut"); }
  if (bundled) {
    fs.rmSync(path.dirname(L.app), { recursive: true, force: true });
    fs.rmSync(L.extension, { recursive: true, force: true });
    ok("Removed the installed bridge and extension files");
  }
  if (flags.purge) {
    fs.rmSync(HOME_DIR, { recursive: true, force: true });
    ok(`Deleted ${tilde(HOME_DIR)} (tokens, screenshots, settings)`);
  } else info(`Kept ${tilde(HOME_DIR)} (tokens, screenshots). Add --purge to delete it.`);
  console.log(`\n  Remove the extension itself from ${cyan("chrome://extensions")}, and the MCP server from your Hermes cloud dashboard if you added one.\n`);
  return 0;
}
