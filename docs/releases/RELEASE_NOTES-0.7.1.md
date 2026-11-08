# Session Link 0.7.1 — private pre-release candidate / 私有预发布候选

**状态 / Status:** 仅本地候选；未发布 GitHub Release，未 npm publish。 / Local candidate only; no GitHub Release or npm publish.

## 修复 / Fix

- 修复气泡模式中，本轮派出的 agent 小人可能在答复结束、刷新或加载历史后消失的问题。统计改为依据宿主发布的会话轮次边界更新，避免节点读取器对象身份不变造成的过期缓存。
- 不修改卡片模式、小人视觉及颜色语义、会话消息胶囊或现有 agent 去重规则；不扩展到后续轮次重新派活既有成员的计数。
- 统计依据仍是父会话的子会话目录与宿主运行/最近一轮完成事实。状态不足以区分失败与中断时显示未确认，不伪造红色失败。
- Fixes stale per-turn agent badges after transcript loading, turn closure, refresh, or history loading by selecting Host timeline boundary facts rather than the identity of a stable live node reader. Card mode and attribution semantics are unchanged.

## 安装与边界 / Install and limits

兼容目标：DSH 0.2.1-rc.5、Node 24、Linux Web。其他环境未验证。

正式安装须从版本化标准 tgz 通过 DSH 官方插件入口进行，并遵守插件官方安装规范；操作前备份目标 profile。是否需要刷新或重启须以目标环境实际加载及验证结果为准。

```bash
VERSION=0.7.1
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

保留旧包并不等同于已演练数据回退；旧版本对新版账本和待处理消息的兼容性尚未证明。
