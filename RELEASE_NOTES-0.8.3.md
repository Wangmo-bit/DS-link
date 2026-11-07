# Session Link 0.8.3 — DSH 0.2.2-rc.1 适配候选 / rc.1 compatibility candidate

- 适配已发布 DSH **0.2.2-rc.1**（Cordis 4.1）：逐项核对配置读取、工具注册与分步准入、提示词组装、Session 查询/创建与投递、`session/event` 监听释放、`createUserMessage` 导出；只改直接受影响点，未重写、未加功能。
- 同一候选已在 **0.2.2-rc.1** 与 **0.2.1-rc.5** 的真实宿主中加载并跑通信关键行为；`engines.dsh` 与相关 peer 相应声明为 `0.2.1-rc.5 || 0.2.2-rc.1`。未在其它 DSH/Node/平台验证。
- 统一图标保留；功能、配置、数据与安装格式均不变。测试使用独立 HOME/DSH_HOME/DSH_AGENTS_HOME、合成工作区与合成会话，不复制活动 profile、凭据、配对或真实会话，不调用真实模型/订阅/飞书/业务接口。
- This candidate was verified against both DSH 0.2.1-rc.5 and 0.2.2-rc.1 in isolated hosts; only API compatibility and the existing messaging behavior changed. No functional additions. The unified icon is kept. Test data was synthetic, isolated from the active profile and credentials.
