import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const composePath = new URL('../deploy/self-hosted/docker-compose.production.yml', import.meta.url);
const domainComposePath = new URL('../deploy/self-hosted/docker-compose.domain.yml', import.meta.url);
const egressComposePath = new URL('../deploy/self-hosted/docker-compose.egress.yml', import.meta.url);
const proxyPath = new URL('../deploy/self-hosted/nginx/auth-proxy.conf', import.meta.url);
const domainNginxPath = new URL('../deploy/self-hosted/nginx/wm.lemonbus.cn.conf', import.meta.url);
const ignorePath = new URL('../.gitignore', import.meta.url);
const dockerIgnorePath = new URL('../.dockerignore', import.meta.url);
const validatorPath = new URL('../deploy/self-hosted/scripts/validate-env.sh', import.meta.url);
const envExamplePath = new URL('../deploy/self-hosted/.env.production.example', import.meta.url);
const deployScriptPath = new URL('../deploy/self-hosted/scripts/deploy.sh', import.meta.url);
const authEntrypointPath = new URL('../deploy/self-hosted/scripts/auth-proxy-entrypoint.sh', import.meta.url);
const authDockerfilePath = new URL('../deploy/self-hosted/Dockerfile.auth-proxy', import.meta.url);
const appDockerfilePath = new URL('../Dockerfile', import.meta.url);

