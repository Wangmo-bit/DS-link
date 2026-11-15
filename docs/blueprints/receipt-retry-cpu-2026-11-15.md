# 回执补查 CPU 修复蓝图 v2（冻结前，按 Lead 修订）

- 状态：待调研负责人/plan-review 放行；**未开始实现**
- 仓：`Wangmo-bit/DS-link`（本地 `dsh-session-link-public-candidate`）
- 基线：`main` / `a2a2ed7`（本地；`origin/main` 为 `2fa6054`，本地多一个 docs-only 公共指针提交）
- 工作树：`output/worktrees/receipt-probe`（仓内，忽略目录）
- 分支：`fix/receipt-target-probe`
- 目标版本：本地候选 `0.8.22-pre.1`；正式交付建议 `0.8.22`（最终升版/打包后重绑双审）
- 范围：回执补查的目标探测、退避/恢复、批处理/单飞与相关测试文档。**不改**消息协议、ledger 格式、权限、UI、Host 桥接或安装态。

## 0. 修订点（对应 Lead 5 点）

1. **不收窄现行回执读语义**：`archived`、旧/`migration-required` 格式但宿主仍可读取的目标，继续参与历史回执核证；`target_unavailable` 只用于“未登记/子 agent”，与当前 `readTargetReceipts` 的拒绝条件一致。
2. **唤醒闭合**：不假设存在可靠“目标重现”事件；恢复主要靠有上限的轻量周期重探测，live 事件/新发送只做该 target 的主动唤醒；退避 attempts 在重复 add 时保留，不归零。
3. **批处理与单飞**：`#catchUpReceipts` 与 `#retryReceiptTargets` 都复用一次批量探测；无到期候选不探测；先按到期筛选再套 16 上限；单 target 复用 in-flight，tick 有 finally 释放。
4. **验收穿透**：加入真实 `HostAdapter` + engine 的合成 Host 测试，spy 计数精确断言；stub adapter 的旧 `reads=1` 不作为性能证据。
5. **范围/版本**：列出允许文件与禁区；`probeReceiptTargets` 只作为 adapter 内部方法；每批一次 `listSessions` 是只读 header 探测，仍有成本，不宣称零 I/O；正式 `0.8.22`。

## 1. 已核问题（只读）

- `tick` 默认 15s（`src/host/plugin.js:42`，间隔在 `:271`）。
- `engine.tick` 每轮调用 `#retryReceiptTargets`（`src/core/engine.js:1067`）。
- 重试目标进入 `#receiptRetryTargets`；每轮最多 16 个（`engine.js:888-909`）。
- `#catchUpTarget` 调 `adapter.readTargetReceipts(targetId)`（`engine.js:835-885`）。
- `readTargetReceipts` 第一步 `getSession(targetId,{fresh:true})`（`src/host/adapter.js:329-333`）；现有拒绝条件只有 `!registered || subagent`，**不因 archived 拒绝**。
- `getSession(...,{fresh:true})` → `#refresh(true)`（`adapter.js:65-102`）→ `sessionQuery.listSessions()` + **`readTitleSnapshots(ids)` 对全部登记会话**。
- 官方 `readTitleSnapshots` 对冷会话走 `inspectPersisted`，全量 JSONL/Zstd 解码；冷日志 memo 仅 2 条，多目标轮询会互相逐出。
- 结论：为一个消失/不可读目标，每 15s 触发全工作区标题刷新；目标存在且可读时才会退出重试。

## 2. 设计（最小闭合）

### A. 目标探测与 UI 标题发现拆开

新增 adapter 内部方法（不新增外部 API）：

```js
async probeReceiptTargets(targetIds) -> Map<id, {
  registered, subagent, archived, formatStatus, live
}>
```

实现约束：

1. 先读 `workspaceRegistry.list()` / `archivedSessionIds`（内存态）。不在任何 workspace 的 id 直接返回 `registered:false`，**不调用** `sessionQuery.listSessions()`。
2. 仅当至少一个 id 在 workspace registry 中时，调用一次 `sessionQuery.listSessions()`；按 header 计算 `registered/subagent/archived/formatStatus/live`。**绝不调用** `readTitleSnapshots`，也**不调用** `getSession`/`#refresh`。
3. 每批探测一次；结果传给 `readTargetReceipts(targetId, targetInfo)`。单测/旧调用可回退到单目标探测，但不得走 `getSession(fresh:true)`。
4. **语义保持**：`readTargetReceipts` 仍只拒绝 `registered !== true || subagent === true`；`archived`/旧格式可读目标继续 `readSession` 核证，不因 `eligible=false` 拒绝历史回执。允许新发送的 `eligible` 判断不得套到已 accepted 消息的证据读取上。
5. 不读取无关会话正文；`readSession(targetId)` 只在目标确认可读后执行。

