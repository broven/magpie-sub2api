// The plugin, called as magpie calls it, against the real sub2api that
// test/run.sh starts and test/setup.mjs fills (STATE names the JSON
// setup printed). What each hook gave, next to what sub2api answered, is
// written to test/artifacts/<SUB2API_IMAGE_TAG>/.

import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
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

// models.dev is never asked over the network: its api.json is answered
// with catalogue (an excerpt of the real one, test/models-dev.json, unless
// a test sets another), as a Response, a status to fail with, "hang" (no
// answer until the plugin gives up), or "down" (no connection). asked
// counts the requests.
const FIXTURE = JSON.parse(readFileSync(join(here, "models-dev.json"), "utf8"))
let catalogue = FIXTURE
let asked = 0
{
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).origin !== "https://models.dev") return real(url, init)
    asked++
    const c = catalogue
    if (c === "down") throw new TypeError("fetch failed")
    if (c === "hang") {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)))
    }
    if (typeof c === "number") return new Response("down for maintenance", { status: c })
    if (typeof c === "string") return new Response(c, { status: 200, headers: { "content-type": "text/html" } })
    return new Response(JSON.stringify(c), { status: 200, headers: { "content-type": "application/json" } })
  }
}

// models.dev's entries are kept in a cache directory of the tests' own
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "mps2a-cache-"))

// fresh is the plugin as a magpie that has just loaded it: a module of its
// own, with nothing of models.dev kept yet (restarted: what an earlier
// load kept on disk stays)
let loads = 0
async function fresh({ restarted = false } = {}) {
  if (!restarted) rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true })
  const mod = await import(new URL(`../index.mjs?load=${++loads}`, import.meta.url))
  return mod.Sub2apiPlugin({ client: fakeClient() })
}

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

// the site's Codex models manifest, as the key gets it
async function manifest(key) {
  const res = await fetch(state.base + "/backend-api/codex/models", { headers: { authorization: `Bearer ${key}` } })
  assert.equal(res.status, 200, "the Codex models manifest")
  return res.json()
}

