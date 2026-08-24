#!/bin/sh
set -u

interval="${SEED_INTERVAL_SECONDS:-1800}"
initial_delay="${INITIAL_SEED_DELAY_SECONDS:-20}"

case "$interval" in
  ''|*[!0-9]*) printf 'ERROR: SEED_INTERVAL_SECONDS must be an integer\n' >&2; exit 64 ;;
esac
case "$initial_delay" in
  ''|*[!0-9]*) printf 'ERROR: INITIAL_SEED_DELAY_SECONDS must be an integer\n' >&2; exit 64 ;;
esac

sleep "$initial_delay"

while :; do
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Seeder cycle started at %s\n' "$started_at"

  cycle_log=/runtime/current-seed-cycle.log
  : > "$cycle_log"
  /workspace/scripts/run-seeders.sh 2>&1 | tee "$cycle_log"
  summary="$(grep '^Done:' "$cycle_log" | tail -n 1)"
  case "$summary" in
    *', 0 failed, 0 timed out') result=success ;;
    '') result=failed ;;
    *) result=partial ;;
  esac

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s result=%s started=%s finished=%s summary=%s\n' \
    "$finished_at" "$result" "$started_at" "$finished_at" "$summary" \
    > /runtime/last-seed-cycle.txt
  printf 'Seeder cycle finished at %s with result=%s; next cycle in %ss\n' \
    "$finished_at" "$result" "$interval"
  sleep "$interval"
done
