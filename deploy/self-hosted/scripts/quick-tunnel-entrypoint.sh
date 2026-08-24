#!/bin/sh
set -eu

runtime_dir="${WM_RUNTIME_DIR:-/runtime}"
origin_url="${WM_TUNNEL_ORIGIN:-http://auth-proxy:8080}"
log_file="$runtime_dir/cloudflared.log"
url_file="$runtime_dir/public-url.txt"

mkdir -p "$runtime_dir"
: > "$log_file"
rm -f "$url_file"

cloudflared tunnel --no-autoupdate --url "$origin_url" > "$log_file" 2>&1 &
cloudflared_pid=$!

cleanup() {
  kill "$cloudflared_pid" 2>/dev/null || true
  wait "$cloudflared_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

attempt=0
while kill -0 "$cloudflared_pid" 2>/dev/null; do
  public_url="$(sed -n 's/.*\(https:\/\/[a-zA-Z0-9-]*\.trycloudflare\.com\).*/\1/p' "$log_file" | tail -n 1)"
  if [ -n "$public_url" ]; then
    current_url="$(cat "$url_file" 2>/dev/null || true)"
    if [ "$public_url" != "$current_url" ]; then
      tmp_file="$url_file.tmp"
      printf '%s\n' "$public_url" > "$tmp_file"
      mv "$tmp_file" "$url_file"
      printf 'World Monitor HTTPS tunnel is ready. URL written to %s\n' "$url_file"
    fi
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ] && [ ! -s "$url_file" ]; then
    printf 'ERROR: tunnel did not publish a URL within 90 seconds\n' >&2
    tail -n 30 "$log_file" >&2
    exit 1
  fi
  sleep 2
done

wait "$cloudflared_pid"