// fetch as the site answers, but for the paths in rewrites: a status to
// fail with, or a function of the site's JSON answer
async function withSite(rewrites, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    const r = u.origin === new URL(state.base).origin ? rewrites[u.pathname] : undefined
    if (r === undefined) return real(url, init)
    if (typeof r === "number") return new Response("rewritten", { status: r })
    const res = await real(url, init)
    return new Response(JSON.stringify(r(await res.json())), { status: res.status, headers: { "content-type": "application/json" } })
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test("provider.models: the key's group's models, Claude on /v1/messages", async () => {
  const provider = { id: "sub2api", models: { kept: {} } }
  const models = await hooks.provider.models(provider, { auth: signIn(state.keys.subscription) })
  const upstream = await manifest(state.keys.subscription)
  writeFileSync(join(out, "models.json"), JSON.stringify({ tag, models, manifest: upstream }, null, 2) + "\n")
  const ids = Object.keys(models)
  assert.ok(ids.length > 0, "no models")
  assert.ok(ids.some((id) => id.startsWith("claude-")), "no Claude model: " + ids.join(", "))
  for (const id of ids) {
    const m = models[id]
    assert.equal(m.providerID, "sub2api")
    assert.equal(m.api.url, state.base + "/v1")
    if (id.startsWith("claude-")) assert.equal(m.api.npm, "@ai-sdk/anthropic")
    // a thinking model has reasoning levels to pick from
    if (m.capabilities.reasoning) assert.ok(Object.keys(m.variants).length > 0, `${id}: no variants`)
  }
  // the levels are the ones the site's manifest tells, in its order; a
  // model it lists as ["none"] alone (one it knows nothing of) gets the
  // plugin's own
  const levels = (m) => (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? l)
  const listed = upstream.models.filter((m) => models[m.slug])
  const told = listed.filter((m) => levels(m).some((l) => l !== "none"))
  assert.ok(told.length > 0, "the manifest tells no model's levels")
  for (const m of told) {
    assert.deepEqual(Object.keys(models[m.slug].variants), levels(m), m.slug)
    assert.equal(models[m.slug].capabilities.reasoning, true)
  }
  for (const m of listed.filter((m) => !told.includes(m))) {
    assert.deepEqual(levels(m), ["none"], m.slug)
    if (models[m.slug].capabilities.reasoning) assert.deepEqual(Object.keys(models[m.slug].variants), ["low", "medium", "high"], m.slug)
  }
  // a key the site refuses: the account is marked signed out
  await assert.rejects(hooks.provider.models(provider, { auth: signIn("sk-not-a-key-0000") }), (e) => e.signIn === "expired")
  // no key: the list magpie has stays
  assert.equal(await hooks.provider.models(provider, {}), provider.models)
})

test("provider.models: reasoning levels when the site's manifest can't tell them", async () => {
  const auth = signIn(state.keys.subscription)
  const told = await hooks.provider.models({ id: "sub2api", models: {} }, { auth })
  const claude = Object.keys(told).find((id) => id.startsWith("claude-"))
  // a model that doesn't think, listed next to the site's own
  const plain = "plain-chat-model"
  const listed = { "/v1/models": (b) => ({ ...b, data: [...b.data, { id: plain, display_name: "Plain" }] }) }
  const provider = { id: "sub2api", models: { [claude]: { variants: { custom: { budget: 1 } } } } }

  // the manifest fails: the list stands, the variants magpie has are kept,
  // other thinking models get low/medium/high, a plain model none
  const failed = await withSite({ ...listed, "/backend-api/codex/models": 500 }, () => hooks.provider.models(provider, { auth }))
  assert.deepEqual(Object.keys(failed).sort(), [...Object.keys(told), plain].sort())
  assert.deepEqual(failed[claude].variants, { custom: { budget: 1 } })
  assert.equal(failed[claude].capabilities.reasoning, true)
  for (const [id, m] of Object.entries(failed)) {
    if (id === claude || id === plain) continue
    assert.deepEqual(Object.keys(m.variants), ["low", "medium", "high"], id)
  }
  assert.equal(failed[plain].capabilities.reasoning, false)
  assert.deepEqual(failed[plain].variants, {})

  // an answer of another shape: the same
  const garbled = await withSite({ "/backend-api/codex/models": () => "not a manifest" }, () => hooks.provider.models(provider, { auth }))
  assert.deepEqual(garbled[claude].variants, { custom: { budget: 1 } })

  // the site's levels win over the ones magpie has
  const both = await hooks.provider.models(provider, { auth })
  assert.deepEqual(both[claude].variants, told[claude].variants)

  // levels told as plain strings are the same as {effort} objects
  const strings = { "/backend-api/codex/models": (b) => ({ ...b, models: b.models.map((m) => ({ ...m, supported_reasoning_levels: (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? l) })) }) }
  assert.deepEqual(await withSite(strings, () => hooks.provider.models({ id: "sub2api", models: {} }, { auth })), told)
})

// the site's list with models its Codex manifest doesn't tell of: one with
// an official models.dev entry (deepseek's), one with resellers' alone
const OTHERS = ["deepseek-flash", "glm-4.6"]
const withOthers = { "/v1/models": (b) => ({ ...b, data: [...b.data, ...OTHERS.map((id) => ({ id, display_name: id }))] }) }

test("provider.models: models.dev's official entry when the site's manifest tells no levels", async () => {
  const auth = signIn(state.keys.subscription)
  const upstream = await manifest(state.keys.subscription)
  const levels = (m) => (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? l)
  const site = await hooks.provider.models({ id: "sub2api", models: {} }, { auth })
  const toldOne = upstream.models.find((m) => site[m.slug] && levels(m).some((l) => l !== "none"))?.slug
  const untold = upstream.models.find((m) => site[m.slug] && !levels(m).some((l) => l !== "none"))?.slug
  assert.ok(toldOne && untold, "the manifest has a model it tells levels for and one it doesn't")
  // Anthropic's own entries for both, with levels of the catalogue's own
  const entry = (id, values) => ({ id, canonical_model_id: `anthropic/${id}`, reasoning: true, reasoning_options: [{ type: "effort", values }], limit: { context: 200000, output: 64000 } })
  catalogue = { ...FIXTURE, anthropic: { id: "anthropic", models: { [toldOne]: entry(toldOne, ["from-models-dev"]), [untold]: entry(untold, ["low", "high"]) } } }
  try {
    const h = await fresh()
    const was = { [untold]: { variants: { custom: { budget: 1 } } } }
    const before = asked
    // magpie asks for several accounts' lists at once: models.dev is asked once
    const [got, again] = await withSite(withOthers, () => Promise.all([h.provider.models({ id: "sub2api", models: was }, { auth }), h.provider.models({ id: "sub2api", models: was }, { auth })]))
    assert.equal(asked - before, 1, "models.dev asked once")
    assert.deepEqual(again, got)
    writeFileSync(join(out, "models-dev.json"), JSON.stringify({ tag, models: Object.fromEntries([...OTHERS, toldOne, untold].map((id) => [id, got[id]])) }, null, 2) + "\n")

    const ds = got["deepseek-flash"]
    assert.equal(ds.api.npm, "@ai-sdk/openai-compatible")
    assert.equal(ds.capabilities.reasoning, true)
    assert.deepEqual(Object.keys(ds.variants), ["low", "high", "max"])
    assert.deepEqual(ds.capabilities.interleaved, { field: "reasoning_content" })
    // deepseek's own limits, not 302ai's resold entry's
    assert.deepEqual(ds.limit, { context: 1000000, output: 393216 })

    // resellers' entries alone (glm-4.6's canonical is none, or zhipuai's
    // under aihubmix): as if models.dev had nothing to say
    const glm = got["glm-4.6"]
    assert.equal(glm.capabilities.reasoning, false)
    assert.deepEqual(glm.variants, {})
    assert.equal(glm.capabilities.interleaved, false)
    assert.deepEqual(glm.limit, { context: 0, output: 0 })

    // the site's levels win over models.dev's; models.dev's over magpie's
    assert.deepEqual(got[toldOne].variants, site[toldOne].variants)
    assert.deepEqual(got[toldOne].limit, { context: 200000, output: 64000 })
    assert.deepEqual(Object.keys(got[untold].variants), ["low", "high"])

    // a while later: still the one ask
    await withSite(withOthers, () => h.provider.models({ id: "sub2api", models: {} }, { auth }))
    assert.equal(asked - before, 1, "models.dev kept")

    // magpie restarted (as when the plugin's options change): what was
    // kept on disk is read, models.dev isn't asked again
    const back = await fresh({ restarted: true })
    const after = await withSite(withOthers, () => back.provider.models({ id: "sub2api", models: was }, { auth }))
    assert.equal(asked - before, 1, "models.dev kept across a restart")
    assert.deepEqual(after, got)
  } finally {
    catalogue = FIXTURE
  }
})

test("provider.models: models.dev down, slow or garbled is as if it had nothing to say", async () => {
  const auth = signIn(state.keys.subscription)
  const list = async (c) => {
    catalogue = c
    try {
      const h = await fresh()
      const t0 = Date.now()
      const got = await withSite(withOthers, () => h.provider.models({ id: "sub2api", models: {} }, { auth }))
      return { got, ms: Date.now() - t0 }
    } finally {
      catalogue = FIXTURE
    }
  }
  const { got: none } = await list({})
  // what the plugin did before models.dev: deepseek-flash, on chat
  // completions with no "think" in its name, doesn't think
  assert.equal(none["deepseek-flash"].capabilities.reasoning, false)
  assert.deepEqual(none["deepseek-flash"].variants, {})
  for (const c of [503, "<html>not JSON</html>", ["not", "a", "catalogue"], "down", "hang"]) {
    const { got, ms } = await list(c)
    assert.deepEqual(got, none, JSON.stringify(c))
    // given up well before the site's own requests would be
    assert.ok(ms < 10_000, `${JSON.stringify(c)}: ${ms} ms`)
  }
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
