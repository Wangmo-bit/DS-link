# Session Link 0.8.3 — DSH 0.2.2-rc.1 适配候选 / rc.1 compatibility candidate

- 适配已发布 DSH **0.2.2-rc.1**（Cordis 4.1）：逐项核对配置读取、工具注册与分步准入、提示词组装、Session 查询/创建与投递、`session/event` 监听释放、`createUserMessage` 导出；只改直接受影响点，未重写、未加功能。
- 同一候选已在 **0.2.2-rc.1** 与 **0.2.1-rc.5** 的真实宿主中加载并跑通信关键行为；`engines.dsh` 与相关 peer 相应声明为 `0.2.1-rc.5 || 0.2.2-rc.1`。未在其它 DSH/Node/平台验证。
- 统一图标保留；功能、配置、数据与安装格式均不变。测试使用独立 HOME/DSH_HOME/DSH_AGENTS_HOME、合成工作区与合成会话，不复制活动 profile、凭据、配对或真实会话，不调用真实模型/订阅/飞书/业务接口。
- This candidate was verified against both DSH 0.2.1-rc.5 and 0.2.2-rc.1 in isolated hosts; only API compatibility and the existing messaging behavior changed. No functional additions. The unified icon is kept. Test data was synthetic, isolated from the active profile and credentials.

## 验证边界 / Verification boundary

- 已验：两版真实宿主装载（插件服务、8 个工具、rc.1 异步分步准入）、`create → 目标 Session 上下文收到 agent-message → 显式 reply → 发送方收到`、重启后账本与会话恢复；rc.1 隔离 Web 客户端 bundle 加载（200、无 pageerror/console error、侧栏入口出现）；原有完整套件在隔离容器 461 通过 / 0 跳过。
- 未验：**未经过模型工具调用层**——测试直接调用已注册工具定义（真实宿主服务链，但未让模型发起 tool call）；rc.1 隔离 Web 未配置模型路由，**聊天内皮肤/卡片未实际打开**；Windows/macOS 与其它部署形态；跨版本数据降级/回退未演练。
