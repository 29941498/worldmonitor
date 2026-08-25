#!/bin/sh
set -eu

deploy_dir="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
repo_dir="$(CDPATH= cd -- "$deploy_dir/../.." && pwd -P)"
env_file="${WM_ENV_FILE:-$deploy_dir/.env.production}"
auth_file="${WM_AUTH_FILE:-$deploy_dir/shared/auth/worldmonitor.htpasswd}"
compose_file="$deploy_dir/docker-compose.production.yml"
compose_override_file="${WM_COMPOSE_OVERRIDE_FILE:-}"
project_name="${COMPOSE_PROJECT_NAME:-worldmonitor}"

release_name="$(basename "$repo_dir")"
release_tag="${release_name#worldmonitor-}"
WM_IMAGE_TAG="${WM_IMAGE_TAG:-$release_tag}"
WM_AUTH_FILE="$auth_file"
export WM_IMAGE_TAG WM_AUTH_FILE

"$deploy_dir/scripts/validate-env.sh" "$env_file" "$auth_file"
mkdir -p "$deploy_dir/runtime"
chmod 700 "$deploy_dir/runtime"

if [ -n "$compose_override_file" ] && [ ! -r "$compose_override_file" ]; then
  printf 'Compose override is not readable: %s\n' "$compose_override_file" >&2
  exit 1
fi

run_compose() {
  if [ -n "$compose_override_file" ]; then
    docker compose \
      --project-name "$project_name" \
      --env-file "$env_file" \
      --file "$compose_file" \
      --file "$compose_override_file" \
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
run_compose build
run_compose up --detach --remove-orphans --wait --wait-timeout 300

printf 'World Monitor containers passed startup/liveness checks.\n'
if [ -n "$compose_override_file" ]; then
  printf 'Stable-domain override active: %s\n' "$compose_override_file"
else
  printf 'Public URL will appear in %s\n' "$deploy_dir/runtime/public-url.txt"
fi
printf 'Data readiness is separate: inspect /api/health?compact=1 and seeder results before use.\n'
