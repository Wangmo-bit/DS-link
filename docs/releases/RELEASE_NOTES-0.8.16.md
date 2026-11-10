> **Superseded by v0.8.17** for one narrow correction: a Team member that also appears in the subagent catalog must still not treat an older run as this turn's run. Everything else is unchanged.

# DS-link v0.8.16 — Private release / 私有正式版

This is an **owner-authorized GitHub release in a private repository**, not a public release. The repository stays private; only collaborators with access can view and download it. Nothing is published to npm, and existing installations are not automatically updated.

## What changed in 0.8.16

- **Running agents are no longer painted grey.** The open turn's agent row now reports the direct children that parent is working on right now, using the same live running source as the Host's own subagent menu, deduplicated by stable session id. An agent that was already running before this turn asked it again counts as running; a child this turn did not dispatch is included while it runs.
- **History stays honest.** Closed turns keep their own dispatch and completion evidence. A later reuse cannot repaint an old turn as running, and a background child that stops is removed from the live row instead of being shown as this turn's completion. Team sends still count as admission only, never as proof the member started on this message.
- The live row drops the "本轮" wording when it includes work another turn started; it says what is working now, not what this turn dispatched.
- Everything from the 0.8.16-pre.5/pre.6 candidates is included: local session collaboration, bubble and card views, the conservative currency display fix, and the unified DS-link identity.

This release does **not** install itself into the daily profile, restart the Host, publish npm, or upload promotional videos.

## Download and install

Download `wangmo-bit-ds-link-0.8.16.tgz` and `SHA256SUMS` from this release. The SHA-256 and source commit are also recorded in `release-manifest.json`.

Back up the target profile first, then use the official plugin entry:

```sh
dsh plugin --profile <your-profile> add /absolute/path/to/wangmo-bit-ds-link-0.8.16.tgz
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

0.8.16 的主要修复：**正在运行的子智能体不再显示成灰色。** 活跃轮按宿主自己的子智能体菜单所用的同一实时运行来源，显示该父会话当前正在工作的直接子 agent（按稳定 ID 去重）；本轮只是再次追问、或根本没有派发的后台子 agent，只要还在运行就计入。历史轮仍保留原轮的派发与完成证据，后续复用不会把旧轮改成运行中；后台子 agent 停止后即从活跃行移除，不冒充本轮完成。Team 成员的投递仍只算接收。

包含 `0.8.16-pre.5`/`pre.6` 候选的全部内容：本机会话通信、气泡/卡片两种展示、美元金额显示修复、统一的 DS-link 身份。本版不会自动安装到日用 profile、重启 Host、发布 npm 或上传宣传视频。

附件为 `.tgz`、`SHA256SUMS` 与 `release-manifest.json`。先备份目标 profile，再通过官方 `dsh plugin --profile <profile> add <tgz>` 安装；推荐先用隔离 profile 验证。宿主桥接是独立维护动作，包不会自动给 Host 打补丁。完整兼容边界见[安装说明](../installation.md)与[已知限制](../known-issues.md)。
