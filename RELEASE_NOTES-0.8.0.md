# Session Link 0.8.0 — private pre-release candidate / 私有预发布候选

**状态 / Status:** 仅本地候选；未发布 GitHub Release，未 npm publish。 / Local candidate only; no GitHub Release or npm publish.

## 变更 / Changes

- 气泡模式的已发送和收到消息胶囊统一使用灰绿色底色，深浅主题分别适配；形状、布局、文案、点击行为及投递标记语义不变。卡片模式保持原样。
- 本轮成功向既有团队成员发送消息时，该成员按团队名册身份计入本轮 agent 小人；同轮新建后发送、或多次发送同一成员只计一次。主会话 lead、失败或未确认的发送不计入。
- 发送成功仅表示宿主接收，不保证成员处理或完成；蓝色只表示成员在本轮派发后启动且当前仍在运行，并不证明那条消息已被处理。停止运行后如果没有可绑定到这次工作的可靠完成证据，显示灰色“未确认”，不沿用上一轮成功记录冒充完成。新建团队成员的完成状态需要宿主轮次摘要能够证明只有一次运行；摘要缺失或存在后续运行时保守显示未确认。任务板重新分配不会唤醒成员，不单独视为一次调用。
- 历史页面若只加载到 tool/result 而对应 tool/call 还在窗口之外，目标名字尚不能还原；加载到该调用后才能统计，不凭正文猜测。
- Bubble-mode sent/received message capsules share a muted green treatment; card mode is unchanged. A successfully admitted Team send includes the existing teammate in the current turn's deduplicated agent count. Acknowledgement is not task completion; inactive members without evidence tied to the current work remain unconfirmed.

## 安装与边界 / Install and limits

兼容目标：DSH 0.2.1-rc.5、Node 24、Linux Web。其他环境未验证。正式安装须从版本化标准 tgz 通过 DSH 官方插件入口进行并先备份目标 profile；是否需要刷新或重启，以目标环境实际加载结果为准。

```bash
VERSION=0.8.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

保留旧包不代表已演练数据回退。完整测试中含固定 `/tmp` 路径用例，必须先满足 `TESTING.md` 的独立 `/tmp` 条件；未满足时不运行这些用例。
