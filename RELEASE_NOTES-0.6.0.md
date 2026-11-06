# Session Link 0.6.0 — private pre-release candidate / 私有预发布候选

**状态 / Status:** 仅本地候选，未发布 GitHub Release、未 npm publish。/ Local candidate only; no GitHub Release or npm publish yet.

## 中文

## 本轮 0.6.0 变更（2026-11-06）

气泡模式按用户当天逐条拍板的方案重定信息架构：

- **气泡内不再展示思考/工具过程**：只留正文与一行统计（耗时 · 思考次数 · 工具次数）；不显示 token 用量。
- **统计运行中实时更新**（耗时按本轮开始时间计，思考/工具次数为真实累计），结束后定格。
- **不再出现空过程气泡**：没有正文的段不单独成泡；整轮无正文时只显示统计。
- **气泡外碎片清掉**：模型重试等系统行不再单独渲染，仅保留不可见锚点；重试成功静默，最终失败在气泡内如实说一句。
- **不再显示工具级失败**：某个工具中途失败但最终答复正常产出时，那属于过程噪音，气泡内不提示；只有整轮没给出答复（`执行失败`/`已停止`）才作为统计行前缀如实显示。
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
VERSION=0.6.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

升级/回滚：仅代码回滚候选；**未证明**旧包兼容新版账本/待投递/迁移状态，承诺数据回退前需备份恢复与 downgrade 演练。

## English

Initial cross-session communication plugin: existing ordinary DSH sessions can send `notification`/`request` and receive explicit `reply`; two-way cards show sender/recipient/subject and delivery/receipt/reply states; settings can pause, limit concurrency and set reply wait; records expose delivery evidence. Chinese/English UI and README follow the host locale; English settings/cards were smoke-tested in an isolated browser; user bodies/subjects are not translated.

Compatibility: DSH 0.2.1-rc.5, Node 24.21.0, Linux Web. Other versions untested.

Install (local tarball):

```bash
VERSION=0.6.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

Upgrade/rollback: code rollback candidate only; the old package is **not proven** compatible with newer ledger/queued/migration state. Back up and rehearse downgrade before promising data rollback.
