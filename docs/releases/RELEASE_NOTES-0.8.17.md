# DS-link v0.8.17 — Private release / 私有正式版

This is an **owner-authorized GitHub release in a private repository**, not a public release. The repository stays private; only collaborators with access can view and download it. Nothing is published to npm, and existing installations are not automatically updated.

v0.8.17 supersedes v0.8.16 for one narrow correction and otherwise contains the same product.

## What changed in 0.8.17

- **Team members are excluded from the live-running override.** A teammate can also appear as a direct catalog child. Because a Team send is only an admission, an older run of that teammate must still not be presented as this turn's run; the live badge now applies the "already running counts as running" rule only to ordinary direct subagents. A start proven inside the turn still turns it blue.
- Everything from v0.8.16 remains: the live turn reports the direct children the parent is working on now (same live source as the Host subagent menu, deduplicated by stable id), history keeps its own dispatch/completion evidence, a background child that stops is removed instead of being shown as this turn's completion, and the live row drops the "本轮" wording when it includes work another turn started.

This release does **not** install itself into the daily profile, restart the Host, publish npm, or upload promotional videos.

## Download and install

Download `wangmo-bit-ds-link-0.8.17.tgz` and `SHA256SUMS` from this release. The SHA-256 and source commit are also recorded in `release-manifest.json`.

Back up the target profile first, then use the official plugin entry:

```sh
dsh plugin --profile <your-profile> add /absolute/path/to/wangmo-bit-ds-link-0.8.17.tgz
```

An isolated test profile is recommended before changing a daily installation. The package does **not** include or apply the optional Host bridge. Read the [installation guide](../installation.en.md) and [known limits](../known-issues.en.md); do not force a bridge onto an unrecognized Host bundle.

## Compatibility and limits

- Node.js 24; declared DSH versions: `0.2.1-rc.5` and `0.2.2-rc.1`. Verified environments are primarily Linux Web/Chromium; macOS/Windows plugin runtime compatibility is not claimed.
- Full bubble flow depends on the separately maintained, exact-version Host bridge. Card mode remains available without that bridge.
- The live row reads the Host's `uiSession.sessionStatus` when present and falls back to the session-list summary otherwise. A Host that never publishes live status can still show a stale grey badge.
- Currency/math syntax is ambiguous. Malformed backticks or link parentheses are left unchanged; native card mode and other ambiguous cases may still be affected by Host parsing.
- No cross-machine/team-network/public-network communication is implemented. Accepted delivery is not task completion or human approval.
- Cross-version ledger/pending-queue downgrade safety is not generally guaranteed. Do not use a code backup as proof that data rollback is safe.

Validation uses the final source commit: disposable non-root Linux, private executable `/tmp` tmpfs, offline test execution, build/package allowlist and isolated official-CLI installation. Exact checks and artifact identities accompany the release; synthetic UI checks are not live-model end-to-end certification.

## 中文摘要

本版是所有者授权的 **GitHub 私有正式版**，不是公开发版。仓库继续私有，仅有访问权限的成员可下载；不发 npm、不自动更新日用、不重启 Host、不上传视频。

v0.8.17 修正 v0.8.16 的一个窄边界：**Team 成员即使也出现在子智能体目录里，也不会因为“恰好正在运行”就被当作本轮已开工。** Team 投递仍只算接收；只有本轮能证明的启动才显示运行中。其余内容与 v0.8.16 相同：活跃轮按宿主子智能体菜单同源的实时状态显示该父会话正在工作的直接子 agent；历史轮保留原轮派发与完成证据；后台子 agent 停止后从活跃行移除，不冒充本轮完成。

附件为 `.tgz`、`SHA256SUMS` 与 `release-manifest.json`。先备份目标 profile，再通过官方 `dsh plugin --profile <profile> add <tgz>` 安装；推荐先用隔离 profile 验证。宿主桥接是独立维护动作，包不会自动给 Host 打补丁。完整兼容边界见[安装说明](../installation.md)与[已知限制](../known-issues.md)。
