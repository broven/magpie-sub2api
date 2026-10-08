# 发版清单 / Release checklist

## 每次发版 / Every release

1. `npm test` and `SUB2API_IMAGE_TAG=latest npm test`. Both must pass locally (CI runs the same matrix).
2. **手动跑一遍真实 magpie / Run `./e2e.sh` against a real magpie and a real site** before tagging. Do it once per key kind you have: a subscription group's key, a balance group's key, and a key with its own quota.
   ```sh
   SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
   ```
   Check that:
   - `plugin list` / `quota` names each account `SUB2API_NAME` if set, else `host …last4` (the first `quota` may still say `API key …last4`: the name is written on first use);
   - `plugin list` shows the site's own provider as `e2e-site (E2E site, …)`, and no other `Sub2apiSite` slot left behind;
   - `quota --json` shows the windows, plan and expiry the README's table promises;
   - `models` lists the group's models under both `sub2api/` and `e2e-site/`;
   - `provider test sub2api` and `provider test e2e-site` both get an answer.
3. Bump `version` in `package.json` and commit.
4. Tag it and push the tag: `git tag v0.1.0 && git push origin v0.1.0`. The tag must be `v` + the package's version.
5. `publish.yml` runs the e2e matrix and then `npm publish --provenance --access public` over OIDC. Check the package page on npm for the provenance badge.

## 第一次发布（启用 trusted publishing）/ First publish

npm configures trusted publishing per package, in the package's settings, so the package has to exist first.

1. Create the GitHub repo `broven/magpie-sub2api` and push `main`. `package.json`'s `repository.url` must match this repo exactly (`git+https://github.com/broven/magpie-sub2api.git`).
2. Publish 0.1.0 by hand from a clean checkout of the tag:
   ```sh
   npm login
   npm publish --access public
   ```
   Don't push the `v0.1.0` tag before this: `publish.yml` would fail, because the package doesn't exist yet. If you push it afterwards, that run's publish step fails because 0.1.0 is already on npm, and that failure is expected.
3. On npmjs.com, go to **magpie-sub2api › Settings › Trusted publishing** and add **GitHub Actions** with:
   - organization or user: `broven`
   - repository: `magpie-sub2api`
   - workflow filename: `publish.yml`
   - environment: leave it empty (the workflow uses none)
4. Use the new config within 2 days, or it lapses: bump to the next version and release with a tag as above, so the first OIDC publish happens.
5. Once it works, in the same Settings page set **Publishing access** to require 2FA and disallow tokens. Then only the workflow can publish. Revoke any automation token you made.

Requirements the workflow already meets:
- `permissions: id-token: write`
- Node ≥ 22.14 (the workflow uses 24)
- npm ≥ 11.5.1 (installed in the job)
- a GitHub-hosted runner

With trusted publishing npm adds provenance on its own; `--provenance` is kept so the intent is explicit.
