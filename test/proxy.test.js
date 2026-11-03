import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  ProxyConfigError,
  MultiOriginError,
  addSameOriginApiMeta,
  getConfiguredOrigin,
  mapEndpointToWorker,
  mapSameOriginLocation,
  rewriteDiscoveryDocument,
} from "../src/index.js";

const upstream = new URL("https://origin.example.net");
const publicOrigin = new URL("https://test-proxy.workers.dev");
const discoveryFixture = () => ({
  api_code_version: 1,
  endpoints: {
    api: "https://origin.example.net/api",
    api_client: "https://origin.example.net/api",
    api_public: "https://origin.example.net/api",
    gateway: "wss://origin.example.net/gateway",
    media: "https://origin.example.net/media",
    upload_relay: "https://origin.example.net/media",
    static_cdn: "https://origin.example.net",
    webapp: "https://origin.example.net",
    admin: "https://origin.example.net/admin",
  },
  appPublic: { branding: { favicon_url: "https://origin.example.net/media/favicon.png" } },
});

test("only a bare HTTPS origin is accepted", () => {
  assert.equal(getConfiguredOrigin({ ORIGIN_BASE_URL: "https://origin.example.net" }).origin, upstream.origin);
  for (const value of ["http://origin.example.net", "https://user:pass@origin.example.net", "https://origin.example.net/api", "not a URL"]) {
    assert.throws(() => getConfiguredOrigin({ ORIGIN_BASE_URL: value }), ProxyConfigError);
  }
});

test("Discovery endpoint URLs are mapped to the Worker host, retaining their paths", () => {
  const result = rewriteDiscoveryDocument(discoveryFixture(), upstream, publicOrigin, true);
  assert.equal(result.endpoints.api_client, "https://test-proxy.workers.dev/api");
  assert.equal(result.endpoints.gateway, "wss://test-proxy.workers.dev/gateway");
  assert.equal(result.endpoints.media, "https://test-proxy.workers.dev/media");
  assert.equal(result.endpoints.static_cdn, "https://test-proxy.workers.dev");
  assert.equal(result.appPublic.branding.favicon_url, "https://test-proxy.workers.dev/media/favicon.png");
});

test("Discovery accepts public Worker endpoints already configured by the instance", () => {
  const fixture = discoveryFixture();
  for (const key of Object.keys(fixture.endpoints)) {
    const old = fixture.endpoints[key];
    const url = new URL(old);
    url.host = publicOrigin.host;
    fixture.endpoints[key] = url.toString().replace(/\/$/, "");
  }
  assert.doesNotThrow(() => rewriteDiscoveryDocument(fixture, upstream, publicOrigin, true));
});

test("strict Discovery mode rejects separate API/CDN/Gateway hosts", () => {
  const fixture = discoveryFixture();
  fixture.endpoints.media = "https://media.other.example";
  assert.throws(() => rewriteDiscoveryDocument(fixture, upstream, publicOrigin, true), MultiOriginError);
  assert.equal(
    rewriteDiscoveryDocument(fixture, upstream, publicOrigin, false).endpoints.media,
    "https://media.other.example",
  );
});

test("HTML gets the official same-origin API marker exactly once", () => {
  const html = "<!doctype html><html><head><title>Fluxer</title></head><body></body></html>";
  const once = addSameOriginApiMeta(html);
  assert.match(once, /<meta name="fluxer-api-origin" content="self">/);
  assert.equal(addSameOriginApiMeta(once), once);
});

test("redirects on the upstream host stay on the public Worker; external redirects remain unchanged", () => {
  assert.equal(
    mapSameOriginLocation("https://origin.example.net/login?next=%2Fapp", upstream, publicOrigin),
    "https://test-proxy.workers.dev/login?next=%2Fapp",
  );
  assert.equal(
    mapSameOriginLocation("https://accounts.example.org/continue", upstream, publicOrigin),
    "https://accounts.example.org/continue",
  );
});

test("gateway gets secure WebSocket scheme and third-party endpoints are not mapped", () => {
  assert.equal(mapEndpointToWorker("wss://origin.example.net/gateway", "gateway", upstream, publicOrigin), "wss://test-proxy.workers.dev/gateway");
  assert.equal(mapEndpointToWorker("https://cdn.other.example", "static_cdn", upstream, publicOrigin), null);
});