test('production compose exposes only the loopback health port', async () => {
  const compose = await readFile(composePath, 'utf8');
  const portLines = compose.split('\n').filter((line) => /^\s+- ["']?.*:\d+/.test(line));

  assert.deepEqual(portLines, ['      - "127.0.0.1:${WM_LOCAL_HEALTH_PORT:-18100}:8080"']);
  assert.match(compose, /WM_TUNNEL_ORIGIN: http:\/\/auth-proxy:8080/);
  assert.match(compose, /VITE_SELF_HOSTED_LOGIN_GATEWAY: "true"/);
  assert.match(compose, /subnet: 172\.31\.28\.0\/24/);
});

test('stable-domain override publishes only the authenticated gateway', async () => {
  const compose = await readFile(domainComposePath, 'utf8');
  const envExample = await readFile(envExamplePath, 'utf8');

  assert.match(compose, /auth-proxy:[\s\S]*"\$\{WM_AUTH_BIND_IP:-127\.0\.0\.1\}:\$\{WM_AUTH_PORT:-18101\}:8080"/);
  assert.match(compose, /quick-tunnel:[\s\S]*profiles:[\s\S]*- quick-tunnel/);
  assert.match(envExample, /^WM_AUTH_BIND_IP=127\.0\.0\.1$/m);
  assert.match(envExample, /^WM_AUTH_PORT=18101$/m);
  assert.doesNotMatch(compose, /redis-rest:[\s\S]*ports:/);
});

test('egress override keeps the proxy private and applies it to external-fetch services', async () => {
  const compose = await readFile(egressComposePath, 'utf8');
  const envExample = await readFile(envExamplePath, 'utf8');

  assert.match(compose, /^  egress-proxy:\n/m);
  assert.match(compose, /egress-proxy:[\s\S]*user: "\$\{WM_RUNTIME_UID:-1000\}:\$\{WM_RUNTIME_GID:-1000\}"/);
  assert.match(compose, /egress-proxy:[\s\S]*restart: unless-stopped/);
  assert.match(compose, /egress-proxy:[\s\S]*read_only: true/);
  assert.match(compose, /egress-proxy:[\s\S]*cap_drop:[\s\S]*- ALL/);
  assert.match(compose, /source: "\$\{WM_EGRESS_PROXY_CONFIG:\?[^}]+\}"/);
  assert.match(compose, /target: \/etc\/xray\/config\.json[\s\S]*read_only: true/);
  assert.match(compose, /test: \["CMD", "\/usr\/local\/bin\/xray", "run", "-test", "-c", "\/etc\/xray\/config\.json"\]/);
  assert.doesNotMatch(compose, /egress-proxy:[\s\S]*ports:/);

  for (const service of ['worldmonitor', 'ais-relay', 'seeders']) {
    assert.match(compose, new RegExp(`^  ${service}:\\n[\\s\\S]*?<<: \\*egress-environment`, 'm'));
    assert.match(compose, new RegExp(`^  ${service}:\\n[\\s\\S]*?egress-proxy:\\n        condition: service_healthy`, 'm'));
  }

  assert.match(compose, /NODE_USE_ENV_PROXY: "1"/);
  assert.match(compose, /HTTP_PROXY: "\$\{WM_EGRESS_PROXY_URL:-http:\/\/egress-proxy:10808\}"/);
  assert.match(compose, /NO_PROXY: "\$\{WM_EGRESS_NO_PROXY:-[^\n]*redis-rest[^\n]*localhost[^\n]*\}"/);
  assert.match(envExample, /^WM_EGRESS_PROXY_IMAGE=worldmonitor\/egress-proxy:xray-25\.8\.3$/m);
  assert.match(envExample, /^WM_EGRESS_PROXY_CONFIG=\.\/shared\/egress\/xray-config\.json$/m);
});

test('LemonBus edge config terminates TLS and proxies to the authenticated private port', async () => {
  const nginx = await readFile(domainNginxPath, 'utf8');

  assert.match(nginx, /server_name wm\.lemonbus\.cn/);
  assert.match(nginx, /return 301 https:\/\/wm\.lemonbus\.cn\$request_uri/);
  assert.match(nginx, /ssl_certificate \/data\/cert\/wm\/wm\.lemonbus\.cn\.pem/);
  assert.match(nginx, /server 192\.168\.10\.30:18101/);
  assert.match(nginx, /proxy_hide_header Strict-Transport-Security/);
  assert.match(nginx, /proxy_hide_header X-Robots-Tag/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto https/);
  assert.match(nginx, /proxy_set_header CF-Connecting-IP \$remote_addr/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(nginx, /Strict-Transport-Security "max-age=31536000" always/);
  assert.doesNotMatch(nginx, /auth_basic_user_file/);
});

test('release deployment resolves physical symlinks and mounts the validated auth file', async () => {
  const compose = await readFile(composePath, 'utf8');
  const deployScript = await readFile(deployScriptPath, 'utf8');

  assert.match(deployScript, /pwd -P/);
  assert.match(deployScript, /export WM_IMAGE_TAG WM_AUTH_FILE/);
  assert.match(deployScript, /WM_COMPOSE_OVERRIDE_FILE/);
  assert.match(deployScript, /WM_COMPOSE_EGRESS_FILE/);
  assert.match(deployScript, /export WM_IMAGE_TAG WM_AUTH_FILE WM_EGRESS_PROXY_CONFIG/);
  assert.match(deployScript, /Compose override is not readable/);
  assert.match(deployScript, /Egress Compose override is not readable/);
  assert.match(deployScript, /--file "\$compose_override_file"/);
  assert.match(deployScript, /--file "\$compose_egress_file"/);
  assert.match(deployScript, /pinned_node_image="node:24-alpine@sha256:[a-f0-9]{64}"/);
  assert.match(deployScript, /pinned_node_amd64_digest="[a-f0-9]{64}"/);
  assert.match(deployScript, /--build-context "\$pinned_node_image=docker-image:\/\/\$node_build_context"/);
  assert.match(deployScript, /run_compose up --detach --remove-orphans --no-build/);
  assert.match(compose, /source: "\$\{WM_AUTH_FILE:-\.\/shared\/auth\/worldmonitor\.htpasswd\}"/);
});

test('base images are pinned in the build definitions and cannot be weakened by Compose args', async () => {
  const compose = await readFile(composePath, 'utf8');
  const envExample = await readFile(envExamplePath, 'utf8');
  const appDockerfile = await readFile(appDockerfilePath, 'utf8');

  assert.match(appDockerfile, /^FROM node:24-alpine@sha256:[a-f0-9]{64} AS builder$/m);
  assert.doesNotMatch(appDockerfile, /^FROM \$\{/m);
  assert.doesNotMatch(compose, /NODE_IMAGE:/);
  assert.doesNotMatch(compose, /TUNNEL_BASE_IMAGE:/);
  assert.match(compose, /image: "redis:7-alpine@sha256:[a-f0-9]{64}"/);
  assert.match(envExample, /^WM_NODE_BUILD_CONTEXT=$/m);
  assert.doesNotMatch(envExample, /^WM_NODE_IMAGE=/m);
  assert.doesNotMatch(envExample, /^WM_TUNNEL_BASE_IMAGE=/m);
});

test('every long-running production service automatically restarts', async () => {
  const compose = await readFile(composePath, 'utf8');
  const serviceNames = [
    'worldmonitor',
    'ais-relay',
    'redis',
    'redis-rest',
    'seeders',
    'auth-proxy',
    'quick-tunnel',
  ];

  assert.match(compose, /x-common-service:[\s\S]*restart: unless-stopped/);
  assert.match(compose, /seeders:[\s\S]*healthcheck:[\s\S]*kill -0 1/);
  for (const name of serviceNames) {
    assert.match(compose, new RegExp(`^  ${name}:\\n    <<: \\*common-service`, 'm'));
  }
});

test('environment validator rejects public placeholders and accepts strong release inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worldmonitor-validator-'));
  const envPath = join(directory, 'env');
  const authPath = join(directory, 'auth');
  const envLinkPath = join(directory, 'env-link');
  const authLinkPath = join(directory, 'auth-link');
  const egressPath = join(directory, 'egress.json');
  const validator = fileURLToPath(validatorPath);
  const placeholders = [
    'REDIS_PASSWORD=replace-with-openssl-rand-hex-32',
    'REDIS_TOKEN=replace-with-openssl-rand-hex-32',
    'WM_SESSION_SECRET=replace-with-openssl-rand-hex-32',
    'WM_AUTH_COOKIE_SECRET=replace-with-openssl-rand-hex-32',
    'RELAY_SHARED_SECRET=replace-with-openssl-rand-hex-32',
    '',
  ].join('\n');

  await writeFile(envPath, placeholders, { mode: 0o600 });
  await writeFile(authPath, 'investor:$apr1$12345678$abcdefghijklmnopqrstuv\n', { mode: 0o600 });
  await chmod(envPath, 0o600);
  await chmod(authPath, 0o600);
  await writeFile(egressPath, '{"inbounds":[],"outbounds":[]}\n', { mode: 0o600 });
  await chmod(egressPath, 0o600);
  await symlink(envPath, envLinkPath);
  await symlink(authPath, authLinkPath);

  const rejected = spawnSync(validator, [envPath, authPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /public REDIS_PASSWORD placeholder/);

  const strong = placeholders.replaceAll('replace-with-openssl-rand-hex-32', 'a'.repeat(64));
  await writeFile(envPath, strong, { mode: 0o600 });
  const accepted = spawnSync(validator, [envLinkPath, authLinkPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  const acceptedWithEgress = spawnSync(validator, [envLinkPath, authLinkPath, egressPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.equal(acceptedWithEgress.status, 0, acceptedWithEgress.stderr);

  await chmod(egressPath, 0o644);
  const permissiveEgress = spawnSync(validator, [envLinkPath, authLinkPath, egressPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.notEqual(permissiveEgress.status, 0);
  assert.match(permissiveEgress.stderr, /must have mode 600 or 400/);

  await writeFile(egressPath, '{"inbounds":[]}\n', { mode: 0o600 });
  await chmod(egressPath, 0o600);
  const incompleteEgress = spawnSync(validator, [envLinkPath, authLinkPath, egressPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.notEqual(incompleteEgress.status, 0);
  assert.match(incompleteEgress.stderr, /must contain inbounds and outbounds arrays/);

  await writeFile(envPath, strong.replace('WM_AUTH_COOKIE_SECRET=' + 'a'.repeat(64), 'WM_AUTH_COOKIE_SECRET=' + 'z'.repeat(64)), {
    mode: 0o600,
  });
  const invalidCookieSecret = spawnSync(validator, [envLinkPath, authLinkPath], {
    encoding: 'utf8',
    env: { ...process.env, WM_IMAGE_TAG: 'abcdef123456' },
  });
  assert.notEqual(invalidCookieSecret.status, 0);
  assert.match(invalidCookieSecret.stderr, /exactly 64 lowercase hexadecimal/);
});

test('documented self-host provider keys reach both the app and seeders', async () => {
  const compose = await readFile(composePath, 'utf8');
  const envExample = await readFile(envExamplePath, 'utf8');
  const providerKeys = [
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'FINNHUB_API_KEY',
    'ALPHA_VANTAGE_API_KEY',
    'FRED_API_KEY',
    'EIA_API_KEY',
    'ACLED_EMAIL',
    'ACLED_PASSWORD',
    'ACLED_ACCESS_TOKEN',
    'NASA_FIRMS_API_KEY',
    'AVIATIONSTACK_API',
    'TRAVELPAYOUTS_API_TOKEN',
    'AISSTREAM_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'LLM_API_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
  ];

  for (const key of providerKeys) {
    const composeOccurrences = compose.match(new RegExp(`^      ${key}:`, 'gm')) ?? [];
    assert.ok(composeOccurrences.length >= 2, `${key} must reach the app and seeders`);
    assert.match(envExample, new RegExp(`^${key}=$`, 'm'));
  }
});

test('Docker build scans attribution before generated handler bundles exist', async () => {
  const dockerfile = await readFile(appDockerfilePath, 'utf8');
  const corpusIndex = dockerfile.indexOf('RUN npm run build:crawlable-corpus');
  const handlerIndex = dockerfile.indexOf('RUN node docker/build-handlers.mjs');

  assert.ok(corpusIndex >= 0);
  assert.ok(handlerIndex > corpusIndex);
});

test('public proxy enforces HTTPS before authentication and keeps only liveness public', async () => {
  const proxy = await readFile(proxyPath, 'utf8');
  const compose = await readFile(composePath, 'utf8');
  const entrypoint = await readFile(authEntrypointPath, 'utf8');
  const dockerfile = await readFile(authDockerfilePath, 'utf8');

  assert.match(proxy, /location = \/healthz[\s\S]*auth_basic off/);
  assert.match(proxy, /map \$http_x_forwarded_proto \$wm_redirect_https[\s\S]*http 1/);
  assert.match(proxy, /if \(\$wm_redirect_https\)[\s\S]*return 308 https:\/\/\$host\$request_uri/);
  assert.match(proxy, /location \/[\s\S]*auth_basic "World Monitor"/);
  assert.match(proxy, /auth_basic_user_file \/run\/secrets\/worldmonitor_htpasswd/);
  assert.match(proxy, /satisfy any/);
  assert.match(proxy, /auth_request \/_wm_cookie_auth/);
  assert.match(proxy, /map_hash_bucket_size 128/);
  assert.match(proxy, /Set-Cookie "wm_gateway=__WM_AUTH_COOKIE_SECRET__; Path=\/; Secure; HttpOnly; SameSite=Strict"/);
  assert.doesNotMatch(proxy, /Set-Cookie[^\n]*always/);
  assert.match(compose, /WM_AUTH_COOKIE_SECRET: "\$\{WM_AUTH_COOKIE_SECRET:\?[^}]+\}"/);
  assert.match(entrypoint, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(entrypoint, /\/run\/nginx\/nginx\.conf/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/auth-proxy-entrypoint"\]/);
  assert.match(proxy, /proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto/);
  assert.match(proxy, /Strict-Transport-Security "max-age=31536000" always/);
  assert.match(proxy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
});

test('deployment credentials and runtime artifacts are ignored', async () => {
  const ignore = await readFile(ignorePath, 'utf8');
  const dockerIgnore = await readFile(dockerIgnorePath, 'utf8');

  assert.match(ignore, /^deploy\/self-hosted\/\.env\.production$/m);
  assert.match(ignore, /^deploy\/self-hosted\/shared\/$/m);
  assert.match(ignore, /^deploy\/self-hosted\/runtime\/$/m);
  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.match(dockerIgnore, /^deploy\/self-hosted\/shared\/$/m);
  assert.match(dockerIgnore, /^deploy\/self-hosted\/runtime\/$/m);
});
