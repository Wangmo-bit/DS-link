# Session Link 0.8.5 — rc.1 用户气泡崩溃修复 / rc.1 user-bubble fix

- 修复 DSH 0.2.2-rc.1 气泡模式用户消息渲染崩溃：rc.1 官方 `user` 座位声明 session 级子链 `conversation.chat.user.before`，宿主据此给渲染器注入 `renderSlotChain`。该声明在真实 slot entry 的顶层（`entry.children`），且同一子槽只允许官方声明一次；插件重注册座位时直接复制会触发宿主 "already declared" 抛错，读取 `options.children` 则永远为空。
- 现方案：仅在原生 entry 带子链时，通过 wrapper 的 `inject` 提供与官方 `steering` 座位相同的空链渲染器 `renderSlotChain: () => null`；不重声明子槽。rc.5 原生座位无子链，不注入，行为不变。
- 已知边界：该空链渲染器会吞掉其它插件注册到 `conversation.chat.user.before` 的装饰；当前正式组合未启用 `dsh-experimental-liveshare`，其 `SharedSessionOrigin` 不受影响。若今后启用该实验功能，需重新评估或改为不 shadow `user` 座位。
- 验证：rc.1 隔离宿主用含**人类 user 消息**的会话打开气泡视图，用户气泡恢复作者标签/皮肤且无 `renderSlotChain` 报错；rc.5 同候选复验；完整套件与独立冷审见交付报告。
- Fixes the rc.1 user-seat crash by injecting the same empty child-chain renderer the official steering seat uses, instead of redeclaring the host-owned child slot. rc.5 is unchanged. A future liveshare occupant of `conversation.chat.user.before` would be suppressed while this skin owns the seat; not enabled in the current deployment.
