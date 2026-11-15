# 回执补查 CPU 修复蓝图 v1（冻结前）

- 状态：待调研负责人放行；**未开始实现**
- 仓：`Wangmo-bit/DS-link`（本地 `dsh-session-link-public-candidate`）
- 基线：`main` / `a2a2ed7`（本地；`origin/main` 为 `2fa6054`，本地多一个 docs-only 公共指针提交）
- 工作树：`output/worktrees/receipt-probe`（仓内，忽略目录）
- 分支：`fix/receipt-target-probe`
- 目标版本：本地 `0.8.22-pre.1`；正式版本/发布待审后决定
- 范围：回执补查的目标存在性探测、退避/唤醒、重复扫描与 tick 重入；相关测试与文档。**不改**消息协议、ledger 格式、权限、UI 展示、安装态。

## 1. 已核问题（只读）

- `tick` 默认 15s（`src/host/plugin.js:42`，间隔在 `:271`）。
- `engine.tick` 每轮调用 `#retryReceiptTargets`（`src/core/engine.js:1067`）。
- 重试目标进入 `#receiptRetryTargets`；每轮最多 16 个（`engine.js:888-909`）。
- `#catchUpTarget` 调 `adapter.readTargetReceipts(targetId)`（`engine.js:835-885`）。
- `readTargetReceipts` 第一步 `getSession(targetId,{fresh:true})`（`src/host/adapter.js:329`）。
- `getSession(...,{fresh:true})` → `#refresh(true)`（`adapter.js:65-102`）→ `sessionQuery.listSessions()` + **`readTitleSnapshots(ids)` 对全部登记会话**。
- 官方 `readTitleSnapshots` 对冷会话走 `inspectPersisted`，全量 JSONL/Zstd 解码；冷日志 memo 仅 2 条，多目标轮询会互相逐出。
- 结论：为一个消失/不可读目标，每 15s 触发全工作区标题刷新；目标存在且可读时才会退出重试。

## 2. 设计（最小闭合）

### A. 目标探测与 UI 标题发现拆开

新增 adapter 方法（名字可按现有风格调整）：

```js
async probeReceiptTargets(targetIds) -> Map<id, {
  registered, subagent, archived, eligible, formatStatus, live
}>
```

实现约束：

1. 先读 `workspaceRegistry.list()` / `archivedSessionIds`（内存态）。不在任何 workspace 的 id 直接返回 `registered:false`，**不调用** `sessionQuery`。
2. 仅当至少一个 id 在 workspace registry 中时，调用一次 `sessionQuery.listSessions()`；按 header 计算 `registered/subagent/archived/formatStatus`。**绝不调用** `readTitleSnapshots`，也**不调用** `getSession`/`#refresh`。
3. 每轮重试批量探测一次，结果传给 `readTargetReceipts(targetId, targetInfo)`；单测/旧调用可回退到单目标探测，但不得走 `getSession(fresh:true)`。
4. 不读取无关会话正文；`readSession(targetId)` 仍只在目标确认可读后执行。

### B. 退避与再次唤醒

把 `#receiptRetryTargets: Set` 改为受控重试表（如 `Map<targetId,{attempts,nextAt,lastCode}>`）：

- `readable:true` → 处理证据；清除重试项。
- `target_unavailable`（不在注册表/子 agent/归档/migration-required）→ 保留真实 `queued/unknown` 状态，指数退避：15s → 30s → 1m → 5m 上限；不删除消息、不改 received。
- `flush_failed` / 读取暂态错误 → 短退避：15s → 30s → 1m 上限。
- 再次唤醒：目标重新出现/收到该目标 live 事件/向该目标新增发送/进程重启时的首次 catch-up；唤醒时重置 attempts。
- 不把“目标消失”写成失败或已读；不可读事实仍保留在回执状态中。

### C. tick 重入与重复扫描

- 增加单飞保护（`#tickRunning`/tick promise）：上一轮未结束时本轮返回 `{skipped:true, reason:'tick_in_progress'}`，不并发发起第二轮补查。
- 同一轮只探测一次目标集合；`#catchUpReceipts` 与 `#retryReceiptTargets` 不重复读取同一 target 的 `readSession`。
- 不延长全局 tick 掩盖问题；`tickMs` 默认保持 15s。

## 3. 验收

必须用合成/脱敏 fixture，不读写生产会话、不对运行 Web 插桩/断点：

1. 多冷会话 + 一个缺失目标：重复 tick 时 `readTitleSnapshots` 调用数为 0；`sessionQuery.listSessions` 每轮最多 1 次或目标不在 registry 时为 0；不读无关 `readSession`。
2. 目标消失/恢复：消失时状态保持 `queued/unknown`，退避生效；恢复后能收到证据并退出重试；不误记 `received`。
3. live flush 失败/恢复：短退避，恢复后正常回执；不丢消息。
4. 重启恢复：旧 ledger 未收消息仍会补查；不可读目标不导致永久 15s 高频。
5. tick 重入：人为阻塞一次 tick，第二次调用被跳过且没有重复目标读取。
6. 回归：现有 526 项全量隔离测试全过；`npm run build`、`npm run check:public -- --pack` 通过。
7. 不退化：气泡/卡片、收发胶囊、状态文案不变；不新增依赖/权限。

## 4. 回滚

- 代码级：`git revert` 本批提交；无 ledger/schema 迁移，无需数据回滚。
- 安装级：保留修复前 `0.8.21` tgz 与 sha；如安装后异常，按既有备份/官方入口回退。回退与重启由所有者执行。

## 5. 双审分工

- 开发：在本 worktree 实现 + 自测，不碰 main / 已安装 node_modules。
- verifier：独立硬门，绑定候选 HEAD，跑范围核对、构建、全量隔离测试、包检查。
- coldreview：独立正确性审查，重点退避语义、不可读/恢复、tick 重入、安全边界、旧 ledger 兼容。
- Lead：核对两审 PASS + 整改复审，合回 main；安装/发布按所有者授权流程，npm/重启不由 Agent 执行。

## 6. 待确认

1. 是否放行按此蓝图实施。
2. 退避上限 5m（不可读）/1m（暂态）是否接受。
3. 目标探测 API 命名与是否允许 adapter 每轮调用一次轻量 `sessionQuery.listSessions()`。
4. 目标版本用 `0.8.22-pre.1` 本地候选，还是等实现后再定正式版本号。
