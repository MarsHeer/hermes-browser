// Locating ngrok and checking its configuration.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// winget installs ngrok outside PATH until a new shell is opened.
export function findNgrok() {
  const candidates = [
    process.env.NGROK_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "ngrok.exe"),
  ];
  const pkgs = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(pkgs)) {
    for (const d of fs.readdirSync(pkgs)) if (/^Ngrok\.Ngrok/i.test(d)) candidates.push(path.join(pkgs, d, "ngrok.exe"));
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["ngrok"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : null;
}

// True when ngrok's config file has an authtoken. Never returns the token.
export function ngrokHasAuthtoken(bin) {
  const r = spawnSync(bin, ["config", "check"], { encoding: "utf8" });
  const file = ((r.stdout || "") + (r.stderr || "")).match(/configuration file at (.+?)\s*$/m)?.[1];
  if (!file || !fs.existsSync(file)) return false;
  return /^\s*authtoken:\s*\S+/m.test(fs.readFileSync(file, "utf8"));
}
