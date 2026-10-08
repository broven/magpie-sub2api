// magpie-sub2api: any sub2api site (github.com/Wei-Shaw/sub2api) as a
// magpie provider. Sign in with the site's address and an API key; the
// models the key's group serves are spoken to on the site's own endpoints,
// and auth.usage tells magpie what the key has left (its subscription's day,
// week and month, the key's own quota and rate limits, or the wallet's
// balance), as the gateway's GET /v1/usage has it.
//
// Only upstream sub2api's public endpoints are asked (/v1/models,
// /v1/usage), so any sub2api site from 0.2.14 on works. Two ways to have
// sites, both at once if you like:
//   - the "sub2api" provider: each sign-in is one account, its own site and
//     its own key, so keys on several sites (or several keys on one) pool
//     under the one provider, and magpie routes across them;
//   - the plugin's options, {"sites": [{"id", "name", "url"}, …]}: each
//     site is a provider of its own, named as you like, that groups and
//     fallbacks can name (id/model); its sign-ins are keys on that site.
// magpie fixes a plugin's providers when it loads it (one per exported
// function), so there are SLOTS site providers to fill, in the order the
// sites are listed.
//
// Every function this module exports is called as a plugin by magpie, so
// only the plugins are exported.

const ID = "sub2api"
const SLOTS = 8
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const TIMEOUT = 15_000

const HOUR = 3600
const DAY = 24 * HOUR
const SPANS = { "5h": ["5 hours", 5 * HOUR], "1d": ["24 hours", DAY], "7d": ["7 days", 7 * DAY] }

// ---- the site -----------------------------------------------------------------

// root is the site's address as typed, without the /v1 an OpenAI client's
// base URL would have, nor a trailing slash.
function root(url) {
  return String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function checkURL(value) {
  try {
    const u = new URL(root(value))
    if (u.protocol !== "https:" && u.protocol !== "http:") return "The address starts with https://"
  } catch {
    return "An address such as https://api.example.com"
  }
}

function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// label is how magpie names the account: the name given at sign-in, else
// the site's host and the end of the key, so keys on different sites (or
// two on one site) tell apart. magpie keys an account's own settings (its
// models, its share) by this name, so it stays as it was given.
function label(auth, base) {
  const given = typeof auth?.metadata?.name === "string" ? auth.metadata.name.trim().slice(0, 60) : ""
  if (given) return given
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key.length >= 8 ? " …" + key.slice(-4) : ""
  return base ? hostOf(base) + tail : ""
}

// named saves the label on the account, where magpie reads an account's
// name (accountId, else metadata.email). magpie's API-key sign-in keeps
// only {type, key, metadata} and hands a method's authorize no key, so the
// name is written the first time the account is used, in its own scope
// (client.auth.set replaces the account's sign-in, so it is kept whole).
async function named(client, id, auth, base) {
  const name = label(auth, base)
  if (!name || auth.accountId === name || typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: { ...auth, accountId: name } })
  } catch {}
}

