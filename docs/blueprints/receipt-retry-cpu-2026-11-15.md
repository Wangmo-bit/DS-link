# 回执补查 CPU 修复蓝图 v4（最终候选冻结稿）

- 状态：实现完成，待最终双审绑定此 HEAD；**尚未合主干/安装/发布**
- v4：在 v3 基础上关门 P1（旧 in-flight 失败覆盖新唤醒）、P2（唤醒已到期目标导致 16 批饥饿）与版本阶段顺序；补真实 HostAdapter flush、17 目标公平性、旧失败分支回归
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

v3 闭合（本轮只补条款，不扩功能）：

- `probe.registered` = workspace 成员 **AND** 本轮 header 记录存在；registry 命中但无 header 不得直读。
- 旧 MockAdapter/无 probe 替身继续走旧 `readTargetReceipts` 契约；engine 缺失新方法时不回退全库 `getSession`。
- 性能计数只算补查路径/每批；并发工具发现/UI 标题查询不计失败；live/send 只标记待唤醒，不带外启动第二份重扫。
- 到期目标按 `(nextAt, 稳定入队序)` 取前 16；重复入队不归零/不推迟既有计划，实际失败才 attempts+1 且 nextAt=now+backoff。
- flush 恢复：合格 live 证据/新发送可打断等待；无可观察事件只承诺既定周期，不假装实时恢复。

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
3. **`registered` 必须保持旧 `getSession` 语义**：`registered = workspace 成员 AND 本轮 listSessions 确有该 header 记录`。registry 命中但 listSessions 无记录 → `registered:false`，按不可读处理，**不得直读 `readSession`**；单独加该分支回归。只有 `registered:true && subagent:false` 才进入 `readSession`。
4. 每批探测一次；结果传给 `readTargetReceipts(targetId, targetInfo)`。单测/旧调用可回退到单目标探测，但不得走 `getSession(fresh:true)`。
5. **语义保持**：`readTargetReceipts` 仍只拒绝 `registered !== true || subagent === true`；`archived`/旧格式可读目标继续 `readSession` 核证，不因 `eligible=false` 拒绝历史回执。允许新发送的 `eligible` 判断不得套到已 accepted 消息的证据读取上。
6. **旧 MockAdapter/无 probe 替身兼容**：生产 `HostAdapter` 必须实现并走新 `probeReceiptTargets`；engine 只在 `adapter.probeReceiptTargets` 是函数时做批量探测，缺失时按旧契约直接调用现有 `adapter.readTargetReceipts(targetId)`，保留现有回执测试/替身语义。**禁止** engine 在缺失时回退到真实全库 `getSession`；`readTargetReceipts` 内部也不得走 `getSession(fresh:true)`。helper 只可选加 probe，旧测试语义不变。
7. 不读取无关会话正文；`readSession(targetId)` 只在目标确认可读后执行；现有安全门（来源、身份、pending 证据）不因新内部接口绕过。

### B. 退避、恢复与唤醒

把 `#receiptRetryTargets: Set` 改为重试表 `Map<targetId,{attempts,nextAt,lastCode}>`：

- `readable:true` → 处理证据；清除重试项。
- `target_unavailable`（仅未登记/子 agent）→ 保留真实 `queued/unknown` 状态；**不删消息、不改 received、不自动重发 unknown**。
- `flush_failed` / 读取暂态错误 → 保留 attempts，短退避。
- 退避序列（使用现有注入 `this.clock()`，首次失败从 `now` 起算）：
  - 不可读/缺失：attempt 1 → `+15s`；2 → `+30s`；3 → `+1m`；4+ → `+5m` 上限。
  - 暂态：attempt 1 → `+15s`；2 → `+30s`；3+ → `+1m` 上限。
- **两类动作必须分开**：
  1. **重复入队通知**（同一 target 已被调度，再次 add）：不得归零 attempts，也不得推迟/重置既有 `nextAt`；保留原计划。
  2. **实际执行一次探测且失败**：attempts += 1，并按 `nextAt = clock() + backoff(attempts)` 重算；不能永远保留过期 `nextAt` 导致每 tick 重试。`nextAt` 首次失败即写入；两者均用注入 `this.clock()` 断言。
