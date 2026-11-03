const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const UNTRUSTED_FORWARDING_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port",
  "x-forwarded-proto", "x-real-ip",
]);
const DISCOVERY_PATHS = new Set(["/.well-known/fluxer", "/api/.well-known/fluxer"]);
const MAX_TRANSFORM_BYTES = 512 * 1024;
const CORE_ENDPOINT_KEYS = ["api", "api_client", "api_public", "gateway", "media", "upload_relay", "static_cdn"];
const URL_ENDPOINT_KEYS = [
  ...CORE_ENDPOINT_KEYS, "marketing", "admin", "invite", "gift", "webapp", "docs",
];
const BRANDING_URL_KEYS = [
  "icon_url", "symbol_url", "logo_url", "wordmark_url", "favicon_url", "favicon_dark_url",
  "status_page_url", "status_page_incident_history_url", "premium_info_url", "sign_in_backdrop_url",
];

export class ProxyConfigError extends Error {}
export class MultiOriginError extends Error {}
export class TransformSizeError extends Error {}

export function getConfiguredOrigin(env) {
  if (!env.ORIGIN_BASE_URL) throw new ProxyConfigError("ORIGIN_BASE_URL is not configured");
  let origin;
  try { origin = new URL(env.ORIGIN_BASE_URL); }
  catch { throw new ProxyConfigError("ORIGIN_BASE_URL is not a valid URL"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new ProxyConfigError("ORIGIN_BASE_URL must be a bare HTTPS origin");
  }
  return origin;
}

function jsonError(status, code, message, requestId) {
  return new Response(JSON.stringify({ error: code, message, request_id: requestId }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function copyRequestHeaders(source, isWebSocket) {
  const headers = new Headers(source);
  const connectionTokens = (headers.get("connection") || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of connectionTokens) headers.delete(name);
  for (const name of UNTRUSTED_FORWARDING_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.delete("accept-encoding");
  if (isWebSocket) {
    headers.set("upgrade", "websocket");
    // Connection is hop-by-hop and is intentionally left for the runtime to
    // negotiate; Cloudflare's fetch WebSocket contract uses the Upgrade header.
  }
  // Origin, Referer, Cookie and Authorization remain unchanged. The upstream
  // must allow the actual public Worker origin; the Worker never impersonates it.
  return headers;
}

function copyResponseHeaders(source) {
  const headers = new Headers(source);
  const connectionTokens = (headers.get("connection") || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of connectionTokens) headers.delete(name);
  return headers;
}

function sameAuthority(left, right) {
  return left.hostname.toLowerCase() === right.hostname.toLowerCase() && left.port === right.port;
}

export function mapEndpointToWorker(endpoint, key, upstreamOrigin, publicOrigin) {
  if (typeof endpoint !== "string" || endpoint.length === 0) return endpoint;
  let url;
  try { url = new URL(endpoint); }
  catch { throw new MultiOriginError(`Invalid endpoint URL: ${key}`); }

  if (sameAuthority(url, upstreamOrigin)) {
    url.protocol = key === "gateway" ? "wss:" : publicOrigin.protocol;
    url.hostname = publicOrigin.hostname;
    url.port = publicOrigin.port;
    return url.toString().replace(/\/$/, url.pathname === "/" && !url.search && !url.hash ? "" : "/");
  }
  if (sameAuthority(url, publicOrigin)) {
    // Self-host operators may configure the public endpoint as the Worker URL.
    url.protocol = key === "gateway" ? "wss:" : publicOrigin.protocol;
    return url.toString().replace(/\/$/, url.pathname === "/" && !url.search && !url.hash ? "" : "/");
  }
  return null;
}

export function rewriteDiscoveryDocument(document, upstreamOrigin, publicOrigin, requireSingleOrigin = true) {
  if (!document || typeof document !== "object" || !document.endpoints || typeof document.endpoints !== "object") {
    throw new MultiOriginError("Discovery document has no endpoints object");
  }
  const endpoints = document.endpoints;
  if (requireSingleOrigin) {
    for (const key of CORE_ENDPOINT_KEYS) {
      if (typeof endpoints[key] !== "string" || endpoints[key].length === 0) {
        throw new MultiOriginError(`Discovery is missing required endpoint: ${key}`);
      }
      if (mapEndpointToWorker(endpoints[key], key, upstreamOrigin, publicOrigin) === null) {
        throw new MultiOriginError(`Endpoint ${key} is outside the configured single-origin boundary`);
      }
    }
  }
  for (const key of URL_ENDPOINT_KEYS) {
    const mapped = mapEndpointToWorker(endpoints[key], key, upstreamOrigin, publicOrigin);
    if (mapped !== null && mapped !== undefined) endpoints[key] = mapped;
  }
  const branding = document.appPublic?.branding;
  if (branding && typeof branding === "object") {
    for (const key of BRANDING_URL_KEYS) {
      const value = branding[key];
      if (typeof value !== "string") continue;
      try {
        const url = new URL(value);
        if (sameAuthority(url, upstreamOrigin)) {
          url.protocol = publicOrigin.protocol;
          url.hostname = publicOrigin.hostname;
          url.port = publicOrigin.port;
          branding[key] = url.toString();
        }
      } catch { /* Leave non-URL branding values untouched. */ }
    }
  }
  return document;
}

export function addSameOriginApiMeta(html) {
  if (/<meta\s+[^>]*name=["']fluxer-api-origin["'][^>]*content=["']self["'][^>]*>/i.test(html)) return html;
  const meta = '<meta name="fluxer-api-origin" content="self">';
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${meta}`);
  return `${meta}${html}`;
}

async function readBoundedText(response, maxBytes = MAX_TRANSFORM_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new TransformSizeError();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TransformSizeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

export function mapSameOriginLocation(location, upstreamOrigin, publicOrigin) {
  if (!location) return location;
  try {
    const target = new URL(location, upstreamOrigin);
    if (target.origin !== upstreamOrigin.origin) return location;
    target.protocol = publicOrigin.protocol;
    target.host = publicOrigin.host;
    return target.toString();
  } catch { return location; }
}

function rewriteSameOriginAbsoluteUrls(html, upstreamOrigin, publicOrigin) {
  return html.split(upstreamOrigin.origin).join(publicOrigin.origin);
}

function removeRepresentationValidators(headers) {
  for (const name of ["content-length", "content-encoding", "content-md5", "etag", "last-modified", "accept-ranges"])
    headers.delete(name);
  headers.set("cache-control", "no-store");
}

function relayWebSocket(client, upstream) {
  client.accept({ allowHalfOpen: true });
  upstream.accept({ allowHalfOpen: true });
  client.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  let closing = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closing) return;
    closing = true;
    for (const socket of [client, upstream]) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
          socket.close(code, reason.slice(0, 120));
      } catch { /* Peer may already have closed. */ }
    }
  };
  const relay = (from, to) => from.addEventListener("message", (event) => {
    if (to.readyState !== WebSocket.OPEN) return closeBoth(1011, "Proxy peer is not open");
    try { to.send(event.data); } catch { closeBoth(1011, "WebSocket relay failed"); }
  });
  relay(client, upstream);
  relay(upstream, client);
  client.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || ""));
  upstream.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || ""));
  client.addEventListener("error", () => closeBoth(1011, "Client WebSocket error"));
  upstream.addEventListener("error", () => closeBoth(1011, "Upstream WebSocket error"));
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    let upstreamOrigin;
    try { upstreamOrigin = getConfiguredOrigin(env); }
    catch { return jsonError(500, "PROXY_CONFIGURATION_ERROR", "Configure ORIGIN_BASE_URL as a bare HTTPS origin.", requestId); }

    const incomingUrl = new URL(request.url);
    const publicOrigin = new URL(incomingUrl.origin);
    if (upstreamOrigin.origin === publicOrigin.origin)
      return jsonError(500, "ORIGIN_LOOP", "The Worker upstream must not be the Worker public origin.", requestId);

    const isWebSocket = (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
    const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, upstreamOrigin);
    const init = { method: request.method, headers: copyRequestHeaders(request.headers, isWebSocket), redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
      init.body = request.body;
      init.duplex = "half";
    }

    try {
      const upstreamResponse = await fetch(new Request(upstreamUrl, init));
      if (isWebSocket) {
        const upstreamSocket = upstreamResponse.webSocket;
        if (upstreamResponse.status !== 101 || !upstreamSocket) {
          try { await upstreamResponse.body?.cancel(); } catch { /* no-op */ }
          return jsonError(502, "UPSTREAM_WEBSOCKET_REJECTED", "The upstream did not accept the WebSocket upgrade.", requestId);
        }
        const pair = new WebSocketPair();
        const [client, proxySocket] = Object.values(pair);
        relayWebSocket(proxySocket, upstreamSocket);
        return new Response(null, { status: 101, webSocket: client });
      }

      const headers = copyResponseHeaders(upstreamResponse.headers);
      if (headers.has("location")) headers.set("location", mapSameOriginLocation(headers.get("location"), upstreamOrigin, publicOrigin));

      if (request.method !== "HEAD" && !request.headers.has("range") && upstreamResponse.status === 200) {
        const pathname = incomingUrl.pathname;
        const isDiscovery = DISCOVERY_PATHS.has(pathname);
        const isHtmlShell = headers.get("content-type")?.toLowerCase().includes("text/html") && !pathname.startsWith("/api/");
        if (isDiscovery || (isHtmlShell && env.ENABLE_SAME_ORIGIN_BOOTSTRAP === "true")) {
          let bodyText;
          try { bodyText = await readBoundedText(upstreamResponse); }
          catch (error) {
            if (error instanceof TransformSizeError)
              return jsonError(502, "TRANSFORM_BODY_TOO_LARGE", "A required bootstrap response exceeded the safe transform limit.", requestId);
            throw error;
          }
          if (isDiscovery) {
            let document;
            try { document = JSON.parse(bodyText); }
            catch { return jsonError(502, "INVALID_UPSTREAM_DISCOVERY", "The upstream discovery response was not valid JSON.", requestId); }
            try { rewriteDiscoveryDocument(document, upstreamOrigin, publicOrigin, env.REQUIRE_SINGLE_ORIGIN !== "false"); }
            catch (error) {
              const message = error instanceof MultiOriginError ? error.message : "Discovery endpoint mapping failed";
              return jsonError(501, "MULTI_ORIGIN_UNSUPPORTED", message, requestId);
            }
            bodyText = JSON.stringify(document);
          } else {
            bodyText = addSameOriginApiMeta(rewriteSameOriginAbsoluteUrls(bodyText, upstreamOrigin, publicOrigin));
          }
          removeRepresentationValidators(headers);
          return new Response(bodyText, { status: upstreamResponse.status, headers });
        }
      }

      return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers });
    } catch {
      return jsonError(502, "UPSTREAM_CONNECTION_FAILED", "The configured upstream could not be reached.", requestId);
    }
  },
};
