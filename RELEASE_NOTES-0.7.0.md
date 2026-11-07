# Session Link 0.7.0 — private pre-release candidate / 私有预发布候选

**状态 / Status:** 仅本地候选，未发布 GitHub Release、未 npm publish。/ Local candidate only; no GitHub Release or npm publish yet.

## 中文

## 0.7.0 新增（2026-11-07）

**气泡里显示本轮派出的 agent。**

- 位置：该轮气泡的统计行末尾，用一条淡分隔符隔开。
- 形式：每个状态一个 SVG 小人图标 + 数量，同状态归组，最多三组；只有 1 个 agent 时不显示数字。
- 颜色：蓝 = 运行中，绿 = 该 agent 的所有实例都正常完成，灰 = 有实例未正常完成或状态未知。
- **不显示红色**：宿主只提供「最近一轮是否正常完成」，无法区分真错误与用户中断；把中断标成失败比显示未知更糟，所以统一归灰。
- **按 agent 去重**：同一轮里同一个 agent 派 100 次也只算 1 个；但它的**所有实例**会合并判断——第三次派出去的那次失败了，这个 agent 就不会显示成绿色。
- **本轮没派 agent 就完全不显示**，不占位。
- 数据来源：父会话的 `subagent/catalog` 投影（每个直接子会话的 label 与创建时间）+ 子会话自身的 `running` 与 `subagentTiming.lastTurnCompleted`，与宿主自己的子智能体 UI 同源。
- 归属规则：子会话的创建时间落在哪一轮的时间窗内，就属于哪一轮；落不进任何轮的（会话间隙）不猜测、不显示。

已知限制：宿主只提供"最近一轮是否正常完成"，无法区分"真错误"与"用户中断"，两者都归为灰色，避免把中断误标成失败。

## 0.6.3 调整（2026-11-07）

- **去掉重复的“思考中”**：运行中的气泡下方已有三个点表示正在工作，上面那行再写“思考中”是重复信息。现在该行只报三个点表达不了的内容：已用时间、思考次数、工具次数。

## 0.6.2 修复（2026-11-07）

- **修复：空的消息块。** 有些片段既没有正文、也不该由它显示统计（同一轮的统计已挂在另一个气泡上），却仍然渲染出一个只有作者名的空块。现在只有确实有内容（正文、运行中提示、待操作提示或结束统计）时才渲染消息块。
- **修复：运行中的思考气泡会消失。** 0.6.0 里“整轮没有正文时不留空泡壳”的规则误伤运行中的轮次：一旦出现过程片段，气泡连同里面的思考三点一起不渲染，只剩作者名和“思考中 · 耗时 · 次数”。现在运行中的轮次始终保留气泡；只有**已经结束**且确实没有正文的轮次才省略泡壳。

## 0.6.0 变更（2026-11-06）

气泡模式按用户当天逐条拍板的方案重定信息架构：

- **气泡内不再展示思考/工具过程**：只留正文与一行统计（耗时 · 思考次数 · 工具次数）；不显示 token 用量。
- **统计运行中实时更新**（耗时按本轮开始时间计，思考/工具次数为真实累计），结束后定格。
- **不再出现空过程气泡**：没有正文的段不单独成泡；整轮无正文时只显示统计。
- **气泡外碎片清掉**：模型重试、轮次末尾、轮次触发等机制行不再单独渲染，仅保留不可见锚点；宿主的终态失败行（`turn-error`）与 token 上限行为保留不动，真实失败不会被吞。
- **不再显示工具级失败**：某个工具中途失败但最终答复正常产出时，那属于过程噪音，气泡内不提示；轮次结束状态（`执行失败`/`已停止`）仍作为统计行前缀如实显示。
- **需要你操作的事项**（提问/计划确认）仍在气泡内以一行提示保留，不因折叠而丢失。
- **会话与子 agent 消息**：时间线只留居中胶囊（`收到消息，来自 X` / `已发消息给 X`），不铺正文；点击胶囊打开既有往返记录弹窗看完整交互。投递状态小图标移入胶囊内，语义不变（✓ 仅代表宿主已确认投递，不代表已读）。
- **卡片模式完全未改**：收发卡、调用卡与原生思考过程保持原样。
- 往返记录首屏双方合计 20 条；思考中三点更明显；复制按钮使用图标（气泡模式已无过程展开箭头）。

同版本纪律：0.5.0 已安装且未覆盖，本轮任何内容变化统一以 0.6.0 发布，不覆盖 0.5.0 的 tgz。

### 沿承 0.5.0 的能力范围

初版跨会话通信插件（含 `session_link_create` 的 `existingProject:{path,title?}` 已有目录登记模式）：已有 DSH 普通会话之间可发 `notification`/`request`、收明确 `reply`；双向卡片显示发件人/收件人/主题、投递/回执/回复状态；设置页可暂停、限制并发、调整回复等待；记录页可核对投递证据。中英界面/README 已提供（跟随宿主语言）；英文设置页与卡片已在隔离浏览器冒烟验证，用户正文/主题不翻译。

兼容：DSH 0.2.1-rc.5、Node 24.21.0、Linux Web。其他版本未验证。

安装（本地 tgz）：

```bash
VERSION=0.7.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

升级/回滚：仅代码回滚候选；**未证明**旧包兼容新版账本/待投递/迁移状态，承诺数据回退前需备份恢复与 downgrade 演练。

## English

Initial cross-session communication plugin: existing ordinary DSH sessions can send `notification`/`request` and receive explicit `reply`; two-way cards show sender/recipient/subject and delivery/receipt/reply states; settings can pause, limit concurrency and set reply wait; records expose delivery evidence. Chinese/English UI and README follow the host locale; English settings/cards were smoke-tested in an isolated browser; user bodies/subjects are not translated.

Compatibility: DSH 0.2.1-rc.5, Node 24.21.0, Linux Web. Other versions untested.

Install (local tarball):

```bash
VERSION=0.7.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

Upgrade/rollback: code rollback candidate only; the old package is **not proven** compatible with newer ledger/queued/migration state. Back up and rehearse downgrade before promising data rollback.
