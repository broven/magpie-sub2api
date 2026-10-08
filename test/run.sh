#!/usr/bin/env bash
# The plugin's end-to-end test: starts a throwaway upstream sub2api (with its
# Postgres, Redis and a fake Anthropic upstream, test/compose.yml), fills it
# (test/setup.mjs), calls the plugin's hooks against it (test/plugin.test.mjs),
# and always takes the stack down again, volumes and all.
#   ./test/run.sh                        # sub2api 0.2.14, the oldest supported
#   SUB2API_IMAGE_TAG=latest ./test/run.sh
# What the hooks gave lands in test/artifacts/<tag>/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export SUB2API_IMAGE_TAG="${SUB2API_IMAGE_TAG:-0.2.14}"
project="mps2a-$(printf %s "$SUB2API_IMAGE_TAG" | tr -c 'a-zA-Z0-9' '-' | tr 'A-Z' 'a-z')-$$"
dc() { docker compose -p "$project" -f "$here/compose.yml" "$@"; }

down() {
  local code=$?
  if [ "$code" -ne 0 ]; then dc logs --no-color --tail 80 sub2api >&2 || true; fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$code"
}
trap down EXIT INT TERM

echo "== sub2api $SUB2API_IMAGE_TAG (compose project $project)"
dc pull --quiet sub2api
dc up -d --quiet-pull
port="$(dc port sub2api 8080 | sed 's/.*://')"
base="http://127.0.0.1:$port"
docker image inspect "weishaw/sub2api:$SUB2API_IMAGE_TAG" --format 'image {{.Id}} created {{.Created}}' || true

mkdir -p "$here/.state" "$here/artifacts/$SUB2API_IMAGE_TAG"
export STATE="$here/.state/state-$$.json"
node "$here/setup.mjs" "$base" >"$STATE"
curl -fsS "$base/health" >/dev/null
node --test --test-reporter=spec "$here/plugin.test.mjs"
rm -f "$STATE"
