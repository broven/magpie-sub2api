#!/bin/sh
# Manual, before each release: this checkout in a REAL magpie, in a sandbox
# of its own (.e2e/), so your magpie's config, agents and sign-ins are never
# touched:
#   SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
# adds this plugin, signs in with the key, and prints what magpie then
# shows: the plugin list (the account named after the site), the key's
# usage (magpie quota), the provider's models, and magpie provider test
# (one tiny real request). Repeat it with a key of each kind you have (a
# subscription group's, a balance group's, a key with its own quota).
# MAGPIE is the magpie binary (default: magpie on PATH, else magpie.app's).
set -eu
: "${SUB2API_URL:?} ${SUB2API_KEY:?}"
here=$(cd "$(dirname "$0")" && pwd)
sb=$here/.e2e/$(printf %s "$SUB2API_KEY" | shasum | cut -c1-8)
rm -rf "$sb" && mkdir -p "$sb"
m=${MAGPIE:-$(command -v magpie || echo /Applications/magpie.app/Contents/MacOS/magpie)}
run() { env -i PATH="$PATH" HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_PLUGIN_MARKET=off "$m" "$@"; }

echo "== $("$m" --version 2>/dev/null || echo magpie: $m)"
echo "== plugin add"; run plugin add "$here" </dev/null
echo "== plugin login"; printf '%s\n%s\n' "$SUB2API_URL" "$SUB2API_KEY" | run plugin login sub2api
echo "== quota (names the account; the plugin names it on first use)"; run quota --json </dev/null
echo "== plugin list"; run plugin list </dev/null
echo "== models"; run models </dev/null | grep -i sub2api || true
echo "== provider test"; run provider test sub2api </dev/null
