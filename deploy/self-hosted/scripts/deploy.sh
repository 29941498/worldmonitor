#!/bin/sh
set -eu

deploy_dir="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
repo_dir="$(CDPATH= cd -- "$deploy_dir/../.." && pwd -P)"
env_file="${WM_ENV_FILE:-$deploy_dir/.env.production}"
auth_file="${WM_AUTH_FILE:-$deploy_dir/shared/auth/worldmonitor.htpasswd}"
compose_file="$deploy_dir/docker-compose.production.yml"
project_name="${COMPOSE_PROJECT_NAME:-worldmonitor}"

release_name="$(basename "$repo_dir")"
release_tag="${release_name#worldmonitor-}"
WM_IMAGE_TAG="${WM_IMAGE_TAG:-$release_tag}"
WM_AUTH_FILE="$auth_file"
export WM_IMAGE_TAG WM_AUTH_FILE

"$deploy_dir/scripts/validate-env.sh" "$env_file" "$auth_file"
mkdir -p "$deploy_dir/runtime"
chmod 700 "$deploy_dir/runtime"

docker compose \
  --project-name "$project_name" \
  --env-file "$env_file" \
  --file "$compose_file" \
  config --quiet

docker compose \
  --project-name "$project_name" \
  --env-file "$env_file" \
  --file "$compose_file" \
  build

docker compose \
  --project-name "$project_name" \
  --env-file "$env_file" \
  --file "$compose_file" \
  up --detach --remove-orphans --wait --wait-timeout 300

printf 'World Monitor containers passed startup/liveness checks.\n'
printf 'Public URL will appear in %s\n' "$deploy_dir/runtime/public-url.txt"
printf 'Data readiness is separate: inspect /api/health?compact=1 and seeder results before use.\n'
