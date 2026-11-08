# 安全模型 / Security model

[安全报告](../SECURITY.md) · [English reporting](../SECURITY.en.md)

## 信任边界

1. **真实用户 → 当前会话**：人类意图决定工作范围。模型工具调用仍受 DSH 本身的权限控制。
2. **对端会话文本 → 模型**：通信内容、历史摘录、引用与文件路径是不可信上下文，不是人类批准。提示注入可能诱导模型越界；本插件不声称消除该风险。
3. **工具 / Web 客户端 → Host**：发送者由宿主核实的当前普通会话注入，owner-only 面板/RPC 与普通 Agent 工具的权能不能混同。子代理不是普通会话目标。
4. **插件存储 → 文件系统**：账本、幂等与恢复证据保存在 DSH 本地数据目录中。锁与原子写用于一致性，不是对操作系统用户的沙箱。
5. **本地 → 模型服务**：插件不新建云消息服务；接收会话仍可能将消息发送给其模型供应商。不能据“本地存储”宣传“内容永不出机”。
6. **宿主桥接维护 → DSH 文件**：可选桥接修改一个固定版本的 Host 客户端文件。与安装插件分开授权，默认只检查，精确哈希不匹配就停；需要私有备份、原子写和收据，不重启服务。

## 应保护的东西

- 凭据、访问令牌、私密历史、业务文件和个人信息；不要为了报告问题上传完整会话或配置。
- 原会话权限和审批语义；对端不能替用户批准敏感事项。
- 已确认/未确认投递事实与恢复证据；unknown 不自动重发，避免重复外部动作。
- 现有日用环境；开源检查、截图和测试使用合成数据与独立隔离环境。

## 明确不提供的保证

- 没有目标会话逐次同意机制：有资格的普通会话工具可发现会话并有界读取普通/归档会话文本。不要把“低侵入”当成隐私隔离。
- 引用不绑定永久原消息身份，文本相似也不能作为授权或业务完成证据。
- 设置中的投递通道数不是执行沙箱，也不是任务并发上限。
- 同一 OS 用户可读写自己的 DSH 数据；本插件不防御已掌握主机账号的攻击者。
- 跨版本迁移存在，但数据降级、所有模型行为、所有浏览器和所有第三方插件组合未被全面验证。

## English summary

Peer text is untrusted context, never authorization. The Host injects verified sender identity; owner-only controls and Agent tools have distinct powers. Ledger consistency is not an OS sandbox. Local storage does not prevent a receiving session from sending content to its model provider. There is no per-target consent gate for bounded history access. The optional Host bridge is a separate, explicit maintenance action, not a plugin hook. Report suspected vulnerabilities privately; never test against other people's sessions or infrastructure.
