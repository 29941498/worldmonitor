#!/bin/sh
set -eu

deploy_dir="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
repo_dir="$(CDPATH= cd -- "$deploy_dir/../.." && pwd -P)"
env_file="${WM_ENV_FILE:-$deploy_dir/.env.production}"
auth_file="${WM_AUTH_FILE:-$deploy_dir/shared/auth/worldmonitor.htpasswd}"
compose_file="$deploy_dir/docker-compose.production.yml"
compose_override_file="${WM_COMPOSE_OVERRIDE_FILE:-}"
compose_egress_file="${WM_COMPOSE_EGRESS_FILE:-}"
project_name="${COMPOSE_PROJECT_NAME:-worldmonitor}"
pinned_node_image="node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"
pinned_node_amd64_digest="2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43"

release_name="$(basename "$repo_dir")"
release_tag="${release_name#worldmonitor-}"
WM_IMAGE_TAG="${WM_IMAGE_TAG:-$release_tag}"
WM_AUTH_FILE="$auth_file"

node_build_context="${WM_NODE_BUILD_CONTEXT:-}"
if [ -z "$node_build_context" ]; then
  node_build_context="$(sed -n 's/^WM_NODE_BUILD_CONTEXT=//p' "$env_file" 2>/dev/null | tail -n 1)"
fi
if [ -n "$node_build_context" ]; then
  case "$node_build_context" in
    *@sha256:"$pinned_node_amd64_digest") ;;
    *)
      printf 'WM_NODE_BUILD_CONTEXT must resolve to the audited linux/amd64 manifest sha256:%s.\n' "$pinned_node_amd64_digest" >&2
      exit 65
      ;;
  esac
fi

egress_config="${WM_EGRESS_PROXY_CONFIG:-}"
WM_EGRESS_PROXY_CONFIG=""
if [ -n "$compose_egress_file" ]; then
  if [ -z "$egress_config" ]; then
    egress_config="$(sed -n 's/^WM_EGRESS_PROXY_CONFIG=//p' "$env_file" 2>/dev/null | tail -n 1)"
  fi
  if [ -n "$egress_config" ]; then
    case "$egress_config" in
      /*) ;;
      *) egress_config="$deploy_dir/$egress_config" ;;
    esac
    WM_EGRESS_PROXY_CONFIG="$egress_config"
  fi
fi
export WM_IMAGE_TAG WM_AUTH_FILE WM_EGRESS_PROXY_CONFIG

"$deploy_dir/scripts/validate-env.sh" "$env_file" "$auth_file" "${WM_EGRESS_PROXY_CONFIG:-}"
mkdir -p "$deploy_dir/runtime"
chmod 700 "$deploy_dir/runtime"

if [ -n "$compose_override_file" ] && [ ! -r "$compose_override_file" ]; then
  printf 'Compose override is not readable: %s\n' "$compose_override_file" >&2
  exit 1
fi
if [ -n "$compose_egress_file" ] && [ ! -r "$compose_egress_file" ]; then
  printf 'Egress Compose override is not readable: %s\n' "$compose_egress_file" >&2
  exit 1
fi
if [ -n "$compose_egress_file" ] && [ -z "${WM_EGRESS_PROXY_CONFIG:-}" ]; then
  printf 'WM_EGRESS_PROXY_CONFIG is required when WM_COMPOSE_EGRESS_FILE is enabled.\n' >&2
  exit 1
fi

run_compose() {
  if [ -n "$compose_override_file" ] && [ -n "$compose_egress_file" ]; then
    docker compose \
      --project-name "$project_name" \
      --env-file "$env_file" \
      --file "$compose_file" \
      --file "$compose_override_file" \
      --file "$compose_egress_file" \
      "$@"
  elif [ -n "$compose_override_file" ]; then
    docker compose \
      --project-name "$project_name" \
      --env-file "$env_file" \
      --file "$compose_file" \
      --file "$compose_override_file" \
      "$@"
  elif [ -n "$compose_egress_file" ]; then
    docker compose \
      --project-name "$project_name" \
      --env-file "$env_file" \
      --file "$compose_file" \
      --file "$compose_egress_file" \
      "$@"
  else
    docker compose \
      --project-name "$project_name" \
      --env-file "$env_file" \
      --file "$compose_file" \
      "$@"
  fi
}

run_compose config --quiet
if [ -n "$node_build_context" ]; then
  build_with_pinned_node_context() {
    dockerfile="$1"
    image="$2"
    context="$3"
    shift 3
    docker buildx build \
      --load \
      --build-context "$pinned_node_image=docker-image://$node_build_context" \
      --file "$dockerfile" \
      --tag "$image" \
      "$@" \
      "$context"
  }

  build_with_pinned_node_context \
    "$repo_dir/Dockerfile" \
    "worldmonitor/app:$WM_IMAGE_TAG" \
    "$repo_dir" \
    --build-arg VITE_SELF_HOSTED_LOGIN_GATEWAY=true
  build_with_pinned_node_context \
    "$repo_dir/Dockerfile.relay" \
    "worldmonitor/ais-relay:$WM_IMAGE_TAG" \
    "$repo_dir"
  build_with_pinned_node_context \
    "$repo_dir/docker/Dockerfile.redis-rest" \
    "worldmonitor/redis-rest:$WM_IMAGE_TAG" \
    "$repo_dir/docker"
  build_with_pinned_node_context \
    "$repo_dir/deploy/self-hosted/Dockerfile.seeders" \
    "worldmonitor/seeders:$WM_IMAGE_TAG" \
    "$repo_dir"
  build_with_pinned_node_context \
    "$repo_dir/deploy/self-hosted/Dockerfile.auth-proxy" \
    "worldmonitor/auth-proxy:$WM_IMAGE_TAG" \
    "$repo_dir"

  if [ -z "$compose_override_file" ]; then
    run_compose build quick-tunnel
  fi
else
  run_compose build
fi
run_compose up --detach --remove-orphans --no-build --wait --wait-timeout 300

printf 'World Monitor containers passed startup/liveness checks.\n'
if [ -n "$compose_override_file" ]; then
  printf 'Stable-domain override active: %s\n' "$compose_override_file"
else
  printf 'Public URL will appear in %s\n' "$deploy_dir/runtime/public-url.txt"
fi
if [ -n "$compose_egress_file" ]; then
  printf 'Independent egress proxy override active: %s\n' "$compose_egress_file"
fi
if [ -n "$node_build_context" ]; then
  printf 'Audited local Node build context active for the pinned linux/amd64 manifest.\n'
fi
printf 'Data readiness is separate: inspect /api/health?compact=1 and seeder results before use.\n'
