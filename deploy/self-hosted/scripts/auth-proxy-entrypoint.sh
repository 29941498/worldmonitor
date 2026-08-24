#!/bin/sh
set -eu

cookie_secret="${WM_AUTH_COOKIE_SECRET:-}"

if ! printf '%s\n' "$cookie_secret" | grep -Eq '^[0-9a-f]{64}$'; then
  printf 'ERROR: WM_AUTH_COOKIE_SECRET must be exactly 64 lowercase hexadecimal characters\n' >&2
  exit 65
fi

sed "s/__WM_AUTH_COOKIE_SECRET__/$cookie_secret/g" \
  /etc/nginx/nginx.conf.template > /run/nginx/nginx.conf

exec nginx -c /run/nginx/nginx.conf -g 'daemon off;'
