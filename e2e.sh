#!/bin/sh
# Manual, before each release: this checkout in a REAL magpie, in a sandbox
# of its own (.e2e/), so your magpie's config, agents and sign-ins are never
# touched:
#   SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
# adds this plugin, signs in with the key twice, once to the pooled
# provider sub2api and once to the site's own provider (options.sites, as
# e2e-site, named "E2E site"), and prints what magpie then shows: the
# plugin list (each provider's name, each account's), the key's usage
# (magpie quota), the providers' models, and magpie provider test (one
# tiny real request each). SUB2API_NAME names the accounts (default: none,
# so they show as the site's host and the key's end). Repeat it with a key of each kind you have (a
# subscription group's, a balance group's, a key with its own quota).
# MAGPIE is the magpie binary (default: magpie on PATH, else magpie.app's).
set -eu
: "${SUB2API_URL:?} ${SUB2API_KEY:?}"
name=${SUB2API_NAME-}
here=$(cd "$(dirname "$0")" && pwd)
sb=$here/.e2e/$(printf %s "$SUB2API_KEY" | shasum | cut -c1-8)
rm -rf "$sb" && mkdir -p "$sb"
m=${MAGPIE:-$(command -v magpie || echo /Applications/magpie.app/Contents/MacOS/magpie)}
run() { env -i PATH="$PATH" HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_PLUGIN_MARKET=off "$m" "$@"; }

echo "== $("$m" --version 2>/dev/null || echo magpie: $m)"
echo "== plugin add"; run plugin add "$here" </dev/null
echo "== plugin options (one site of its own)"
run plugin options magpie-sub2api "{\"sites\":[{\"id\":\"e2e-site\",\"name\":\"E2E site\",\"url\":\"$SUB2API_URL\"}]}" </dev/null
# the sign-in's questions come first (the site's address, the account's
# name; a site's own provider asks only the name), then the key
echo "== plugin login sub2api"; printf '%s\n%s\n%s\n' "$SUB2API_URL" "$name" "$SUB2API_KEY" | run plugin login sub2api
echo "== plugin login e2e-site"; printf '%s\n%s\n' "$name" "$SUB2API_KEY" | run plugin login e2e-site
echo "== quota (names the accounts; the plugin names them on first use)"; run quota --json </dev/null
echo "== plugin list"; run plugin list </dev/null
echo "== models"; run models </dev/null | grep -iE "sub2api|e2e-site|E2E site" || true
for p in sub2api e2e-site; do echo "== provider test $p"; run provider test "$p" </dev/null; done