### B. 退避、恢复与唤醒

把 `#receiptRetryTargets: Set` 改为重试表 `Map<targetId,{attempts,nextAt,lastCode}>`：

- `readable:true` → 处理证据；清除重试项。
- `target_unavailable`（仅未登记/子 agent）→ 保留真实 `queued/unknown` 状态；**不删消息、不改 received、不自动重发 unknown**。
- `flush_failed` / 读取暂态错误 → 保留 attempts，短退避。
- 退避序列（使用现有注入 `this.clock()`，首次失败从 `now` 起算）：
  - 不可读/缺失：attempt 1 → `+15s`；2 → `+30s`；3 → `+1m`；4+ → `+5m` 上限。
  - 暂态：attempt 1 → `+15s`；2 → `+30s`；3+ → `+1m` 上限。
- `nextAt` 首次失败即写入；重复 add/失败保留 attempts 和已有 nextAt，不每次归零。
- 恢复/唤醒：
  - **不假设存在可靠 target 重现事件**。主要恢复靠到期的轻量周期探测（最多 5m 一次，仍只做 batch probe）。
  - 可明确的主动唤醒点：该 target 的 live receipt/session 事件（已有 observer）；向该 target 新发送（`send` 路径）只重置该 target 的 attempts/nextAt；启动 `#catchUpReceipts` 重建未收目标并首次探测。
  - workspace registry 变化当前没有订阅；不承诺实时“重新出现”通知；若后续增加订阅，必须另立需求/测试，不在本批偷偷依赖。
- 退避是内部调度参数，不增加用户设置/业务配额；不拉长全局 `tickMs`。

### C. 批处理、单飞与 tick 重入

- **启动** `#catchUpReceipts`：按未收目标分组后，先一次 `probeReceiptTargets(allTargetIds)`，再无探测地逐目标 `#catchUpTarget(targetId, ids, targetInfo)`。没有候选时不 probe。
- **周期** `#retryReceiptTargets`：
  1. 先按 `nextAt <= clock()` 过滤到期目标；
  2. 到期集合再套 `LIMITS.RECEIPT_RETRY_TARGETS`（16）上限，避免未到期项目占满前 16 或饥饿；
  3. 对到期 batch 调一次 `probeReceiptTargets(dueIds)`；无到期不 probe。
- **单 target in-flight 复用**：`#receiptReads`/Map<targetId, Promise>；已有读取则跳过/复用，不重复 `readSession`；finally 删除，不把异常留成永久 in-flight。
- **tick 单飞**：`#tickRunning` 布尔；上一轮未结束返回 `{skipped:true, reason:'tick_in_progress'}`；`try/finally` 释放，异常后下一轮仍可运行。
- 与 `start`/receipt observer/并发 send 的边界：共享 in-flight map；各触发只处理自己的 target 集合；不因并发重复读、不读无关历史。
- 不扩成新队列平台；复用现有 engine 调度与 16 技术上限。

### D. 语义不变

- 只改回执证据读取的调度方式；`queued`/`uncertain`/`unknown`/`received` 状态机、deadline、transfer、UI 文案均不变。
- 不可读目标保留真实状态；不把 unknown 自动重发，不把未收到写成 received。
- 不改变 live target 的 flush 门槛：目标 live 时仍必须 flush 成功后才返回证据；flush 失败仍不可读。

## 3. 验收

必须用合成/脱敏 fixture，不读写生产会话、不对运行 Web 插桩/断点：

