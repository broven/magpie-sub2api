[English](./README.en.md)

<!-- banner -->

# magpie-plugin-sub2api

把任意一个 [sub2api](https://github.com/Wei-Shaw/sub2api) 站点接成 [magpie](https://usemagpie.ai) 的 provider：填站点地址和 API key 登录，magpie 就能用这个 key 所在分组的模型，并按 key 的剩余额度做路由。

- **模型**：取自 `GET /v1/models`（key 所在分组列出的模型）。Claude 系列走 `/v1/messages`，OpenAI 系列（`gpt-*`、`o1`/`o3`…、`codex-*`）走 `/v1/responses`，其余走 `/v1/chat/completions`。
- **用量**：取自 `GET /v1/usage`，按 key 的计费方式换成 magpie 的用量窗口（见下表）。magpie 的用量页、菜单栏和路由都读这些窗口：某个窗口用满后，magpie 会先绕开这个 key。

## 为什么不用 magpie 自带的 `balance=/v1/usage`

magpie 给自定义 provider 配 `balance=/v1/usage` 时，只解析响应里的 `rate_limits`（5h / 1d / 7d）。sub2api 的另外两种计费方式它看不到：

- **订阅分组**的日 / 周 / 月额度在 `subscription` 字段里；
- **key 自带的总额度**在 `quota` 字段里。

这两样都不进路由，magpie 会一直把请求发给已经用满的 key。本插件把三种模式都换成窗口，并带上套餐名、到期时间和余额。

## 安装

在 magpie 应用里：**插件 › Discover**，搜索 `sub2api`，安装 `magpie-plugin-sub2api`。

或者用命令行：

```sh
magpie plugin add magpie-plugin-sub2api
```

## 登录

```sh
magpie plugin login sub2api
```

先问站点地址（如 `https://api.example.com`，带不带 `/v1` 都可以），再问 API key（`sk-…`）。在应用里添加 sub2api 账号时填同样两项。

登录后账号显示为「站点域名 …key 后四位」，比如 `api.example.com …a1b2`。名字是插件在账号第一次被使用时写进去的。

## 多站点、多 key 池化

每次登录是一个账号，各自带着自己的站点地址和 key。不同站点的 key、同一站点的多个 key 都挂在同一个 provider `sub2api` 下，组成一个池，magpie 按各账号的用量在池内路由。再加一个就是再登录一次。

## 用量模式

`/v1/usage` 按 key 的情况返回下面三种之一：

| sub2api 的情况 | magpie 里看到的 | 窗口 | 重置时间 |
|---|---|---|---|
| **订阅分组**（group 设了日 / 周 / 月额度） | 套餐名 = 分组名，到期时间 = 订阅到期 | `24 hours` / `7 days` / `30 days`，只列分组设了额度的（额度为空或 0 的不列） | 周：本周窗口开始 + 7 天；日、月：sub2api 返回 `daily_window_start` / `monthly_window_start` 时才有（+24 小时 / +30 天） |
| **key 自带额度或限速**（`mode: quota_limited`） | 套餐名 `API key limits`，到期时间 = key 到期 | `Key quota`（总额度）+ `5 hours` / `24 hours` / `7 days`（限速） | 限速窗口用 sub2api 返回的 `reset_at`；总额度不重置 |
| **余额分组** | 套餐名 + 钱包余额 | 无 | 无 |

订阅过期、key 额度用完或 key 过期时，用量里显示为出错。key 被站点拒绝（401）时，账号标记为需要重新登录。

## 限制

- **余额模式不参与路由**：余额没有时间窗口，magpie 只显示余额，不会因为余额快用完而绕开这个 key。
- **日、月窗口没有倒计时**：当前上游 sub2api（0.2.14）只返回周窗口的开始时间，日、月两个窗口只有长度没有重置时间。上游以后返回 `daily_window_start` / `monthly_window_start` 时，插件会自动用上。
- 一个 key 只看得到它所绑定分组的订阅。同一用户在别的分组的订阅，要用绑定那个分组的 key 再登录一个账号。
- 同一个 key 重复登录会多出一个账号，删掉多余的即可。

## 兼容性

sub2api **≥ 0.2.14**。插件只调用上游的公开接口（`/v1/models`、`/v1/usage`），不依赖任何站点的私有改动。CI 对 0.2.14 和最新版各跑一遍端到端测试。

## 开发与测试

```sh
npm test                              # 等于 ./test/run.sh，默认 sub2api 0.2.14
SUB2API_IMAGE_TAG=latest npm test
```

需要 Docker。测试会起一套临时的 sub2api（含 Postgres、Redis 和一个假的 Anthropic 上游），建好订阅分组、余额分组和带额度的 key，每个 key 发一次请求，再像 magpie 那样调用插件的 `auth.loader`、`auth.usage`、`provider.models` 并断言结果。跑完无论成败都会 `down -v`。各模式的插件输出和上游原始响应写在 `test/artifacts/<tag>/`。

用真实 magpie、真实站点手动验证（沙盒在 `.e2e/`，不碰你自己的 magpie 配置）：

```sh
SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
```

发版流程见 [RELEASE.md](./RELEASE.md)。

## 许可证

MIT