- 恢复/唤醒：
  - **不假设存在可靠 target 重现事件**。主要恢复靠到期的轻量周期探测（最多 5m 一次，仍只做 batch probe）。
  - 可明确的主动唤醒点：该 target 的 live receipt/session 事件（已有 observer）；向该 target 新发送（`send` 路径）。两者只把该 target 标记为待唤醒/提前到期，不启动第二份重扫，真实探测统一经受控的 batch/in-flight 路径。
  - 启动 `#catchUpReceipts` 重建未收目标并首次探测。
  - workspace registry 变化当前没有订阅；不承诺实时“重新出现”通知；若后续增加订阅，必须另立需求/测试，不在本批偷偷依赖。
- **flush 恢复可验**：合格 live 证据事件/新发送主动唤醒必须能打断退避等待（把该 target 提前到期，下一受控周期立即探测）；没有可观察事件时，只承诺最多既定退避周期（1m/5m），不假装存在实时恢复事件。
- 退避是内部调度参数，不增加用户设置/业务配额；不拉长全局 `tickMs`。

### C. 批处理、单飞与 tick 重入

- **启动** `#catchUpReceipts`：按未收目标分组后，先一次 `probeReceiptTargets(allTargetIds)`，再无探测地逐目标 `#catchUpTarget(targetId, ids, targetInfo)`。没有候选时不 probe。
- **周期** `#retryReceiptTargets`：
  1. 先按 `nextAt <= clock()` 过滤到期目标；
  2. 到期集合按 **`(nextAt, 稳定入队序)`** 排序后取前 `LIMITS.RECEIPT_RETRY_TARGETS`（16），避免只 filter 后总偏爱 Map 前 16 导致饥饿；
  3. 对到期 batch 调一次 `probeReceiptTargets(dueIds)`；无到期不 probe。
- **单 target in-flight 复用**：`#receiptReads`/Map<targetId, Promise>；已有读取则跳过/复用，不重复 `readSession`；finally 删除，不把异常留成永久 in-flight。
- **in-flight 期间出现异常/新候选**：读取失败按实际失败退避；同一 target 新到达的 message ids 必须合并到下一次受控读取，不能因旧 promise 已存在/已拒绝而丢掉后来 ids。
- **tick 单飞**：`#tickRunning` 布尔；上一轮未结束返回 `{skipped:true, reason:'tick_in_progress'}`；`try/finally` 释放，异常后下一轮仍可运行。
- 与 `start`/receipt observer/并发 send 的边界：共享 in-flight map；各触发只处理自己的 target 集合；live observer/send 只标记该 target 待唤醒，不能带外启动第二份重扫；不因并发重复读、不读无关历史。
- **计数口径**：性能断言只统计回执补查路径/每批（probe、target `readSession`、标题/body 读取）；并发合法工具发现或 UI 标题查询不计入失败，但不得由回执路径触发。
- 不扩成新队列平台；复用现有 engine 调度与 16 技术上限。

### D. 语义不变

- 只改回执证据读取的调度方式；`queued`/`uncertain`/`unknown`/`received` 状态机、deadline、transfer、UI 文案均不变。
- 不可读目标保留真实状态；不把 unknown 自动重发，不把未收到写成 received。
- 不改变 live target 的 flush 门槛：目标 live 时仍必须 flush 成功后才返回证据；flush 失败仍不可读。

## 3. 验收

必须用合成/脱敏 fixture，不读写生产会话、不对运行 Web 插桩/断点：