1. 多冷会话 + 一个缺失目标：重复 tick 时 `readTitleSnapshots` 调用数为 0；`listSessions` 在目标全缺失时为 0、有已登记目标时每批 `<=1`；不读无关 `readSession`。
2. 目标消失/恢复：消失时状态保持 `queued/unknown`，退避生效且 attempts 不被重复 add 归零；恢复时（周期探测或新发送/live 事件）能收到证据并退出重试；不误记 `received`。
3. **归档/旧格式回归**：目标已归档但日志可读时，已 accepted 消息仍能核证/转 received；旧可读日志、migration-required 格式按当前语义处理，不能因本补丁拒绝。
4. live flush 失败/恢复：短退避但恢复后正常回执；不能因退避把恢复拖到 1m/5m 上限。
5. 重启恢复：旧 ledger 未收消息仍会补查；不可读目标不导致永久 15s 高频。
6. tick 重入：人为阻塞一次 tick，第二次调用被跳过且没有重复目标读取；异常后下一轮可继续。
7. 批处理：到期筛选先于 16 上限；无到期不 probe；start 与 tick 均只 probe 一次；单 target 并发触发只读一次。
8. **真实 HostAdapter + engine 集成（合成 fake Host，无生产连接）**：
   - 用 `makeMockHost`/真实 `HostAdapter`，构造 200–500 个无关冷会话 + 1 个不在 workspace registry/无持久化日志的消失目标 + 1 个真实未收回执目标，运行 `engine.start()` 和多个 `engine.tick()`。
   - 对 `ctx.sessionQuery` 的 `listSessions`、`readTitleSnapshots`、`readSession`、`readSurface` 及底层 body 读取加计数/禁止调用断言。
   - 断言：全程 `readTitleSnapshots=0`；无关会话的 `readSession`/`readSurface`/body 读取=0；消失目标不产生 `readSession`；只有真实可读目标允许一次 `readSession`；标题列表 UI 路径另行调用 `listSessions` 时仍正常。
   - 明确：`test/core-receipt.test.js:398-420` 的 stub adapter 用例与 `:239-247` 的 `reads=1` 只证明回执语义/每目标调用，**不能作为真实 HostAdapter 性能证据**；新测试必须穿过真实 adapter。旧测试名如误导则改为“回执语义重试”，保留断言。
9. 回归：现有 526 项全量隔离测试全过；`npm run build`、`npm run check:public -- --pack` 通过。
10. 不退化：气泡/卡片、收发胶囊、状态文案不变；不新增依赖/权限。

## 4. 允许修改文件 / 禁区

允许：

- `src/host/adapter.js`：仅目标探测与 `readTargetReceipts` 入参/可用性路径。
- `src/core/engine.js`：仅重试表、批处理/单飞、退避、tick 保护、调用点。
- `src/core/constants.js`：仅在确需共享退避常量时改；否则保持局部常量，避免扩散。
- `test/core-receipt.test.js`：仅修误导测试名/补语义断言；不删覆盖。
- 新增 `test/host-receipt-cpu.test.js`（或同义文件名）。
- `test/helpers.js`：仅为合成 fixture/spy 扩展，保持既有 helper 语义。
- 本蓝图文件；最终版本的 `CHANGELOG.md`/`package.json`/入口文件在放行并完成双审后另行处理。

禁区：

- `src/client/**`、任何 UI/样式/胶囊渲染。
- `src/host/entry-*`、Host 桥接、安装树/`node_modules`、生产 profile、生产 ledger、服务/watchdog。
- `output/` 证据、`artifacts/`、其他仓。
- 不删除不可读回执、不改状态、不自动重发 unknown。
- 不新增外部 adapter API；`probeReceiptTargets` 只作为内部方法。

## 5. 回滚

- 代码级：`git revert` 本批提交；无 ledger/schema 迁移，无需数据回滚。
- 安装级：保留修复前 `0.8.21` tgz 与 sha；如安装后异常，按既有备份/官方入口回退。回退与重启由所有者执行。

## 6. 双审分工 / 版本

- 开发：在本 worktree 实现 + 自测，不碰 main / 已安装 node_modules。
- verifier：独立硬门，绑定最终候选 HEAD，跑范围核对、构建、全量隔离测试、包检查。
- coldreview：独立正确性审查，重点退避/唤醒、归档/旧格式语义、不可读/恢复、批处理/单飞/重入、安全边界、旧 ledger 兼容。
- Lead：核对两审 PASS + 整改复审，合回 main；安装/发布按所有者授权流程，npm/重启不由 Agent 执行。
- 版本：本地 `0.8.22-pre.1` 只用于隔离验证；正式 `0.8.22` 升版/打包后必须重绑双审候选，不以两个不同包冒充同一候选。

## 7. 仍待确认的最小项

1. 是否放行按此 v2 实施（plan-review 结论可后到，但开工前需明确放行）。
2. 归档/旧格式目标的“可读即核证”是否按现行语义保持（本蓝图按保持设计）。
3. 退避上限 5m（缺失/不可读）、1m（暂态）是否维持。
4. 正式版本 `0.8.22` 是否无冲突；本地 pre 候选只用于验证。
