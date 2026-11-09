# DS-link v0.8.16-pre.6 — Private preview / 私有预发布

This is an **owner-authorized GitHub prerelease in a private repository**, not a stable or public release. The repository stays private; only collaborators with access can view and download it. Nothing is published to npm, and existing installations are not automatically updated.

## Included

- **Local session collaboration:** registered DSH sessions can exchange notifications, requests and explicitly linked replies, including across workspaces on the same Host.
- **Bubble and card views:** lightweight communication capsules, on-demand message exchanges and native chat actions within the documented Host compatibility limits.
- **Currency display fix:** bubble mode conservatively prevents obvious dollar amounts from swallowing prose as inline math. Original message text, copy and quote remain unchanged; native card-mode rendering is not replaced.
- **Unified identity:** DS-link / `@wangmo-bit/ds-link`; existing `session_link_*` tools, API/state namespaces and browser preferences remain compatible.
- **Documentation:** English is the default home page; acknowledgments now name DS-Bot and Claude. No promotional videos are uploaded with this release.

Compared with the daily-use `0.8.16-pre.5` candidate, this release updates packaging identity and documentation; it adds no further runtime feature or ledger-format changes. It does **not** install itself into the daily profile or restart the Host.

## Download and install

Download `wangmo-bit-ds-link-0.8.16-pre.6.tgz` and `SHA256SUMS` from this release. The SHA-256 and source commit are also recorded in `release-manifest.json`.

Back up the target profile first, then use the official plugin entry:

```sh
dsh plugin --profile <your-profile> add /absolute/path/to/wangmo-bit-ds-link-0.8.16-pre.6.tgz
```

An isolated test profile is recommended before changing a daily installation. The package does **not** include or apply the optional Host bridge. Read the [installation guide](../installation.en.md) and [known limits](../known-issues.en.md); do not force a bridge onto an unrecognized Host bundle.

## Compatibility and limits

- Node.js 24; declared DSH versions: `0.2.1-rc.5` and `0.2.2-rc.1`. Verified environments are primarily Linux Web/Chromium; macOS/Windows plugin runtime compatibility is not claimed.
- Full bubble flow depends on the separately maintained, exact-version Host bridge. Card mode remains available without that bridge.
- Currency/math syntax is ambiguous. Malformed backticks or link parentheses are left unchanged; native card mode and other ambiguous cases may still be affected by Host parsing.
- No cross-machine/team-network/public-network communication is implemented. Accepted delivery is not task completion or human approval.
- Cross-version ledger/pending-queue downgrade safety is not generally guaranteed. Do not use a code backup as proof that data rollback is safe.

Validation uses the final source commit: disposable non-root Linux, private executable `/tmp` tmpfs, offline test execution, build/package allowlist and isolated official-CLI installation. Exact checks and artifact identities accompany the release; synthetic UI checks are not live-model end-to-end certification.

## 中文摘要

本版是所有者授权的 **GitHub 私有预发布**，不是稳定版或公开发版。仓库继续私有，仅有访问权限的成员可下载；不发 npm、不自动更新日用、不重启 Host、不上传视频。

包含现有本机会话通信、气泡/卡片展示及美元金额显示修复；在 `pre.5` 日用候选基础上整理版本身份、安装包和中英文说明，致谢保留 DS-Bot 与 Claude。工具/API/账本标识保留兼容，本版没有额外的运行时功能或数据格式变更。

附件为 `.tgz`、`SHA256SUMS` 与 `release-manifest.json`。先备份目标 profile，再通过官方 `dsh plugin --profile <profile> add <tgz>` 安装；推荐先用隔离 profile 验证。宿主桥接是独立维护动作，包不会自动给 Host 打补丁。完整兼容边界见[安装说明](../installation.md)与[已知限制](../known-issues.md)。
