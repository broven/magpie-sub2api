// The plugin, called as magpie calls it, against the real sub2api that
// test/run.sh starts and test/setup.mjs fills (STATE names the JSON
// setup printed). What each hook gave, next to what sub2api answered, is
// written to test/artifacts/<SUB2API_IMAGE_TAG>/.

import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as plugin from "../index.mjs"
const { Sub2apiPlugin } = plugin

const here = dirname(fileURLToPath(import.meta.url))
const state = JSON.parse(readFileSync(process.env.STATE ?? join(here, ".state", "state.json"), "utf8"))
const tag = process.env.SUB2API_IMAGE_TAG ?? "0.2.14"
const out = join(here, "artifacts", tag)
mkdirSync(out, { recursive: true })

const HOUR = 3600
const DAY = 24 * HOUR
const host = new URL(state.base).host

// what magpie keeps for an API-key sign-in: {type, key, metadata: the prompts' answers}
const signIn = (key) => ({ type: "api", key, metadata: { baseURL: state.base } })

// magpie's client, as far as the plugin uses it: auth.set records the write
function fakeClient() {
  const sets = []
  return { sets, auth: { set: async (req) => void sets.push(req) } }
}

async function raw(key) {
  const res = await fetch(state.base + "/v1/usage", { headers: { authorization: `Bearer ${key}` } })
  return res.json()
}

const iso = (s) => new Date(Date.parse(s)).toISOString()
const plus = (s, secs) => new Date(Date.parse(s) + secs * 1000).toISOString()

let hooks, client
before(async () => {
  client = fakeClient()
  hooks = await Sub2apiPlugin({ client, project: {}, directory: here, worktree: here, $: undefined })
})

async function run(mode) {
  const auth = signIn(state.keys[mode])
  const usage = await hooks.auth.usage(async () => auth, { id: "sub2api" })
  const upstream = await raw(state.keys[mode])
  writeFileSync(join(out, `${mode}.json`), JSON.stringify({ tag, mode, usage, upstream }, null, 2) + "\n")
  return { usage, upstream }
}

test("the plugin's shape is what magpie checks", () => {
  assert.equal(typeof hooks.auth.provider, "string")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.ok(hooks.auth.methods.length > 0)
  for (const m of hooks.auth.methods) assert.ok(m.type === "api" || (m.type === "oauth" && typeof m.authorize === "function"))
  assert.equal(hooks.auth.methods[0].prompts[0].validate("ftp://x"), "The address starts with https://")
  assert.equal(hooks.auth.methods[0].prompts[0].validate(state.base + "/v1/"), undefined)
})

test("loader: the site's /v1 and the key, and the account is named after the site", async () => {
  const c = fakeClient()
  const h = await Sub2apiPlugin({ client: c })
  const auth = { ...signIn(state.keys.subscription), metadata: { baseURL: state.base + "/v1/" } }
  const got = await h.auth.loader(async () => auth, { id: "sub2api", models: {} })
  assert.deepEqual(got, { baseURL: state.base + "/v1", apiKey: state.keys.subscription })
  assert.equal(c.sets.length, 1)
  assert.deepEqual(c.sets[0].path, { id: "sub2api" })
  assert.equal(c.sets[0].body.accountId, `${host} …${state.keys.subscription.slice(-4)}`)
  assert.equal(c.sets[0].body.key, state.keys.subscription)
  assert.deepEqual(c.sets[0].body.metadata, auth.metadata)
  // already named: no second write
  await h.auth.loader(async () => c.sets[0].body, {})
  assert.equal(c.sets.length, 1)
})

test("provider.models: the key's group's models, Claude on /v1/messages", async () => {
  const provider = { id: "sub2api", models: { kept: {} } }
  const models = await hooks.provider.models(provider, { auth: signIn(state.keys.subscription) })
  writeFileSync(join(out, "models.json"), JSON.stringify({ tag, models }, null, 2) + "\n")
  const ids = Object.keys(models)
  assert.ok(ids.length > 0, "no models")
  assert.ok(ids.some((id) => id.startsWith("claude-")), "no Claude model: " + ids.join(", "))
  for (const id of ids) {
    const m = models[id]
    assert.equal(m.providerID, "sub2api")
    assert.equal(m.api.url, state.base + "/v1")
    if (id.startsWith("claude-")) assert.equal(m.api.npm, "@ai-sdk/anthropic")
  }
  // a key the site refuses: the account is marked signed out
  await assert.rejects(hooks.provider.models(provider, { auth: signIn("sk-not-a-key-0000") }), (e) => e.signIn === "expired")
  // no key: the list magpie has stays
  assert.equal(await hooks.provider.models(provider, {}), provider.models)
})

