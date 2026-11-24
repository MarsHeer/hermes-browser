const $ = (id) => document.getElementById(id);
const LABELS = {
  connected: "Connected to the bridge",
  connecting: "Connecting…",
  disconnected: "Not connected. Is the bridge running? (Hermes starts it, or the Hermes Browser tunnel does)",
  disabled: "Disabled",
  "no-token": "Waiting for the bridge to pair with. Start Hermes, or open \"Hermes Browser Tunnel\" (or run its tunnel command).",
};

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  const s = r?.status || "disconnected";
  $("dot").className = "dot " + s;
  $("status").textContent = LABELS[s] || s;
  $("paired").textContent = r?.paired && s === "connected" ? "Paired automatically."
    : r?.pairError && s !== "connected" ? `Can't pair: ${r.pairError}` : "";
  // Stop / Resume: shown while connected, or whenever paused.
  $("pauseRow").style.display = s === "connected" || r?.paused ? "" : "none";
  $("pauseBtn").textContent = r?.paused ? "Resume Hermes" : "Stop Hermes";
  $("pauseBtn").style.background = r?.paused ? "#6d28d9" : "#dc2626";
  $("pauseBtn").dataset.paused = r?.paused ? "1" : "";
  if (r?.paused) $("status").textContent = "Paused: Hermes can't act until you resume.";
}

$("pauseBtn").onclick = async () => {
  await chrome.runtime.sendMessage({ type: $("pauseBtn").dataset.paused ? "resume" : "pause" }).catch(() => {});
  refresh();
};
$("visuals").onchange = () => chrome.storage.local.set({ visuals: $("visuals").checked });

(async () => {
  const { port = 8765, token = "", enabled = true, visuals = true } = await chrome.storage.local.get(["port", "token", "enabled", "visuals"]);
  $("visuals").checked = visuals !== false;
  $("port").value = port;
  $("token").value = token;
  $("enabled").checked = enabled;
  refresh();
  setInterval(refresh, 1000);
})();

$("save").onclick = async () => {
  await chrome.storage.local.set({
    port: Number($("port").value) || 8765,
    token: $("token").value.trim(),
    enabled: $("enabled").checked,
  });
  await chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  $("msg").textContent = "Saved.";
};

$("pair").onclick = async () => {
  $("msg").textContent = "Pairing…";
  const r = await chrome.runtime.sendMessage({ type: "pair" }).catch(() => null);
  const { token = "", port = 8765 } = await chrome.storage.local.get(["token", "port"]);
  $("token").value = token;
  $("port").value = port;
  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  $("msg").textContent = r?.ok ? "Paired." : st?.pairError ? `Can't pair: ${st.pairError}` : "Already paired.";
};
