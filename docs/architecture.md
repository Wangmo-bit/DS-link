# 架构 / Architecture

[产品规范](../PRD.md) · [安全模型](security-model.md) · [安装](installation.md)

```text
用户与已有 DSH 会话聊天
        │ user intent
        ▼
Agent 的 session_link_* 工具 ──► Host 验证普通调用会话身份
        │
        ▼
持久账本 / 操作去重 / 每目标投递状态
        │
        ▼
DSH 接收目标会话输入 ──► 上下文回执 / 显式关联回复
        │
        └────────► 设置与记录面板 / 胶囊或卡片
```

## 模块

- `src/core/`：账本、设置版本、幂等、存储锁、队列、回执和回复状态。消息投递与模型工作完成分开。
- `src/host/`：DSH 插件入口、工具、owner-only RPC、宿主适配。只有 DSH 可以注入可信调用身份。
- `src/client/`：设置、记录、双模式、往返弹窗、引用和 Agent 提示。
- `scripts/`、`test/`：构建、隔离测试、受控宿主维护和离线演示生成；测试和维护工具不在安装包内。
- `docs/`：公共指南、架构、素材来源与发布准备；历史资料不作为当前使用说明。

## 两种模式是一层展示

气泡和卡片共用同一账本、消息身份、权限与状态。不通过 DOM 改写会话事件，不重造投递回执。胶囊只作入口，完整往返按需分页。

完整气泡流另通过 Host 的 `conversation.chat.flow.adapter` 接缝组合原生行；原生 DSH rc.1 没有这个接缝，仓库提供精确版本、精确字节匹配的独立维护工具。桥接不是插件包安装的一部分，不支持的宿主拒绝修改。卡片路径保留原始 Host 流。

## English summary

The Host verifies caller identity; durable core state handles operations, delivery and reply facts. Clients render that same state as capsules or cards and expose settings/records. Neither presentation mode creates authority. Full bubble-flow composition needs a separate exact-version Host bridge; card mode retains the native path. Maintenance tools are source-only and never run as package installation hooks.