test("usage, subscription group: day, week and month", async () => {
  const { usage, upstream } = await run("subscription")
  const s = upstream.subscription
  const L = state.limits.subscription
  assert.equal(usage.error, undefined)
  assert.equal(usage.user, `${host} …${state.keys.subscription.slice(-4)}`)
  assert.equal(usage.plan, state.groups.subscription)
  assert.equal(usage.until, s.expires_at)
  assert.ok(Date.parse(usage.until) > Date.now())
  assert.equal(usage.balance, undefined)
  assert.deepEqual(usage.windows.map((w) => [w.name, w.span]), [["24 hours", DAY], ["7 days", 7 * DAY], ["30 days", 30 * DAY]])
  const [day, week, month] = usage.windows
  for (const [w, used, limit] of [[day, s.daily_usage_usd, L.daily_limit_usd], [week, s.weekly_usage_usd, L.weekly_limit_usd], [month, s.monthly_usage_usd, L.monthly_limit_usd]]) {
    assert.ok(w.used > 0, `${w.name}: used ${w.used}`)
    assert.ok(Math.abs(w.used - (100 * used) / limit) < 1e-9)
    assert.match(w.display, /^\$\d+\.\d\d \/ \$\d+\.\d\d$/)
  }
  // a reset time only where sub2api tells it (*_reset_at, not on current
  // upstream images); the week falls back to its start + 7 days
  assert.equal(week.resetsAt, s.weekly_reset_at ?? plus(s.weekly_window_start, 7 * DAY))
  assert.equal(day.resetsAt, s.daily_reset_at ?? undefined)
  assert.equal(month.resetsAt, s.monthly_reset_at ?? undefined)
  assert.equal(iso(week.resetsAt), week.resetsAt)
})

test("usage, balance group: the wallet, no windows", async () => {
  const { usage, upstream } = await run("balance")
  assert.equal(usage.error, undefined)
  assert.equal(usage.windows, undefined)
  assert.equal(usage.until, undefined)
  assert.equal(usage.plan, upstream.planName)
  assert.equal(usage.balance, "$" + upstream.balance.toFixed(2))
  assert.ok(upstream.balance < state.limits.topup)
})

test("usage, a key with its own quota and rate limits", async () => {
  const { usage, upstream } = await run("quota")
  const Q = state.limits.quota
  assert.equal(usage.error, undefined)
  assert.equal(usage.plan, "API key limits")
  assert.equal(usage.until, upstream.expires_at)
  assert.ok(Date.parse(usage.until) > Date.now())
  assert.deepEqual(
    usage.windows.map((w) => [w.name, w.span]),
    [["Key quota", undefined], ["5 hours", 5 * HOUR], ["24 hours", DAY], ["7 days", 7 * DAY]],
  )
  const [quota, ...rates] = usage.windows
  assert.ok(Math.abs(quota.used - (100 * upstream.quota.used) / Q.quota) < 1e-9)
  for (const w of usage.windows) assert.ok(w.used > 0, `${w.name}: used ${w.used}`)
  const byWindow = Object.fromEntries(upstream.rate_limits.map((r) => [r.window, r]))
  for (const [w, k] of [[rates[0], "5h"], [rates[1], "1d"], [rates[2], "7d"]]) {
    assert.ok(w.resetsAt, `${w.name}: no reset time`)
    assert.equal(w.resetsAt, byWindow[k].reset_at)
    assert.ok(Date.parse(w.resetsAt) > Date.now())
  }
})

test("usage, a key the site refuses: signed out", async () => {
  const usage = await hooks.auth.usage(async () => signIn("sk-not-a-key-0000"), { id: "sub2api" })
  assert.equal(usage.signIn, "expired")
  assert.match(usage.error, /^401 /)
  assert.deepEqual(usage.windows, [])
})

