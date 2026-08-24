# Independent self-hosted production deployment

This directory packages the upstream World Monitor application as an isolated
Compose project. It does not join or modify any TradingAgents or finance-monitor
container, network, volume, port, or reverse-proxy configuration.

## Security and ingress model

- Only the application liveness endpoint is published on server loopback
  (`127.0.0.1:18100` by default).
- Redis, the REST adapter, relay, seeder, and login gateway are internal-only.
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

## Bootstrap

From this directory on the server:

```sh
cp .env.production.example .env.production
chmod 600 .env.production
mkdir -p shared/auth runtime
chmod 700 shared shared/auth runtime
```

Generate the four required random values in `.env.production`. The validator
rejects public placeholders and values shorter than 32 characters. Generate a
long, random login password, write its APR1 hash as
`investor:<hash>` to `shared/auth/worldmonitor.htpasswd`, and store the one-time
plaintext credential in `shared/auth/login-bootstrap.txt`; both files must be
mode 600. Never commit either file.

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
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
```

An unauthenticated request to the public URL must return `401`; an authenticated
request must return `200`. Data-source truth must be judged from the compact
health verdict, seed metadata timestamps, record counts, and source-specific
errors—not from a successful dashboard render alone.

## Release and rollback

Deploy immutable source trees under `/home/qnyx/releases/worldmonitor-<sha>`.
Keep `/home/qnyx/worldmonitor-current` and `/home/qnyx/worldmonitor-previous` as
symlinks. Store mutable auth/runtime state under
`/home/qnyx/worldmonitor-shared` and bind or symlink it into each release.

To roll back, validate that `worldmonitor-previous` resolves to an existing
release, stop the current project, point `worldmonitor-current` to the previous
release, and run that release's `deploy.sh`. The named Redis volume is preserved.
