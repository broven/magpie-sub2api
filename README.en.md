[中文](./README.md)

<!-- banner -->

# magpie-plugin-sub2api

Any [sub2api](https://github.com/Wei-Shaw/sub2api) site as a provider in [magpie](https://usemagpie.ai). Sign in with the site's address and an API key. magpie can then use the models of the key's group and route by how much of the key is left.

- **Models**: whatever `GET /v1/models` lists for the key's group. Claude models go to `/v1/messages`, OpenAI's (`gpt-*`, `o1`/`o3`…, `codex-*`) to `/v1/responses`, and the rest to `/v1/chat/completions`.
- **Usage**: from `GET /v1/usage`, turned into magpie usage windows according to how the key is billed (see the table below). magpie's usage page, menu bar and router all read these windows, so once one is full magpie steers around that key.

## Why not magpie's built-in `balance=/v1/usage`

When a custom provider is configured with `balance=/v1/usage`, magpie reads only the `rate_limits` in the reply (5h / 1d / 7d). It can't see sub2api's other two billing modes:

- a **subscription group**'s day / week / month limits, which are in `subscription`;
- a **key's own total quota**, which is in `quota`.

Neither reaches routing, so magpie keeps sending to a key that is used up. This plugin turns all three modes into windows and adds the plan name, the expiry and the balance.

## Install

In the magpie app, go to **Plugins › Discover**, search for `sub2api` and install `magpie-plugin-sub2api`.

Or from the command line:

```sh
magpie plugin add magpie-plugin-sub2api
```

## Sign in

```sh
magpie plugin login sub2api
```

It asks for the site's address first (e.g. `https://api.example.com`, with or without `/v1`), then for the API key (`sk-…`). In the app, adding a sub2api account asks for the same two.

The account shows as the site's host plus the key's last four characters, e.g. `api.example.com …a1b2`. The plugin writes this name the first time the account is used.

## Several sites, several keys, one pool

Each sign-in is one account, with its own site and its own key. Keys on different sites, and several keys on one site, all sit under the one provider `sub2api` as a pool, and magpie routes across them by each account's usage. To add another, sign in again.

## Usage modes

`/v1/usage` answers with one of three, depending on the key:

| On sub2api | Shown in magpie | Windows | Reset times |
|---|---|---|---|
| **Subscription group** (the group sets day / week / month limits) | plan = the group's name; expiry = the subscription's | `24 hours` / `7 days` / `30 days`, only those the group limits (an empty or 0 limit is left out) | week: its start + 7 days. Day and month: only when sub2api returns `daily_window_start` / `monthly_window_start` (+24 h / +30 days) |
| **Key with its own quota or rate limits** (`mode: quota_limited`) | plan `API key limits`; expiry = the key's | `Key quota` (the total) + `5 hours` / `24 hours` / `7 days` (the rate limits) | rate limits: the `reset_at` sub2api returns. The quota doesn't reset |
| **Balance group** | the plan and the wallet's balance | none | none |

An expired subscription, a used-up key quota or an expired key shows as an error in the account's usage. A key the site refuses (401) marks the account as needing to sign in again.

## Limitations

- **Balance mode isn't routed on**: a balance has no time window, so magpie only shows it and won't steer away from a key whose wallet is running low.
- **No countdown for the day and month windows**: current upstream sub2api (0.2.14) returns only when the week started, so the day and month windows have a length but no reset time. The plugin picks up `daily_window_start` / `monthly_window_start` as soon as upstream returns them.
- A key sees only the subscription of the group it is bound to. A subscription to another group on the same user needs its own sign-in with a key bound to that group.
- Signing in again with the same key adds a second account; remove the extra one.

## Compatibility

sub2api **≥ 0.2.14**. The plugin calls only upstream's public endpoints (`/v1/models`, `/v1/usage`) and relies on no site's own changes. CI runs the end-to-end tests against 0.2.14 and against the latest release.

## Development and tests

```sh
npm test                              # same as ./test/run.sh, sub2api 0.2.14 by default
SUB2API_IMAGE_TAG=latest npm test
```

Needs Docker. The test starts a throwaway sub2api (with Postgres, Redis and a fake Anthropic upstream) and sets up a subscription group, a balance group and a key with its own limits. It sends one request on each key, then calls the plugin's `auth.loader`, `auth.usage` and `provider.models` the way magpie does and checks the results. The stack is taken down with `down -v` whether the tests pass or fail. The plugin's output and the raw upstream replies for each mode are written to `test/artifacts/<tag>/`.

To check by hand with a real magpie against a real site (in a sandbox under `.e2e/`, so your own magpie config is left alone):

```sh
SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
```

For releasing, see [RELEASE.md](./RELEASE.md).

## License

MIT
