# Fluxer self-host edge proxy for Cloudflare Workers

This repository contains a **single-public-origin reverse proxy** for a Fluxer instance that you administer or are explicitly authorized to proxy. It is aimed at a self-hosted Fluxer deployment configured to advertise the Worker's public hostname for its services. It is not a proxy for the hosted `fluxer.app` service, and it is not a Worker-hosted Fluxer backend.

The Worker forwards each requested path and query to one fixed HTTPS upstream. It never chooses a destination from a request parameter. The optional bootstrap transform rewrites the public Fluxer Discovery document and HTML shell so the browser uses the Worker's origin for same-origin APIs. Strict mode returns `501 MULTI_ORIGIN_UNSUPPORTED` if a required API, Gateway, media, upload, or static endpoint is on a different host. This deliberately prevents a misleading partial result from being presented as a complete app proxy.

## What changed based on official source inspection

The Fluxer web client obtains an instance snapshot from its Discovery document. In the current official client source, the service worker fetches `/api/.well-known/fluxer`; the client also probes the documented root and conventional API discovery locations. `InstanceSnapshotStore` recognizes the HTML marker `<meta name="fluxer-api-origin" content="self">` and uses the document origin plus `/api` for the API when the discovery endpoint agrees. The official `fluxer_app_proxy` inserts this marker in the SPA document.

The official self-host configuration derives these endpoints from the public domain by default: API `/api`, Gateway `/gateway`, media `/media`, app `/`, and admin `/admin`. The official Caddyfile routes `/api/*`, `/gateway`, `/gateway/*`, `/media/*`, `/livekit/*`, static paths, and the SPA to their respective Fluxer services. Its config loader also exposes `FLUXER_PUBLIC_ORIGIN` and endpoint overrides. This is the supported configuration model on which the Worker design relies; it does not rewrite arbitrary application JavaScript or disable CSP.

