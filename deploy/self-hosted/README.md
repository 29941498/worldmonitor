# Independent self-hosted production deployment

This directory packages the upstream World Monitor application as an isolated
Compose project. It does not join or modify any TradingAgents or finance-monitor
container, network, volume, port, or reverse-proxy configuration.

## Security and ingress model

- Only the application liveness endpoint is published on server loopback
  (`127.0.0.1:18100` by default).
- Redis, the REST adapter, relay, and seeder are internal-only. The login
  gateway is internal-only in the base stack; the stable-domain override can
  publish it on one explicitly selected loopback or private address.
- Public traffic enters through a Cloudflare Quick Tunnel and is challenged by
  an Nginx Basic Auth gateway before it reaches the application. Plain HTTP is
  redirected to HTTPS before the authentication challenge, and authenticated
  HTTPS responses carry HSTS.
- Secrets, the password hash, the plaintext bootstrap credential, tunnel logs,
  and the generated public URL are ignored by Git.

Quick Tunnels are appropriate only as a temporary no-domain ingress. The URL is
random and changes whenever the `cloudflared` process restarts—including an
automatic container restart or host reboot. The stack recovers automatically,
but the old public link does not; always reread `runtime/public-url.txt`.
Cloudflare documents that Quick Tunnels have no SLA, a 200 concurrent-request limit, and no
server-sent-events support. See the official
[Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
Replace this service with a named tunnel and a domain before treating the
endpoint as durable production infrastructure.

## Stable domain ingress

`docker-compose.domain.yml` switches ingress from the temporary Quick Tunnel to
an operator-managed HTTPS reverse proxy. It publishes only `auth-proxy`; the
application liveness port, Redis, REST adapter, AIS relay, and seeders retain
their base-stack exposure. The bind defaults to `127.0.0.1:18101`.

When the reverse proxy is on another trusted host, set `WM_AUTH_BIND_IP` to the
World Monitor server's private interface and keep that port off the public
router. For the LemonBus deployment, the checked-in Nginx configuration proxies
`wm.lemonbus.cn` to `192.168.10.30:18101`, preserves WebSocket upgrades and the
original client chain, redirects HTTP to HTTPS, and uses the dedicated
`wm.lemonbus.cn` certificate.

Run the same immutable release deployment with the override enabled:

```sh
export WM_COMPOSE_OVERRIDE_FILE="$PWD/docker-compose.domain.yml"
./scripts/deploy.sh
```

The override puts `quick-tunnel` behind the opt-in `quick-tunnel` profile, so a
normal stable-domain deployment does not recreate the temporary public URL. To
bring it back during an ingress rollback, use both the override and
`--profile quick-tunnel` with Docker Compose, or deploy the base stack without
the override.

Install `nginx/wm.lemonbus.cn.conf` on the HTTPS gateway only after verifying
the certificate/key pair and private upstream reachability. Always run
`nginx -t` before reloading Nginx.

## Independent outbound proxy

`docker-compose.egress.yml` adds a World Monitor-owned outbound proxy on the
private Compose network. It publishes no host port. The application, AIS relay,
and seeders use it for external HTTP(S) requests while `NO_PROXY` keeps Redis,
the relay, the auth gateway, and other internal traffic local.

The proxy image and JSON configuration are host-provisioned inputs. Keep the
configuration outside release directories, mode 600, and never commit it. The
deployment validator checks that the file is private and contains both Xray
inbound and outbound sections. Enable both production overrides for the stable
domain deployment:

```sh
export WM_COMPOSE_OVERRIDE_FILE="$PWD/docker-compose.domain.yml"
export WM_COMPOSE_EGRESS_FILE="$PWD/docker-compose.egress.yml"
./scripts/deploy.sh
```

The proxy restores sources that are otherwise unreachable from the host, but it
does not replace provider API keys. A source can also remain unavailable when
its upstream blocks the selected proxy route; judge readiness from the health
payload and seeder evidence after each release.

## Offline registry build fallback

Every Dockerfile pins its base image directly to an immutable digest. If the
host cannot reach Docker Hub but already has the audited linux/amd64 Node image,
set `WM_NODE_BUILD_CONTEXT` to that local image reference including its platform
manifest digest. `deploy.sh` accepts only the exact digest corresponding to the
pinned Node image, substitutes it through a BuildKit named context, and still
builds the checked-in Dockerfiles unchanged. A mutable tag or a different image
digest fails before the build starts.

## Bootstrap

From this directory on the server:

```sh
cp .env.production.example .env.production
chmod 600 .env.production
mkdir -p shared/auth shared/egress runtime
chmod 700 shared shared/auth shared/egress runtime
chmod 600 shared/egress/xray-config.json
```

Generate the five required random values in `.env.production`. The validator
rejects public placeholders and values shorter than 32 characters. Generate a
long, random login password, write its APR1 hash as
`investor:<hash>` to `shared/auth/worldmonitor.htpasswd`, and store the one-time
plaintext credential in `shared/auth/login-bootstrap.txt`; both files must be
mode 600. Never commit either file.

`WM_AUTH_COOKIE_SECRET` must be a 64-character lowercase hexadecimal value
(for example, from `openssl rand -hex 32`). The login gateway uses it only for
a Secure, HttpOnly, browser-session cookie after Basic Auth succeeds so the
dashboard service worker can authenticate same-origin API requests.

Release directories must be named `worldmonitor-<git-sha>`; `deploy.sh` derives
immutable image tags from that suffix so rolling back cannot overwrite the newer
release image. Run:

```sh
./scripts/deploy.sh
```

Read the current URL and credential only over SSH:

```sh
cat runtime/public-url.txt
cat shared/auth/login-bootstrap.txt
```

## Verification

```sh
docker compose --env-file .env.production -f docker-compose.production.yml ps
curl --fail http://127.0.0.1:18100/api/sidecar-health
curl --fail 'http://127.0.0.1:18100/api/health?compact=1'
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 seeders
docker compose --env-file .env.production -f docker-compose.production.yml -f docker-compose.egress.yml exec -T seeders node -e "fetch('https://api.coingecko.com/api/v3/ping').then(r => { if (!r.ok) process.exit(1); console.log(r.status); })"
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
```

An unauthenticated request to the public URL must return `401`; an authenticated
request must return `200`. Data-source truth must be judged from the compact
health verdict, seed metadata timestamps, record counts, and source-specific
errors—not from a successful dashboard render alone.

For the stable domain, also verify strict certificate validation, the HTTP to
HTTPS redirect, anonymous `401`, authenticated HTML and API responses, HSTS,
Secure/HttpOnly/SameSite cookies, WebSocket/long-request proxy behavior, and
that the private auth port cannot be reached through the public router.

## Release and rollback

Deploy immutable source trees under `/home/qnyx/releases/worldmonitor-<sha>`.
Keep `/home/qnyx/worldmonitor-current` and `/home/qnyx/worldmonitor-previous` as
symlinks. Store mutable auth/runtime state under
`/home/qnyx/worldmonitor-shared` and bind or symlink it into each release.

Use the same `WM_COMPOSE_OVERRIDE_FILE` and `WM_COMPOSE_EGRESS_FILE` values for
every stable-domain release and rollback. Omitting the domain override
intentionally returns to the base Quick Tunnel mode; omitting the egress
override disables the independent outbound route.

To roll back, validate that `worldmonitor-previous` resolves to an existing
release, stop the current project, point `worldmonitor-current` to the previous
release, and run that release's `deploy.sh`. The named Redis volume is preserved.