test("a sign-in's own name names the account", async () => {
  const c = fakeClient()
  const h = await Sub2apiPlugin({ client: c })
  assert.deepEqual(h.auth.methods[0].prompts.map((p) => p.key), ["baseURL", "name"])
  const auth = { ...signIn(state.keys.subscription), metadata: { baseURL: state.base, name: "  my jmds  " } }
  const usage = await h.auth.usage(async () => auth, { id: "sub2api" })
  assert.equal(usage.user, "my jmds")
  assert.equal(c.sets[0].body.accountId, "my jmds")
  // an empty name: the site's host and the key's end
  const blank = { ...signIn(state.keys.balance), metadata: { baseURL: state.base, name: "" } }
  assert.equal((await h.auth.usage(async () => blank, {})).user, `${host} …${state.keys.balance.slice(-4)}`)
})

test("options.sites: each site its own named provider, in the order listed", async () => {
  const exported = Object.entries(plugin)
  // every export is a plugin magpie calls: no helper may be exported
  for (const [name, fn] of exported) assert.equal(typeof fn, "function", name)
  const options = {
    sites: [
      { id: "mine", name: "My site", url: state.base + "/v1/" },
      { id: "Not An Id", url: state.base },
      { url: "ftp://nowhere" },
      { id: "sub2api", url: state.base },
      { url: state.base.replace("127.0.0.1", "localhost") },
    ],
  }
  const c = fakeClient()
  const all = await Promise.all(exported.map(([, fn]) => fn({ client: c }, options)))
  const ids = all.map((h) => h.auth?.provider)
  assert.deepEqual(ids.filter(Boolean), ["sub2api", "mine", slugLocal()])
  assert.equal(ids.length, 9, "the pooled provider and 8 site slots")
  for (const h of all.filter((h) => !h.auth)) assert.deepEqual(h, {}, "an empty slot is no provider")
  // no options: only the pooled provider
  const bare = await Promise.all(exported.map(([, fn]) => fn({ client: c }, undefined)))
  assert.deepEqual(bare.map((h) => h.auth?.provider).filter(Boolean), ["sub2api"])

  const mine = all.find((h) => h.auth?.provider === "mine")
  // the name it was given, unless the user's config already names it
  const cfg = { provider: {} }
  for (const h of all) h.config?.(cfg)
  assert.equal(cfg.provider.mine.name, "My site")
  assert.equal(cfg.provider[slugLocal()].name, slugLocal())
  const named = { provider: { mine: { name: "Hand-named" } } }
  mine.config(named)
  assert.equal(named.provider.mine.name, "Hand-named")

  // the key alone: the address is the site's, asked of no one
  assert.deepEqual(mine.auth.methods[0].prompts.map((p) => p.key), ["name"])
  assert.equal(mine.auth.methods[0].label, "My site API key")
  const auth = { type: "api", key: state.keys.subscription, metadata: { name: "work" } }
  assert.deepEqual(await mine.auth.loader(async () => auth, {}), { baseURL: state.base + "/v1", apiKey: state.keys.subscription })
  const set = c.sets.find((r) => r.path.id === "mine")
  assert.equal(set.body.accountId, "work")
  const usage = await mine.auth.usage(async () => auth, {})
  assert.equal(usage.user, "work")
  assert.equal(usage.error, undefined)
  assert.equal(usage.plan, state.groups.subscription)
  assert.equal(usage.windows.length, 3)
  const models = await mine.provider.models({ id: "mine", models: {} }, { auth })
  assert.ok(Object.keys(models).length > 0)
  for (const m of Object.values(models)) {
    assert.equal(m.providerID, "mine")
    assert.equal(m.api.url, state.base + "/v1")
  }
  writeFileSync(join(out, "sites.json"), JSON.stringify({ tag, ids, config: cfg, usage, models: Object.keys(models) }, null, 2) + "\n")
})

function slugLocal() {
  return new URL(state.base.replace("127.0.0.1", "localhost")).hostname.replace(/[^a-z0-9]+/g, "-")
}
