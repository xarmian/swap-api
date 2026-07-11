# Deploying swap-api (Docker + nginx-proxy)

swap-api runs as a single stateless container behind the server's existing
**nginx-proxy + acme-companion** stack, which handles routing and Let's Encrypt TLS.

## First-time setup (on the server)

1. Clone the repo and check out `main`:
   ```bash
   git clone https://github.com/xarmian/swap-api.git
   cd swap-api
   git checkout main
   ```
2. Create `.env` from the template and fill it in:
   ```bash
   cp .env.example .env
   # edit .env — at minimum VIRTUAL_HOST, LETSENCRYPT_HOST, LETSENCRYPT_EMAIL
   ```
3. Confirm the proxy network exists (it does if the nginx-proxy stack is running):
   ```bash
   docker network ls | grep nginx-proxy_nginx-proxy
   ```
   If the name differs on this host, update `networks.nginx-proxy.name` in
   `docker-compose.yml` to match.
4. Bring it up:
   ```bash
   docker compose up -d --build
   ```

nginx-proxy picks up the container automatically (via `VIRTUAL_HOST` / `VIRTUAL_PORT`),
and acme-companion issues the certificate for `LETSENCRYPT_HOST`. First cert issuance
takes a minute or two.

## Updating to the latest `main`

```bash
git pull && docker compose up -d --build
```

This rebuilds the image from the current checkout and recreates the container with zero
config changes. (Production currently still runs on Vercel off the `multi-hop-routing`
branch; cut DNS/traffic over to this host when ready.)

## Operating

```bash
docker compose logs -f swap-api      # tail logs
docker compose ps                    # status + health
docker compose restart swap-api      # restart without rebuild
docker compose down                  # stop & remove the container
docker compose exec swap-api node -e "require('http').get('http://127.0.0.1:3000/health',r=>r.pipe(process.stdout))"  # probe /health from inside the container
```

## Notes

- **No published host port.** The container is reachable only over the shared
  `nginx-proxy` network, so nothing bypasses TLS. Check health with `docker compose ps`, or
  probe `/health` from inside the container via `docker compose exec` (above); externally it
  is reachable only through the proxied HTTPS hostname.
- **Boot latency.** On start the app discovers all configured pools in parallel (bounded
  concurrency, `DISCOVERY_CONCURRENCY`, default 6) before it begins serving; the container
  is marked healthy only after that completes (the `HEALTHCHECK` `start-period` allows
  ~40s). A warm restart (`docker compose restart`, no rebuild) skips discovery entirely if
  a complete prior snapshot is cached in the container's `/tmp`. Unlike the
  Vercel/serverless deployment, this discovery happens **once per container** rather than
  per cold start, and the in-memory pool/token cache then persists for the container's
  lifetime.
- **Partial discovery.** If fewer than `DISCOVERY_MIN_SUCCESS_RATIO` (default 70%) of
  configured pools discover successfully, startup fails loudly (the container never
  becomes healthy) instead of serving an incomplete pool set. Above that threshold, the
  missing pools are retried lazily (every `DISCOVERY_RETRY_TTL_MS`, default 2 minutes) on
  request traffic, and are visible in `GET /health` (`status: "degraded"`) and
  `GET /config/pools` (`discovery.failedPools`) until they recover.
- **Secrets.** `.env` is gitignored and never enters the image (`.dockerignore` excludes
  it); config is injected at runtime by docker-compose.
- **Config source of truth.** Pools are discovered on-chain at boot from
  `config/pool-ids.json` (baked into the image); redeploy after changing it.
