// The plugin, called as magpie calls it, against the real sub2api that
// test/run.sh starts and test/setup.mjs fills (STATE names the JSON
// setup printed). What each hook gave, next to what sub2api answered, is
// written to test/artifacts/<SUB2API_IMAGE_TAG>/.

import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Sub2apiPlugin } from "../index.mjs"

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
  assert.equal(week.resetsAt, plus(s.weekly_window_start, 7 * DAY))
  // sub2api tells the day's and the month's starts only from the version
  // that has them; until then those have no reset time
  if (s.daily_window_start) assert.equal(day.resetsAt, plus(s.daily_window_start, DAY))
  else assert.equal(day.resetsAt, undefined)
  if (s.monthly_window_start) assert.equal(month.resetsAt, plus(s.monthly_window_start, 30 * DAY))
  else assert.equal(month.resetsAt, undefined)
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
