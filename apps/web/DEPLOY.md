# Deploying the ScanList web app (Track C)

The web app is a **FastAPI server** (`apps/web/server`) that serves the built frontend and the
embedding + Open Food Facts API. The phone opens the page in its browser and does camera, barcode
and OCR work client-side.

## Why HTTPS is not optional

`getUserMedia()` — the phone camera — only exists in a **secure context**: `https://` or the literal
`http://localhost`. Over plain `http://192.168.x.x:8000` the browser does not error, it simply
leaves `navigator.mediaDevices` **undefined**, so the scan screen can never start. There is no
workaround from JS. Every URL a phone will open must therefore be TLS.

Two ways to get a trusted certificate without touching the router or buying a domain:

| Front | Certificate | Works when | Used by `run.sh` when |
|---|---|---|---|
| `tailscale serve` | real Let's Encrypt cert for `<machine>.<tailnet>.ts.net` | phone and laptop are in the same tailnet | preferred (`--tls auto`) |
| Caddy | its own local CA (`tls internal`) or ACME for a real domain | tailscale is not an option | fallback (`--tls auto` after tailscale fails) |

## One command: `apps/web/run.sh`

```bash
apps/web/run.sh            # build frontend if present, start server, expose over HTTPS
apps/web/run.sh --status   # what is running, the URL, health code
apps/web/run.sh --stop     # tear down exactly what this script started
```

It builds `apps/web/frontend` when that directory exists (`npm ci`/`npm install` + `npm run build`,
skipped with `--skip-build`), creates `apps/web/server/.venv` if missing, starts uvicorn, sets up the
TLS front, verifies `GET /health` **over HTTPS**, prints the phone URL, and exits non-zero if any
step fails. Card C2 has not landed yet, so today it prints `no .../frontend yet — skipping build`
and `/` serves the JSON info document — the HTTPS and server parts are already real.

Options (`SCANLIST_WEB_*` env vars do the same):

```
--port N         uvicorn port              (default 8000,  SCANLIST_WEB_PORT)
--https-port N   TLS port for serve        (default 8444,  SCANLIST_WEB_HTTPS_PORT)
--tls MODE       auto|tailscale|caddy|none (default auto,  SCANLIST_WEB_TLS)
--reload         uvicorn --reload (dev)
--skip-build     do not run npm run build
```

`--tls none` gives plain HTTP on `127.0.0.1` only: fine for `pytest`/curl, **useless for the
camera**.

### What "idempotent" means here

Running it twice is safe: the second run stops the processes the first one started (uvicorn, caddy,
and its own `tailscale serve` mapping) and starts fresh ones. PIDs live in
`/tmp/scanlist-web-<hash of the checkout path>/` — one run dir **per checkout**, so several
worktrees can run side by side. Nothing is pattern-matched or killed by name; `--stop` signals
individual PIDs it wrote itself and leaves every other process and every other tailscale serve
mapping alone. Logs: `$RUN_DIR/server.log`.

## Laptop (this machine) — the supported path

Prerequisites, all already satisfied here: `tailscale` logged in, MagicDNS + HTTPS certificates
enabled for the tailnet (`tailscale cert <name>` must not ask for anything), `python3 -m venv`,
`node`/`npm` once the frontend lands.

```bash
tailscale status                      # must show this machine, not "stopped"
apps/web/run.sh
```

Real output:

```
==> no .../apps/web/frontend yet — skipping build (card C2 has not landed)
  ok server venv ready (fastapi 0.163.1)
==> starting uvicorn on http://127.0.0.1:8000
  ok server healthy (pid 4086285)
==> exposing via tailscale serve: https:8444 -> http://127.0.0.1:8000
  ok tailscale serve mapping active
==> verifying https://martin-lenovo.tyrannosaurus-bellatrix.ts.net:8444
  ok HTTPS /health -> 200
  cert: subject=CN=martin-lenovo.tyrannosaurus-bellatrix.ts.net
  cert: issuer=C=US, O=Let's Encrypt, CN=YE2
  ok / returns the JSON info document over HTTPS
==> ready
  HTTPS : https://martin-lenovo.tyrannosaurus-bellatrix.ts.net:8444   <-- open this on the phone
```

