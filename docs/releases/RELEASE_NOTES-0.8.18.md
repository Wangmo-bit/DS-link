# DS-link v0.8.18 — Public release / 公开正式版

**DS-link is now publicly installable.** v0.8.18 is the first public release: the same package is published to npm and attached to this GitHub release.

**DS-link 现在可以公开安装。** v0.8.18 是首个公开版本：同一个包同时发布到 npm 和本 GitHub Release。

## Install / 安装

```sh
dsh plugin --profile <your-profile> add @wangmo-bit/ds-link@0.8.18
```

Or download `wangmo-bit-ds-link-0.8.18.tgz` and `SHA256SUMS` from this release, then install the file through the same `dsh plugin ... add <path>` entry. Requires Node.js 24 and DSH; verified environments are primarily Linux Web.

也可以下载本 Release 的 `wangmo-bit-ds-link-0.8.18.tgz` 与 `SHA256SUMS`，通过同一个 `dsh plugin ... add <路径>` 入口安装。需要 Node.js 24 和 DSH；已验证环境以 Linux Web 为主。

## What changed in 0.8.18 / 本版变化

- First public release: npm package and GitHub release use the same source commit and artifact.
- `package.json` no longer sets `private`; the package can be installed from the registry.
- README, installation, release and maintenance docs now describe the public install path.
- Repository topics added: `multi-agent`, `deepseek-harness`, `dsh-plugin`, `dsh`, `agent-collaboration`, `local-first`.
- **Runtime code is unchanged from v0.8.17.** This release changes packaging identity, documentation and the install entry point, not session-collaboration behavior.

- 首个公开版本：npm 包与 GitHub Release 使用同一源码提交和制品。
- `package.json` 不再设置 `private`，可以从 registry 安装。
- 中英首页、安装、发布与维护文档改为公开安装口径。
- 仓库新增 topics：`multi-agent`、`deepseek-harness`、`dsh-plugin`、`dsh`、`agent-collaboration`、`local-first`。
- **运行时代码与 v0.8.17 相同。** 本版只改打包身份、文档和安装入口，不改会话协作行为。

## Compatibility / 兼容性

| Item | Statement |
| --- | --- |
| Node.js | 24 (tested v24.21.0) |
| DSH | Communication layer historically verified on `0.2.1-rc.5` / `0.2.2-rc.1` |
| Platform / browser | Linux Web; Chromium is the primary verified path |
| Card mode | Plugin only; no Host bridge required |
| Full bubble mode | Requires the optional Host bridge; without it you get the older node-level fallback |

macOS, Windows, the desktop app, other browsers and other DSH/Node versions are not promised as fully supported. See [installation and compatibility](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/installation.en.md) and [known issues](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/known-issues.en.md).

## Validation

- 504 tests passed, 0 failed, 0 skipped in an isolated non-root Linux container (offline, private executable `/tmp` tmpfs).
- Build and the 43-file package allowlist passed.
- Official CLI installation in a temporary isolated home passed; all 43 installed files matched the release archive.
- The release artifact is rebuilt from the final public commit and verified by SHA-256.

## Upgrade and rollback / 升级与回退

- Back up the target profile before upgrading; use an isolated profile for a first try.
- Cross-version rollback of the ledger, pending-delivery queue and migration state is **unverified**. Back up the profile and records before attempting a rollback.
- The optional Host bridge has its own backup and receipt; plugin rollback and bridge rollback are separate actions.

## Links

- [Installation and compatibility](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/installation.en.md) · [安装与兼容性](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/installation.md)
- [First use](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/quickstart.en.md) · [第一次使用](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/quickstart.md)
- [Known issues](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/known-issues.en.md) · [已知问题](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/docs/known-issues.md)
- [Security reporting](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/SECURITY.en.md) · [安全报告](https://github.com/Wangmo-bit/DS-link/blob/v0.8.18/SECURITY.md)

DS-link is an independent community plugin, not an official DeepSeek product.