test("Worker streams ordinary requests and preserves method, path, query, Origin and Authorization", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  try {
    const request = new Request("https://test-proxy.workers.dev/api/v1/probe?q=a%2Fb", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer unit-test-token",
        origin: "https://test-proxy.workers.dev",
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({ probe: true }),
    });
    const response = await worker.fetch(request, { ORIGIN_BASE_URL: "https://origin.example.net" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(seen.url, "https://origin.example.net/api/v1/probe?q=a%2Fb");
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers.get("origin"), "https://test-proxy.workers.dev");
    assert.equal(seen.headers.get("authorization"), "Bearer unit-test-token");
    assert.equal(seen.headers.get("x-forwarded-for"), null);
    assert.deepEqual(JSON.parse(await seen.text()), { probe: true });
  } finally { globalThis.fetch = originalFetch; }
});

test("Worker maps Discovery and inserts the same-origin marker in HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/fluxer") {
      return new Response(JSON.stringify(discoveryFixture()), { headers: { "content-type": "application/json", etag: '"origin"' } });
    }
    return new Response('<!doctype html><html><head><title>Fluxer</title></head><body><script src="https://origin.example.net/assets/app.js"></script></body></html>', {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": "150", etag: '"shell"' },
    });
  };
  try {
    const env = { ORIGIN_BASE_URL: "https://origin.example.net", ENABLE_SAME_ORIGIN_BOOTSTRAP: "true", REQUIRE_SINGLE_ORIGIN: "true" };
    const discovery = await worker.fetch(new Request("https://test-proxy.workers.dev/.well-known/fluxer"), env);
    assert.equal(discovery.status, 200);
    const json = await discovery.json();
    assert.equal(json.endpoints.api_client, "https://test-proxy.workers.dev/api");
    assert.equal(json.endpoints.gateway, "wss://test-proxy.workers.dev/gateway");

    const html = await worker.fetch(new Request("https://test-proxy.workers.dev/app"), env);
    const body = await html.text();
    assert.equal(html.status, 200);
    assert.match(body, /<meta name="fluxer-api-origin" content="self">/);
    assert.match(body, /https:\/\/test-proxy\.workers\.dev\/assets\/app\.js/);
    assert.equal(html.headers.get("etag"), null);
    assert.equal(html.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = originalFetch; }
});

test("Worker leaves partial Range responses untransformed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("partial html", {
    status: 206,
    headers: { "content-type": "text/html", "content-range": "bytes 0-11/100" },
  });
  try {
    const request = new Request("https://test-proxy.workers.dev/app", { headers: { range: "bytes=0-11" } });
    const response = await worker.fetch(request, {
      ORIGIN_BASE_URL: "https://origin.example.net",
      ENABLE_SAME_ORIGIN_BOOTSTRAP: "true",
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-11/100");
    assert.equal(await response.text(), "partial html");
  } finally { globalThis.fetch = originalFetch; }
});

test("Worker returns a sanitized 502 when upstream fetch fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private upstream hostname and token"); };
  try {
    const response = await worker.fetch(new Request("https://test-proxy.workers.dev/app"), {
      ORIGIN_BASE_URL: "https://origin.example.net",
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(body, /UPSTREAM_CONNECTION_FAILED/);
    assert.doesNotMatch(body, /private upstream hostname|token/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Worker fails closed for multi-host Discovery and self-referential upstream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    endpoints: { api: "https://origin.example.net/api", api_client: "https://origin.example.net/api", api_public: "https://origin.example.net/api", gateway: "wss://origin.example.net/gateway", media: "https://media.example.net", upload_relay: "https://origin.example.net/media", static_cdn: "https://origin.example.net" },
  }), { headers: { "content-type": "application/json" } });
  try {
    const env = { ORIGIN_BASE_URL: "https://origin.example.net", REQUIRE_SINGLE_ORIGIN: "true" };
    const response = await worker.fetch(new Request("https://test-proxy.workers.dev/.well-known/fluxer"), env);
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error, "MULTI_ORIGIN_UNSUPPORTED");
    const loop = await worker.fetch(new Request("https://origin.example.net/app"), env);
    assert.equal(loop.status, 500);
    assert.equal((await loop.json()).error, "ORIGIN_LOOP");
  } finally { globalThis.fetch = originalFetch; }
});