1. 多冷会话 + 一个缺失目标：重复 tick 时 `readTitleSnapshots` 调用数为 0；`listSessions` 在目标全缺失时为 0、有已登记目标时每批 `<=1`；不读无关 `readSession`。
2. **registry 命中但无 header 记录**：目标在 workspace registry 中，但本轮 `listSessions` 无该 header → `registered:false`，不得调用 `readSession`；单独断言。
3. 目标消失/恢复：消失时状态保持 `queued/unknown`，退避生效；**重复入队通知不归零/不推迟既有 nextAt**；**实际失败才 attempts+1 并用注入 clock 断言 nextAt=now+backoff**；恢复时（周期探测或新发送/live 事件）能收到证据并退出重试；不误记 `received`。
4. **归档/旧格式回归**：目标已归档但日志可读时，已 accepted 消息仍能核证/转 received；旧可读日志、migration-required 格式按当前语义处理，不能因本补丁拒绝。
5. live flush 失败/恢复：短退避；合格 live 证据事件/新发送能打断等待并提前到期，恢复后正常回执；没有可观察事件时只断言最多既定周期，不假装实时恢复。
6. 重启恢复：旧 ledger 未收消息仍会补查；不可读目标不导致永久 15s 高频。
7. tick 重入：人为阻塞一次 tick，第二次调用被跳过且没有重复目标读取；异常后下一轮可继续；in-flight 期间新 message ids 不丢。
8. 批处理：到期筛选后按 `(nextAt, 稳定入队序)` 排序取前 16；无到期不 probe；start 与 tick 均只 probe 一次；单 target 并发触发只读一次。
9. **旧 MockAdapter/无 probe 兼容**：不实现 `probeReceiptTargets` 的旧替身仍按现有 `readTargetReceipts` 契约工作；engine 不因缺失方法回退到全库 `getSession`，现有回执测试语义不变。
10. **真实 HostAdapter + engine 集成（合成 fake Host，无生产连接）**：
   - 用 `makeMockHost`/真实 `HostAdapter`，构造 200–500 个无关冷会话 + 1 个不在 workspace registry/无持久化日志的消失目标 + 1 个真实未收回执目标，运行 `engine.start()` 和多个 `engine.tick()`。
   - **fixture 回执消息状态钉为 `accepted`/`unknown`，非 `dispatching`**。原因：`engine.start` 对 dispatching 走存量 `readEvidence`→`getSession(fresh:true)`→标题折叠；这是启动投递恢复路径，不在本批周期补查修复范围，不能把其合法读标题算成补查回归，也不能为凑 0 弱化断言。测试对该存量路径单独计数/排除，**注明未优化**；独立回执补查链仍严格 `readTitleSnapshots=0`、无关 body=0。
   - 对 `ctx.sessionQuery` 的 `listSessions`、`readTitleSnapshots`、`readSession`、`readSurface` 及底层 body 读取加计数/禁止调用断言；计数只统计回执补查路径/每批，并发的合法工具发现/UI 标题查询不计入失败，但不能由回执路径触发。
   - 断言：全程 `readTitleSnapshots=0`；无关会话的 `readSession`/`readSurface`/body 读取=0；消失目标不产生 `readSession`；只有真实可读目标允许一次 `readSession`；标题列表 UI 路径另行调用 `listSessions` 时仍正常。
   - 明确：`test/core-receipt.test.js:398-420` 的 stub adapter 用例与 `:239-247` 的 `reads=1` 只证明回执语义/每目标调用，**不能作为真实 HostAdapter 性能证据**；新测试必须穿过真实 adapter。旧测试名如误导则改为“回执语义重试”，保留断言。
11. 回归：完整隔离测试按 `run-tests` 自动发现全部用例执行（不写死 526），全过；`npm run build`、`npm run check:public -- --pack` 通过。
12. 不退化：气泡/卡片、收发胶囊、状态文案不变；不新增依赖/权限。

## 4. 允许修改文件 / 禁区

允许：