Sources are linked under [Official references](#official-references). This project does not copy Fluxer application code. Fluxer itself is AGPL-3.0-or-later; follow its license if you modify or redistribute Fluxer components.

## Request flow

```text
Browser at https://<worker>.workers.dev
                 │ HTTPS / WSS, original user credentials pass through
                 ▼
Cloudflare Worker (this repository)
  - fixed ORIGIN_BASE_URL; no open-proxy target
  - preserves paths, query, methods, bodies and streamed responses
  - optionally maps Discovery endpoints to the public Worker origin
                 │ HTTPS / WebSocket Upgrade
                 ▼
Authorized Fluxer self-host edge/Caddy or HTTPS Tunnel origin
  ├── /api/*       → API
  ├── /gateway     → Gateway WebSocket
  ├── /media/*     → Media Proxy
  ├── /livekit/*   → LiveKit signalling (WS/TLS only through Worker)
  ├── /assets/*    → app proxy/static assets
  ├── /avatars/*, /badges/*, /emoji/*, /web/* → static service
  └── other paths  → Fluxer SPA/app proxy
```

The Worker handles only HTTP(S) and HTTP Upgrade WebSockets. Voice/video media is WebRTC/ICE traffic and is not carried by this Worker. A successful Gateway or LiveKit signalling WebSocket test does not prove the media path works.

## Repository layout

```text
.
├── package.json
├── package-lock.json
├── wrangler.toml
├── README.md
├── src/index.js
├── test/proxy.test.js
└── scripts/smoke.mjs
```

## Configuration prerequisites

You need all of the following before deployment:

1. A Fluxer instance you administer, or documented permission to proxy it. The upstream must be reachable by Cloudflare Workers over HTTPS. It can be a TLS-enabled reverse proxy or a Cloudflare Tunnel hostname that routes to the instance.
2. Keep two hostnames distinct: `ORIGIN_BASE_URL` is the HTTPS **transport hostname** that Caddy/Tunnel serves to the Worker; `FLUXER_PUBLIC_ORIGIN` is the browser-visible `https://<worker>.workers.dev`. Caddy routes by HTTP `Host`, which this Worker correctly leaves as the transport hostname. Set the self-host's `FLUXER_EDGE_SITE_ADDRESS` to the transport hostname (including scheme if required by the deployed version), and configure its application public origin as the Worker URL. This prevents a Host mismatch while preserving the real browser Origin.
3. The instance's **public** endpoints must be the Worker URL, not the transport hostname. Setting `FLUXER_PUBLIC_ORIGIN=https://<worker>.workers.dev` derives the usual one-host endpoint layout: app `/`, API `/api`, Gateway `/gateway`, media `/media`, and static CDN at the public origin. Leave `FLUXER_STATIC_CDN_DOMAIN`, `FLUXER_INVITE_DOMAIN` and `FLUXER_GIFT_DOMAIN` empty unless you have deliberately implemented additional routing; they otherwise create other authorities and strict mode rejects them. The supported endpoint override environment names include `FLUXER_API_CLIENT_ENDPOINT`, `FLUXER_GATEWAY_ENDPOINT`, `FLUXER_MEDIA_ENDPOINT`, and `FLUXER_STATIC_CDN_ENDPOINT`; use them only when necessary and verify the result in the instance's own `/.well-known/fluxer`. Avoid setting the static CDN override in the app-proxy container unless its asset configuration is known to serve locally; the app-proxy may itself fetch that endpoint when assets are not bundled.
4. The instance must accept `Origin: https://<worker>.workers.dev` where it validates browser origins. This Worker passes the browser's actual `Origin` unchanged. It does not spoof `Origin`/`Referer`, grant access, or bypass the origin's allowlist.
5. The origin must not redirect the browser away to another public hostname for core app/API/Gateway flows. Same-upstream absolute HTTP `Location` values are mapped back to the Worker; external redirects remain external.
6. Never point `ORIGIN_BASE_URL` at the Worker public URL; the code rejects an exact self-loop.

For the requested hosted Origin specifically, the live Discovery response checked on 2026-11-03 lists `https://web.fluxer.app/api` for `api`/`api_client`, but lists `https://fluxer.com` as `webapp`; it separately lists the Gateway, media, upload relay, static CDN, admin, invite, gift, and voice hosts. The `web.fluxer.app` hostname is therefore an API base, not a complete single-origin web-app backend. A fixed path proxy to that one host cannot provide the app plus all its services. The observed Discovery also fails this repository's strict single-origin validation by design. The hosted app shell was observed at `https://fluxer.com/app`, with static asset references to `fluxerstatic.com`.

The Discovery endpoint values returned at that check were `api`/`api_client=https://web.fluxer.app/api`, `api_public=https://fluxer.com/api`, `gateway=wss://gateway.fluxer.com`, `media=https://fluxerusercontent.com`, `upload_relay=https://uploads.fluxer.app`, `static_cdn=https://fluxerstatic.com`, `marketing/webapp=https://fluxer.com`, `admin=https://admin.fluxer.app`, `invite=https://fluxer.gg`, `gift=https://fluxer.gift`, and `voice_origins=["wss://*.fluxer.media"]`. Treat these as an observed snapshot, not a stable contract; use the target instance's live Discovery document.

Fluxer's Terms say they cover the official service, while an instance hosted by someone else runs under that operator's terms. I found no blanket grant in those Terms authorizing a third party to re-publish the official hosted service through a proxy; use an instance you administer or obtain explicit permission. This is a conservative scope boundary, not a claim that the Terms expressly prohibit every proxy.

## Configure the Worker

1. Replace the placeholder origin in `wrangler.toml` with the bare HTTPS transport origin reachable by this Worker and served by the matching edge/Caddy virtual host. Do not include credentials, path, query, fragment or token.

   ```toml
   [vars]
   ORIGIN_BASE_URL = "https://origin-edge.example.net"
   ENABLE_SAME_ORIGIN_BOOTSTRAP = "true"
   REQUIRE_SINGLE_ORIGIN = "true"
   ```

2. Install Node.js 20+ and deploy:

   ```sh
   npm ci
   npm run check
   npm test
   npx wrangler deploy --dry-run
   npx wrangler login
   npx wrangler deploy
   ```

3. Wrangler prints the HTTPS `workers.dev` URL. Configure the self-host instance's public endpoint settings to that exact URL, restart/reload its services as required by its version, then read its public Discovery endpoint again. Do not merely set a browser-visible URL if the backend still generates origin-domain asset/media URLs.

4. Validate the live mapping:

   ```sh
   BASE_URL='https://<worker>.workers.dev' npm run test:smoke
   curl -i 'https://<worker>.workers.dev/app'
   curl -i 'https://<worker>.workers.dev/.well-known/fluxer'
   curl -i 'https://<worker>.workers.dev/api/.well-known/fluxer'
   ```

   A successful `/.well-known/fluxer` response must contain `api`, `api_client`, `api_public`, `gateway`, `media`, `upload_relay`, and `static_cdn` on the Worker's public authority; Gateway must use `wss:`. The bundled smoke test checks this. If it returns 501, do not set `REQUIRE_SINGLE_ORIGIN=false` just to make the test green; configure the instance or use a topology that supports all its service hosts.

For local work, Wrangler's local server is HTTP on loopback. Override the required origin with a real, authorized HTTPS origin when running `npx wrangler dev --var ORIGIN_BASE_URL:https://origin-edge.example.net`.

## HTTP and WebSocket behavior

- The request path and raw query representation are carried to the fixed origin. HTTP method is retained. For methods other than GET and HEAD, the request body is streamed rather than buffered.
- The response body is streamed. Response status and application headers are passed through, except hop-by-hop transport headers. `Range`, `Content-Range`, `Content-Disposition`, `Cache-Control`, `Vary`, `Content-Type`, and upstream validators are not changed for ordinary responses.
- Redirect following is disabled in the Worker. Same-origin absolute `Location` values are translated to the public Worker host. External `Location` values are left unchanged. This prevents an automatic redirect loop but does not conceal a third-party redirect.
- Discovery JSON and transformed HTML are each bounded to 512 KiB, parsed/rewritten only within that limit, and endpoint-validated. Only the listed endpoint URL fields and known branding URL fields are considered. In strict mode core service URLs must be on either the upstream authority or public Worker authority. Other endpoint hosts are not blindly proxied.
- For successful HTML responses, the Worker replaces the exact configured upstream origin in the shell and inserts Fluxer's documented same-origin API meta marker. CSP itself is not weakened or rewritten. If a transformed response exceeds the bound, the Worker fails with `502 TRANSFORM_BODY_TOO_LARGE` rather than buffering an unbounded document.
- For WebSockets, it forwards the HTTP Upgrade to the same path on the fixed HTTPS origin and relays text/binary messages and close events. It does not parse or implement Fluxer Gateway opcodes, heartbeat, Identify, Resume or reconnect. Clients must implement the protocol and reconnect after edge/runtime disconnects.
- The Worker does not cache anything, so personalized API responses are not shared between users. There are no KV, D1, R2 or Durable Object bindings.

## Credential and header policy

The Worker contains no application logging and does not store credentials. Cookies and `Authorization` are forwarded as received and never exposed in error messages. Fluxer's HTTP API documentation specifies `Authorization` for authenticated operations and says browsers do not send cookies cross-origin; its Gateway Identify message carries the raw session token in the WebSocket protocol payload. This Worker does not parse, extract or persist that token. No wildcard CORS headers are added. `Host` is set by Fetch for the fixed upstream URL. Client `Forwarded`, `X-Forwarded-*` and `X-Real-IP` values are removed so they are not trusted. `Origin` and `Referer` are deliberately preserved so the origin can enforce its own policy. `Set-Cookie`, cookie Domain/SameSite/Secure/HttpOnly attributes, CSP and CORS response headers are not rewritten. A cookie scoped to the origin's hostname may not be accepted by a browser visiting `workers.dev`; confirm the instance's actual auth behavior before exposing it.

No auth secrets belong in `wrangler.toml`, URLs, smoke-test environment variables, CI output or command history. If an authorized test needs a user session, use a disposable account and a secure client that does not print the token.

## Test plan

### Automated tests

```sh
npm run check
npm test
BASE_URL='https://<worker>.workers.dev' npm run test:smoke
```

Unit tests cover HTTPS origin validation, Discovery endpoint rewrites, multi-host rejection, HTML meta insertion, same-origin redirects and WSS scheme preservation. Smoke tests cover `/app`, manifest, service worker, HEAD, query preservation and actual Discovery mapping. Optional per-instance paths can be tested without inventing an endpoint:

```sh
TEST_JSON_PATH='/<documented-safe-read-only-route>' \
TEST_RANGE_PATH='/<known-public-media-object>' \
BASE_URL='https://<worker>.workers.dev' npm run test:smoke
```

### Manual API and upload

Use the target instance's own current API reference and disposable test resources. For an explicitly documented unauthenticated read-only JSON endpoint:

```sh
curl -i 'https://<worker>.workers.dev/<documented-path>'
```

For an authorized write, use a secure client with a token read from a protected secret store, not a literal command-history value. Upload testing must follow the current instance's presigned-upload contract end-to-end; a successful `POST` to an invented `/upload` path proves nothing.

### WebSocket

For a documented gateway path/query advertised by the instance Discovery document:

```sh
npx wscat -c 'wss://<worker>.workers.dev/gateway?v=1&encoding=json'
```

For a different path, use the URL the instance actually advertises. A `101` handshake only validates transport. Full verification must use the official client/protocol and separately exercise Hello, heartbeat ACK, Identify with a test session, event dispatch, Resume and reconnect. Never put a real session token into a shell command or URL.

### Full browser checks

Use a private browser profile and DevTools Network/Console. Verify: page shell; dynamically loaded JS/CSS; SPA deep link and refresh; manifest and Service Worker control; Discovery returns Worker endpoints; API login/logout and token-based requests; media and Range downloads; upload; Gateway handshake/reconnect; browser storage/session across tabs; mobile layout; and Voice signaling plus actual WebRTC media on another network. The automated checks do not certify login or voice. Successful service signaling does not certify UDP/TURN media connectivity.

## Voice, Cloudflare Tunnel, Workers and alternatives

The official Fluxer voice guide lists TCP 80/443 for edge/signalling and TCP 7881 plus UDP 7882 for media in its default setup; it says calls connect directly to the machine's ports even behind another proxy. It separately describes TURN for networks that block direct UDP. Cloudflare Workers can relay the HTTP/WebSocket signalling paths, not arbitrary UDP media. A WebRTC call may therefore fail even when the application UI, API and Gateway are healthy.

Cloudflare Tunnel can make the HTTP origin reachable to the Worker, but it does not carry the direct UDP media traffic that Fluxer documents for calls. Calls from UDP-restricted networks need an independently reachable TURN service. For the closest supported setup, run Fluxer on a VPS, expose its required voice transports directly or via a supported TURN service, and use Caddy/Fluxer's edge as documented. A Worker can be an optional HTTP/WSS edge in front of that origin. Cloudflare Free Spectrum does not provide generic public UDP proxying; do not treat a Worker or Tunnel as a UDP tunnel.

If the self-host instance advertises a separate static CDN, media server or voice host, strict discovery returns 501. A single `workers.dev` hostname cannot transparently make those independent hosts same-origin without additional, explicitly configured endpoint routing and URL generation changes. This repository refuses that case rather than silently bypassing the Worker or weakening browser security.

## Cloudflare Free plan considerations

The official Workers limits page checked on 2026-11-03 listed Free limits of 100,000 Worker requests/day, 10 ms CPU per HTTP request, 128 MB memory per isolate and 50 subrequests per invocation. The Free account maximum request body was 100 MB; this is an account/network limit. Cloudflare does not enforce a Worker response-body size limit, but this code streams the body and buffers only the bounded HTML/Discovery transforms. Waiting on network I/O does not count toward CPU. HTTP-triggered Workers have no fixed wall-clock duration limit while the client remains connected; runtime updates or failures can still interrupt long-lived connections. Review the live official page before production because these limits can change.

A WebSocket upgrade is a request, not a request per individual frame, but long-lived sessions can disconnect. Daily quota, CPU, memory, subrequests, source upload size and upstream bandwidth all still matter. There is no generic Worker UDP socket API for LiveKit media. If Gateway traffic or connection counts exceed Free usage, or if availability requirements need Durable Objects, longer CPU allowance or other products, re-evaluate the plan and architecture rather than relying on this example's free-tier behavior.

## Troubleshooting

| Symptom | Meaning / next check |
|---|---|
| `500 PROXY_CONFIGURATION_ERROR` | `ORIGIN_BASE_URL` must be a bare HTTPS origin. |
| `500 ORIGIN_LOOP` | Upstream equals the public Worker origin; use a separate origin transport hostname/Tunnel. |
| `502 UPSTREAM_CONNECTION_FAILED` | Check origin TLS, DNS, Tunnel route, firewall and edge reachability. Detailed exceptions are intentionally not returned. |
| `502 INVALID_UPSTREAM_DISCOVERY` | The configured Discovery path did not return valid JSON; verify whether the instance serves it at root or `/api`. |
| `501 MULTI_ORIGIN_UNSUPPORTED` | A core endpoint differs from the upstream/public Worker authority. Configure supported same-origin endpoints or change architecture. Do not turn strict mode off to claim full proxy behavior. |
| 401/403/CORS failure | Origin auth/origin policy is working or misconfigured. Check allowed public Worker origin on the instance; never spoof Origin to evade policy. |
| SPA loads but API does not | Check the `/api/.well-known/fluxer` document, endpoint authority/path, HTML meta marker, then browser CSP/Network errors. |
| WS 502/close | Check Discovery Gateway URL and origin path route. A proxy handshake is not proof of Gateway protocol health; implement client reconnect/resume. |
| Voice calls fail | Check LiveKit signaling separately from UDP/TCP candidate reachability and TURN. Workers cannot proxy the RTP/WebRTC UDP media path. |
| Upload fails | Check current Discovery `upload_relay`, instance's documented presigned upload procedure, body size limit and request methods. This Worker does not invent upload routes. |
| Error 1027/1102 | Check Workers Metrics for Free daily request or CPU/memory limits. |

## Official references

- [Fluxer API documentation and endpoint discovery](https://docs.fluxer.app/)
- [Fluxer HTTP API](https://docs.fluxer.app/http-api/)
- [Fluxer Gateway overview](https://docs.fluxer.app/gateway/overview/)
- [Fluxer self-host guide](https://docs.fluxer.app/operator/)
- [Fluxer voice server guide](https://docs.fluxer.app/operator/voice-servers/)
- [Hosted Discovery response observed 2026-11-03](https://fluxer.app/.well-known/fluxer)
- [Fluxer Terms](https://fluxer.app/terms)
- [Fluxer Privacy policy](https://fluxer.app/privacy)
- [Official source: client same-origin API resolution](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/app/state/InstanceSnapshotStore.ts)
- [Official source: Service Worker fetches `/api/.well-known/fluxer`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/platform/service_worker/Worker.ts)
- [Official source: app proxy inserts same-origin marker](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app_proxy/src/routes/spa_index.rs)
- [Official source: endpoint derivation](https://github.com/fluxerapp/fluxer/blob/main/packages/config/src/EndpointDerivation.ts)
- [Official source: endpoint override environment names](https://github.com/fluxerapp/fluxer/blob/main/packages/config/src/config_loader/EnvironmentOverrides.ts)
- [Official self-host Caddy path routes](https://github.com/fluxerapp/fluxer/blob/main/fluxer_rexctl/internal/stack/files/Caddyfile)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Cloudflare Spectrum protocol availability](https://developers.cloudflare.com/spectrum/protocols-per-plan/)