Open that URL on the phone (same tailnet, Tailscale app running) and the camera prompt appears.
`https://…:8443` is Tailscale's alternative HTTPS port; `:8444` is used here so the script's mapping
never collides with `tailscale serve` entries someone else made on this machine. The uvicorn port
itself stays on loopback — tailscaled proxies to it, so nothing is exposed on the LAN.

Verify by hand:

```bash
URL=https://$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):8444
curl -s -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' "$URL/health"   # -> 200 0
curl -s "$URL/health"
echo | openssl s_client -connect "${URL#https://}" -servername "${URL#https://%%:*}" 2>/dev/null | openssl x509 -noout -subject -issuer
```

Stop everything with `apps/web/run.sh --stop`; `--status` re-prints the URL from the recorded
state.

### Caddy fallback

`apps/web/run.sh --tls caddy` writes `/tmp/scanlist-web-<hash>/Caddyfile`:

```
https://$(hostname).local:8444 {
	tls internal
	reverse_proxy http://127.0.0.1:8000
}
```

Two caveats, which is why tailscale is preferred: `tls internal` means **your own CA**, and the
phone must trust it (`http://<laptop>:8444` once to fetch the root, or install Caddy's
`root.crt`) or `getUserMedia` stays blocked with a certificate warning; and `.local` needs mDNS to
resolve. Caddy is not installed on this laptop (no sudo installs per `AGENTS.md` — drop a static
binary into `~/.local/bin` if you need it). With a real domain pointed at the laptop it becomes a
normal ACME setup: replace the site address with `scanlist.example.com`.

## Oracle production — documentation only

**Do not touch the existing containers on the Oracle box.** This section describes how the web app
*would* be deployed there once the tracks are compared; nothing here has been applied, and C6
deliberately changed no infrastructure.

Differences from the laptop:

- the server binds on the host and the TLS front terminates on a **public hostname with ACME**
  (Caddy `https://scanlist.example.com` or a tailscale-served name if it stays tailnet-only);
- the process needs real weights: `SCANLIST_EMBEDDER=gemma` (card C3) with the model weights
  mounted read-only from outside git (`~/models/scanlist/`), not the `fake` default;
- the embedding step is CPU-heavy on the server, so uvicorn gets a small worker count and the
  `/embed/*` handlers must not block the event loop (card C3 moves them to `anyio.to_thread`).

A deployment that matches the script's contract would be one container for uvicorn plus one
Caddy, e.g.:

```yaml
# docker-compose.yml (illustrative — NOT deployed from this card)
services:
  web:
    build: ./apps/web/server            # python:3.12-slim + requirements.txt
    command: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
    environment:
      SCANLIST_EMBEDDER: gemma
      SCANLIST_DIMS: "256"
    volumes:
      - /home/ubuntu/models/scanlist:/models:ro
    restart: unless-stopped
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    restart: unless-stopped
volumes:
  caddy_data:
```

with `Caddyfile` = `scanlist.example.com { reverse_proxy web:8000 }` (Caddy gets the Let's Encrypt
cert itself; no `tls internal` in production).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `navigator.mediaDevices` undefined on the phone | page opened over `http://` or on an untrusted cert | use the printed `https://…ts.net` URL; `run.sh --status` shows it |
| certificate prompt / warning in the phone browser | tailnet has HTTPS/MagicDNS off, or you are on the caddy fallback | enable HTTPS certificates for the tailnet; or trust Caddy's root |
| `first request may wait for certificate issuance` then a timeout | Let's Encrypt rate limit or the tailnet name is not served | `tailscale cert <name>` and read `$RUN_DIR/server.log` |
| `port 8000 is already in use by something this script did not start` | another checkout's server | `--port 8001`, or stop that one by its PID |
| `no TLS front available` | neither tailscale nor caddy usable | `tailscale up`, or install caddy, or `--tls none` for API-only work |
| `/` shows `"frontend": "not built"` | `apps/web/frontend` has no `dist` yet (card C2) | expected until C2 lands; API works |
| `/off/{barcode}` returns 502 | openfoodfacts.org unreachable | retry; misses are cached 1 day, hits 30 days |
