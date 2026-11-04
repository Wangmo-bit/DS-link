# Session Link 0.4.0 — private pre-release candidate / 私有预发布候选

**状态 / Status:** 仅本地候选，未发布 GitHub Release、未 npm publish。/ Local candidate only; no GitHub Release or npm publish yet.

## 中文

初版跨会话通信插件：已有 DSH 普通会话之间可发 `notification`/`request`、收明确 `reply`；双向卡片显示发件人/收件人/主题、投递/回执/回复状态；设置页可暂停、限制并发、调整回复等待；记录页可核对投递证据。支持中英界面与 README（按宿主语言切换）。

兼容：DSH 0.2.1-rc.5、Node 24.21.0、Linux Web。其他版本未验证。

安装（本地 tgz）：

```bash
VERSION=0.4.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

升级/回滚：仅代码回滚候选；**未证明**旧包兼容新版账本/待投递/迁移状态，承诺数据回退前需备份恢复与 downgrade 演练。

## English

Initial cross-session communication plugin: existing ordinary DSH sessions can send `notification`/`request` and receive explicit `reply`; two-way cards show sender/recipient/subject and delivery/receipt/reply states; settings can pause, limit concurrency and set reply wait; records expose delivery evidence. Chinese/English UI and README follow the host locale.

Compatibility: DSH 0.2.1-rc.5, Node 24.21.0, Linux Web. Other versions untested.

Install (local tarball):

```bash
VERSION=0.4.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

Upgrade/rollback: code rollback candidate only; the old package is **not proven** compatible with newer ledger/queued/migration state. Back up and rehearse downgrade before promising data rollback.