- `src/host/adapter.js`：仅目标探测与 `readTargetReceipts` 入参/可用性路径。
- `src/core/engine.js`：仅重试表、批处理/单飞、退避、tick 保护、调用点。
- `src/core/constants.js`：仅在确需共享退避常量时改；否则保持局部常量，避免扩散。
- `test/core-receipt.test.js`：仅修误导测试名/补语义断言；不删覆盖。
- `test/host-discovery.test.js`：**调研负责人/Lead 已批准的直测扩展**（probe 双命中、归档可读、probe_failed 区分，共 3 个测试）；仅此新增，不借此扩功能或削原测试。
- 新增 `test/host-receipt-cpu.test.js`（或同义文件名）。
- `test/helpers.js`：仅为合成 fixture/spy 扩展，保持既有 helper 语义。
- **版本元数据（Lead 已批准进入最终候选）**：`CHANGELOG.md`、`package.json`/`package-lock.json`、`cordis.patch.yml`、`src/core/constants.js` 的 `PLUGIN_VERSION`、`src/host/entry-0.8.22.js`（与旧入口等价的精确版本入口）、`test/core-dispose.test.js`/`core-settings.test.js`/`host-connection.test.js`/`host-package.test.js` 对应版本/入口期望值。
- 本蓝图文件。

禁区：

- `src/client/**`、任何 UI/样式/胶囊渲染。
- Host 桥接、安装树/`node_modules`、生产 profile、生产 ledger、服务/watchdog；`src/host/entry-*` 仅允许新增/使用精确版本 `entry-0.8.22.js`，不得改宿主桥接/其他入口语义。
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
- 顺序调整（Lead 已批准）：必要版本元数据（CHANGELOG、package/lock、cordis、PLUGIN_VERSION、entry-0.8.22、版本断言测试）可先组装进**最终候选**再双审；最终 verifier/coldreview 绑定同一最终 HEAD。

## 7. v4 实现后验收矩阵（最终候选）

- 功能提交：`e03a6f4`；版本/计数提交之后形成最终 HEAD（以交付回报的 `git rev-parse HEAD` 为准）。
- 最终全量隔离测试：**538 / 538 通过，0 失败，0 跳过**（`run-tests` 自动发现；不用固定数字替代发现）。
- 新增/更新回归：
  - `test/host-receipt-cpu.test.js`：真实 HostAdapter + 300 冷会话 + 缺失目标（readTitleSnapshots=0、无关 read/body=0、`list<=1`）；真实 HostAdapter live flush 失败（不读 log，恢复后重试）；probe 初始失败批次不逐目标重 probe；tick 单飞；旧成功读与旧失败读两条 in-flight wake 分支；17 目标到期公平性；later ids 不丢。
  - `test/host-discovery.test.js`：probe `registered` 双命中（workspace AND header）、registry-only 不读、归档仍可读、probe_failed 不伪装缺失。
  - `test/core-receipt.test.js`：旧退避测试改名并加 reads/clock 断言（start=1、未到期 tick 不增、到期 tick=2），去掉 stub 性能暗示。
- v3 逐项对应：
  - §A 目标探测/不读标题：真实 HostAdapter 测试 + probe 双命中。
  - §B 退避/唤醒：backoff 时序、旧失败/旧成功 in-flight、新发送/live 唤醒、flush 失败恢复。
  - §C 批处理/单飞：批 probe 失败短路、17 目标公平性、tick 单飞/异常后恢复、later ids。
  - §D 语义不变：归档/旧格式可读、状态保持、无 fake received/unknown 重发。
- P1/P2 整改：
  - P1：旧读失败后若期间发生 wake，保留 attempts 但 `nextAt=min(existing, now)`；新增“old in-flight failure cannot overwrite newer same-id wake”。
  - P2：wake 对已过期目标用 `min(existing.nextAt, now)`，不再把目标推后；新增 17 目标批次回归。
- 正式双审仍必须绑定最终 HEAD；verifier/coldreview 旧报告（f76effa/d6f9f6e）只作为整改输入，不作为最终 PASS。

## 8. 仍待确认的最小项

已答复并纳入：归档/旧格式按现行“可读即核证”；5m/1m 退避上限接受；内部 `probeReceiptTargets` 命名与每批 `<=1` 次 header-only `listSessions` 接受；正式版本按 `0.8.22` 准备（未发现占用）。

仅剩：

1. 调研负责人/Lead 对新冻结蓝图（v4 文件 SHA）与最终 HEAD 双审的确认。
2. 双审绑定最终 HEAD 后 PASS；合主干/安装/发布仍按另行门禁。
