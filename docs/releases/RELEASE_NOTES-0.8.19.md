# 0.8.19 — 气泡胶囊分组修复 / Bubble capsule grouping

Public release, published to npm and GitHub together. It includes no protocol, ledger-format, permission or Host-bridge changes.

公开正式版，npm 与 GitHub Release 同步发布。本次不改协议、账本格式、权限或 Host 桥接。

## 修复内容 / Fixes

- 气泡模式收发胶囊使用同一合并规则：同轮、相邻、同方向、同一已核实对象、同消息类型、同真实状态，且相邻两条间隔不超过五分钟。卡片模式仍逐条显示。
- 请求、通知、回复不混并；轮次、对象或时间不明时逐条保留。可见正文、原生回退消息、提问、计划确认、身份不符或反向胶囊会断开分组。
- 状态按投递、上下文回执（`queued` / `received`）、回复和查询新鲜度分别比较；等待进入上下文的消息不会被藏进“已收到”的分组。
- 修复流式调用从临时序号交接到持久 `tool/call` 序号/时间；修复只有发送历史首次打开时未初始化分组。
- 分组计算改为线性；相同状态不重复广播；会话窗口代际更换时撤销旧元数据。
- 合并胶囊点开仍是原有双方往返弹窗，逐条正文、时间和状态可查，最多最近 20 条，更多按需加载。

- Bubble mode uses the same grouping rule for received and sent capsules: same turn, adjacent, same direction, same verified peer, same message kind and same evidence-based state, with at most five minutes between neighbors. Card mode stays per-message.
- Requests, notifications and replies never merge. Unknown turn/peer/time stays separate. Visible text, native fallback messages, questions, plan confirmations, identity mismatches and opposite-direction capsules break a run.
- State comparison distinguishes dispatch, context receipt (`queued` versus `received`), reply state and lookup freshness, so waiting messages cannot disappear under a confirmed-receipt capsule.
- Durable tool-call sequence/time now replaces provisional live-chunk evidence, and a sent-only history initializes on first open.
- Group computation is linear; unchanged state is not republished; old window generations are revoked.
- A grouped capsule still opens the existing bounded exchange reader with every message, time and state; latest 20 entries first, older entries on demand.

## 验证 / Validation

- Full test suite in a disposable non-root Linux container with a private `/tmp` tmpfs, read-only root and no network: 524 passed, 0 failed, 0 skipped.
- Focused red-to-green regression: 1/9 passed on the pre-fix baseline, 9/9 after the fix.
- Real installed-package browser check: sent and received `×3` grouped capsules both displayed; grouped reader listed all three messages; card mode kept individual cards; receiver in separate turns stayed separate; no page errors.
- The npm package and GitHub release should be installed through the official plugin entry; this release does not restart Host or apply the optional Host bridge.

## 升级 / Upgrade

Existing 0.8.18 installations can upgrade with the normal plugin entry. No data migration is required for this change. If a Host-side bridge was installed separately, this release does not modify it.

已有 0.8.18 可按正常插件入口升级；本次不需要数据迁移。单独安装的 Host 桥接不随本版修改。
