#!/usr/bin/env bash
# Post-deploy smoke check: waits until a URL answers 200 (and, if given,
# contains a text) several times in a row, or fails after a timeout.
#
#   scripts/smoke-check.sh <url> [expected-text]
#
# Env (all optional): WAIT_BEFORE=0 (seconds to wait first, while the host
# builds), TIMEOUT=600 (seconds), INTERVAL=15 (seconds between tries),
# NEED_OK=3 (good answers in a row).
# The same script is in the server, web and admin repos.
set -uo pipefail

url="${1:?Usage: scripts/smoke-check.sh <url> [expected-text]}"
expected="${2:-}"
wait_before="${WAIT_BEFORE:-0}"
timeout="${TIMEOUT:-600}"
interval="${INTERVAL:-15}"
need_ok="${NEED_OK:-3}"

if [ "$wait_before" -gt 0 ]; then
  echo "Waiting ${wait_before}s for the deploy to finish…"
  sleep "$wait_before"
fi

deadline=$((SECONDS + timeout))
ok=0
body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT

while :; do
  : >"$body_file"
  # 000 = no answer (timeout, DNS, connection refused).
  status=$(curl --silent --location --max-time 20 \
    --output "$body_file" --write-out '%{http_code}' "$url") || true
  if [ "$status" = "200" ] && { [ -z "$expected" ] || grep -qF -- "$expected" "$body_file"; }; then
    ok=$((ok + 1))
    echo "OK ($ok/$need_ok): $url"
    if [ "$ok" -ge "$need_ok" ]; then
      echo "Smoke check passed: $url"
      exit 0
    fi
  else
    ok=0
    echo "Not healthy yet: $url -> ${status} $(head -c 200 "$body_file" | tr -d '\n')"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::Smoke check failed: $url not healthy after ${timeout}s (last answer: ${status})"
    exit 1
  fi
  sleep "$interval"
done
