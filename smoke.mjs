const base = process.env.BASE_URL;
if (!base) {
  console.error("Set BASE_URL, e.g. BASE_URL=https://your-worker.workers.dev");
  process.exit(2);
}
const baseUrl = new URL(base);
const localHttp = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
if (baseUrl.protocol !== "https:" && !localHttp) {
  console.error("BASE_URL must use HTTPS (HTTP is allowed only for localhost development).");
  process.exit(2);
}

const checks = [];
async function check(name, path, expectedStatuses, init = {}) {
  try {
    const response = await fetch(new URL(path, baseUrl), { redirect: "manual", ...init });
    checks.push({ name, passed: expectedStatuses.includes(response.status), status: response.status, contentType: response.headers.get("content-type") });
    await response.body?.cancel();
  } catch (error) {
    checks.push({ name, passed: false, error: error?.name || "FetchError" });
  }
}

async function checkDiscovery() {
  const candidates = ["/.well-known/fluxer", "/api/.well-known/fluxer"];
  let lastStatus = null;
  for (const path of candidates) {
    try {
      const response = await fetch(new URL(path, baseUrl), { redirect: "manual", headers: { Accept: "application/json" } });
      lastStatus = response.status;
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        checks.push({ name: "Fluxer Discovery mapped through Worker", passed: false, status: response.status, detail: response.status === 501 ? "Strict single-origin mode rejected a multi-host instance." : "Discovery did not return a successful response." });
        return;
      }
      let document;
      try { document = await response.json(); }
      catch {
        checks.push({ name: "Fluxer Discovery mapped through Worker", passed: false, status: response.status, detail: "Invalid JSON" });
        return;
      }
      const e = document?.endpoints || {};
      const required = ["api", "api_client", "api_public", "gateway", "media", "upload_relay", "static_cdn"];
      const mapped = required.every((key) => {
        try {
          const u = new URL(e[key]);
          return u.hostname === baseUrl.hostname && (key !== "gateway" || u.protocol === "wss:");
        } catch { return false; }
      });
      checks.push({ name: "Fluxer Discovery mapped through Worker", passed: mapped, status: response.status, detail: mapped ? "Core endpoints resolve to the public Worker host." : "One or more core endpoints are missing or outside the Worker host." });
      return;
    } catch (error) {
      checks.push({ name: "Fluxer Discovery mapped through Worker", passed: false, status: lastStatus, error: error?.name || "FetchError" });
      return;
    }
  }
  checks.push({ name: "Fluxer Discovery mapped through Worker", passed: false, status: lastStatus, detail: "Neither documented discovery path returned a document." });
}

await check("SPA application path /app", "/app", [200]);
await check("Manifest", "/manifest.json", [200]);
await check("Service worker script", "/sw.js", [200]);
await check("HEAD method preserved", "/app", [200], { method: "HEAD" });
await check("Query string accepted", "/app?proxy_smoke=1", [200]);
await checkDiscovery();

if (process.env.TEST_JSON_PATH) await check("Operator-supplied JSON/API path", process.env.TEST_JSON_PATH, [200, 401, 403, 429]);
if (process.env.TEST_RANGE_PATH) {
  await check("Operator-supplied Range resource", process.env.TEST_RANGE_PATH, [200, 206], { headers: { Range: "bytes=0-31" } });
}
if (process.env.TEST_WS_PATH) {
  try {
    const wsUrl = new URL(process.env.TEST_WS_PATH, baseUrl);
    wsUrl.protocol = "wss:";
    const ws = new WebSocket(wsUrl);
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve({ passed: false, result: "timeout" }); }, 8000);
      ws.addEventListener("open", () => { clearTimeout(timeout); ws.close(1000, "smoke test"); resolve({ passed: true, result: "open" }); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timeout); resolve({ passed: false, result: "error" }); }, { once: true });
    });
    checks.push({ name: "Operator-supplied WebSocket handshake", ...result });
  } catch (error) {
    checks.push({ name: "Operator-supplied WebSocket handshake", passed: false, error: error?.name || "WebSocketError" });
  }
}

for (const result of checks) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result)}`);
// Passing this relay smoke test does not certify login, Gateway protocol resume,
// uploads, or WebRTC media; those require an authorized instance and account.
if (checks.some((result) => !result.passed)) process.exitCode = 1;
