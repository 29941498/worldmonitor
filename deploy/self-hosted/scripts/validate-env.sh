#!/bin/sh
set -eu

env_file="${1:-.env.production}"
auth_file="${2:-shared/auth/worldmonitor.htpasswd}"
image_tag="${WM_IMAGE_TAG:-}"

if [ ! -f "$env_file" ]; then
  printf 'ERROR: missing environment file: %s\n' "$env_file" >&2
  exit 66
fi
if [ ! -s "$auth_file" ]; then
  printf 'ERROR: missing or empty auth file: %s\n' "$auth_file" >&2
  exit 66
fi

env_mode="$(stat -Lc '%a' "$env_file" 2>/dev/null || stat -Lf '%Lp' "$env_file")"
case "$env_mode" in
  600|400) ;;
  *) printf 'ERROR: %s must have mode 600 or 400 (found %s)\n' "$env_file" "$env_mode" >&2; exit 77 ;;
esac

for key in REDIS_PASSWORD REDIS_TOKEN WM_SESSION_SECRET WM_AUTH_COOKIE_SECRET RELAY_SHARED_SECRET; do
  value="$(sed -n "s/^${key}=//p" "$env_file" | tail -n 1)"
  if [ "${#value}" -lt 32 ]; then
    printf 'ERROR: %s must contain a %s value of at least 32 characters\n' "$env_file" "$key" >&2
    exit 65
  fi
  case "$value" in
    replace-with-*) printf 'ERROR: %s still contains the public %s placeholder\n' "$env_file" "$key" >&2; exit 65 ;;
  esac
done

auth_cookie_secret="$(sed -n 's/^WM_AUTH_COOKIE_SECRET=//p' "$env_file" | tail -n 1)"
if ! printf '%s\n' "$auth_cookie_secret" | grep -Eq '^[0-9a-f]{64}$'; then
  printf 'ERROR: WM_AUTH_COOKIE_SECRET must be exactly 64 lowercase hexadecimal characters\n' >&2
  exit 65
fi

auth_mode="$(stat -Lc '%a' "$auth_file" 2>/dev/null || stat -Lf '%Lp' "$auth_file")"
case "$auth_mode" in
  600|400) ;;
  *) printf 'ERROR: %s must have mode 600 or 400 (found %s)\n' "$auth_file" "$auth_mode" >&2; exit 77 ;;
esac

if [ "$(wc -l < "$auth_file" | tr -d ' ')" -ne 1 ] || \
   ! grep -Eq '^[A-Za-z0-9._-]+:\$apr1\$[./A-Za-z0-9]{1,8}\$[./A-Za-z0-9]{22}$' "$auth_file"; then
  printf 'ERROR: auth file must contain exactly one complete Apache MD5 htpasswd entry\n' >&2
  exit 65
fi

if ! printf '%s\n' "$image_tag" | grep -Eq '^[0-9a-f]{7,40}$'; then
  printf 'ERROR: WM_IMAGE_TAG must be an immutable 7-40 character lowercase Git SHA\n' >&2
  exit 65
fi

printf 'Environment and login files passed structural validation.\n'