async function get(base, path, key) {
  const res = await fetch(base + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    // the gateway's own errors, {error:{message}}, and its middleware's, {code, message}
    const why = body?.error?.message ?? body?.message ?? body?.code ?? (text.trim().slice(0, 200) || res.statusText)
    const err = new Error(`${res.status} ${why}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }
  if (body === undefined) throw new Error(`${path}: not JSON`)
  return body
}

// ---- models -------------------------------------------------------------------

// npmOf is the AI SDK package, and so the endpoint, a model is spoken to
// on: Claude on /v1/messages, OpenAI's on /v1/responses, the rest (Gemini,
// Grok, a composite group's others) on /v1/chat/completions.
function npmOf(id) {
  const s = id.toLowerCase()
  if (/^claude-/.test(s) || s.startsWith("anthropic/")) return MESSAGES
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(s)) return RESPONSES
  return CHAT
}

function runtimeModel(m, url, providerID) {
  const npm = npmOf(m.id)
  const reasoning = npm !== CHAT || /think|reason/i.test(m.id)
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: npm !== CHAT,
      toolcall: true,
      input: { text: true, image: npm !== CHAT, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

// models is what GET /v1/models lists for the key: its group's, in
// Anthropic's shape or OpenAI's as the group's platform has it.
async function models(id, base, auth) {
  const body = await get(base, "/v1/models", auth.key)
  const out = {}
  for (const m of body?.data ?? []) {
    if (typeof m?.id !== "string" || !m.id) continue
    const name = typeof m.display_name === "string" && m.display_name ? m.display_name : m.id
    out[m.id] = runtimeModel({ id: m.id, name }, base + "/v1", id)
  }
  if (!Object.keys(out).length) throw new Error("/v1/models: an empty list")
  return out
}

// ---- usage --------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const money = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2)
const pct = (used, limit) => (limit > 0 ? (100 * used) / limit : used > 0 ? 100 : 0)
const after = (iso, secs) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t + secs * 1000).toISOString() : undefined
}

function win(name, used, limit, extra = {}) {
  return { name, used: pct(used, limit), display: money(used) + " / " + money(limit), ...extra }
}

// fromUsage is magpie's usage from /v1/usage's reply, one of three:
//   - "quota_limited": the key has its own quota or rate limits; sub2api
//     then tells those and hides the subscription and the wallet;
//   - a subscription group: its day, week and month, each a window when
//     the group limits it;
//   - a balance group: the wallet, shown but not a window, since a balance
//     has no span to route by.
function fromUsage(u) {
  if (u?.mode === "quota_limited") {
    const out = { plan: "API key limits", windows: [] }
    const q = u.quota
    if (q && num(q.limit) > 0) out.windows.push(win("Key quota", num(q.used) ?? 0, q.limit))
    for (const r of Array.isArray(u.rate_limits) ? u.rate_limits : []) {
      const limit = num(r?.limit)
      if (!(limit > 0)) continue
      const [name, span] = SPANS[r.window] ?? [String(r.window ?? "Window"), undefined]
      out.windows.push(win(name, num(r.used) ?? 0, limit, { ...(r.reset_at ? { resetsAt: r.reset_at } : {}), ...(span ? { span } : {}) }))
    }
    if (u.expires_at) out.until = u.expires_at
    if (u.status === "quota_exhausted") out.error = "The key's quota is used up"
    else if (u.status === "expired") out.error = "The key has expired"
    return out
  }

  const plan = typeof u?.planName === "string" && u.planName ? u.planName : undefined
  const s = u?.subscription
  if (s && typeof s === "object") {
    const out = { plan, windows: [] }
    // A window's reset time is the one sub2api tells (daily_reset_at /
    // weekly_reset_at / monthly_reset_at, RFC 3339; being added upstream,
    // absent on 0.2.14). It isn't worked out from the window starts: the
    // day resets at the next midnight in the server's time zone, and the
    // day's and the month's windows roll over only when next used, so a
    // start + 24 hours or + 30 days would be a wrong guess. Without a told
    // reset time the day and the month have a span but no reset time. The
    // week is a rolling 7 days from its start upstream, so its start
    // + 7 days stands in until weekly_reset_at is told.
    const told = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined)
    const rows = [
      ["24 hours", s.daily_usage_usd, s.daily_limit_usd, DAY, told(s.daily_reset_at)],
      ["7 days", s.weekly_usage_usd, s.weekly_limit_usd, 7 * DAY, told(s.weekly_reset_at) ?? after(s.weekly_window_start, 7 * DAY)],
      ["30 days", s.monthly_usage_usd, s.monthly_limit_usd, 30 * DAY, told(s.monthly_reset_at)],
    ]
    for (const [name, used, limit, span, resetsAt] of rows) {
      if (!(num(limit) > 0)) continue // null or 0: no limit on this window
      out.windows.push(win(name, num(used) ?? 0, limit, { span, ...(resetsAt ? { resetsAt } : {}) }))
    }
    if (s.expires_at) {
      out.until = s.expires_at
      if (Date.parse(s.expires_at) <= Date.now()) out.error = "The subscription has expired"
    }
    if (!out.windows.length) out.balance = "Unlimited"
    return out
  }
  if (num(u?.balance) !== undefined) return { plan, balance: money(u.balance) }
  // a subscription group the user has no subscription to (or one gone):
  // the gateway lets the request through to fail, and tells no usage
  return { plan, error: "No active subscription for this key's group", windows: [] }
}

async function usage(client, id, auth, base) {
  if (auth?.type !== "api" || !auth.key) return { error: "not signed in" }
  if (!base) return { error: "No sub2api address saved with this key; sign in again" }
  await named(client, id, auth, base)
  const user = label(auth, base)
  try {
    return { user, ...fromUsage(await get(base, "/v1/usage", auth.key)) }
  } catch (e) {
    return { user, error: String(e?.message ?? e), windows: [], ...(e?.signIn ? { signIn: e.signIn } : {}) }
  }
}

// ---- the sites in the plugin's options -----------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

// slug is an id made from a site's host: api.example.com → api-example-com.
function slug(base) {
  return hostOf(base).toLowerCase().replace(/:\d+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
}

// sites are the options' sites that can be providers, at most SLOTS: each
// with an address, an id (given, else the host's) no other has, and a name
// (given, else the id). The rest are left out, and told on stderr when
// tell (once, by the first slot).
function sitesOf(options, tell) {
  const list = Array.isArray(options?.sites) ? options.sites : []
  const out = []
  const seen = new Set([ID])
  for (const [i, s] of list.entries()) {
    const why = (m) => tell && console.error(`magpie-sub2api: options.sites[${i}] left out: ${m}`)
    const bad = checkURL(s?.url)
    if (bad) {
      why(bad)
      continue
    }
    const base = root(s.url)
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : slug(base)
    if (!ID_RE.test(id)) {
      why(`id "${id}": lower-case letters, digits, - and _, at most 40`)
      continue
    }
    if (seen.has(id)) {
      why(`id "${id}" is taken`)
      continue
    }
    if (out.length === SLOTS) {
      why(`only ${SLOTS} sites can be providers`)
      continue
    }
    seen.add(id)
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : id
    out.push({ id, name, base })
  }
  return out
}

// ---- the plugin ---------------------------------------------------------------

const NAME_PROMPT = {
  type: "text",
  key: "name",
  message: "Account name (optional; empty for the site's host and the key's end)",
  placeholder: "",
}

// hooks are one provider's: id, with its site fixed (a site from the
// options) or each account's own (the "sub2api" provider's, asked at
// sign-in).
function hooks(client, id, site) {
  const baseOf = (auth) => site?.base ?? root(auth?.metadata?.baseURL)
  const prompts = site
    ? [NAME_PROMPT]
    : [
        {
          type: "text",
          key: "baseURL",
          message: "sub2api address",
          placeholder: "https://api.example.com",
          validate: checkURL,
        },
        NAME_PROMPT,
      ]
  return {
    auth: {
      provider: id,
      // each account's own site: the loader runs once per account
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const base = baseOf(auth)
        if (!base) return {}
        await named(client, id, auth, base)
        // Bearer for chat and responses, x-api-key for messages: the
        // gateway takes either
        return { baseURL: base + "/v1", apiKey: auth.key }
      },
      methods: [
        {
          type: "api",
          label: site ? `${site.name} API key` : "sub2api API key",
          placeholder: "sk-…",
          prompts,
        },
      ],
      // magpie's: the plan and how much of it is used
      async usage(getAuth) {
        const auth = await getAuth()
        return usage(client, id, auth, baseOf(auth))
      },
    },
    // the key's group's list, asked of the account's site
    provider: {
      id,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        const base = baseOf(auth)
        if (!base) return provider.models
        try {
          return await models(id, base, auth)
        } catch (e) {
          if (e?.signIn) throw e
          return provider.models
        }
      },
    },
    // a site's provider is shown by the name it was given (one the user's
    // own config gives stays)
    ...(site
      ? {
          config(cfg) {
            cfg.provider ??= {}
            const was = cfg.provider[id] ?? {}
            cfg.provider[id] = { ...was, name: was.name ?? site.name }
          },
        }
      : {}),
  }
}

export async function Sub2apiPlugin({ client } = {}) {
  return hooks(client, ID)
}

// slot(i) is the provider of the options' i-th site; nothing while there
// is none.
const slot = (i) => async ({ client } = {}, options) => {
  const site = sitesOf(options, i === 0)[i]
  return site ? hooks(client, site.id, site) : {}
}

export const Sub2apiSite1 = slot(0)
export const Sub2apiSite2 = slot(1)
export const Sub2apiSite3 = slot(2)
export const Sub2apiSite4 = slot(3)
export const Sub2apiSite5 = slot(4)
export const Sub2apiSite6 = slot(5)
export const Sub2apiSite7 = slot(6)
export const Sub2apiSite8 = slot(7)
