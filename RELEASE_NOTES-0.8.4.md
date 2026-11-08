# Session Link 0.8.4 — rc.1 用户气泡崩溃修复 / rc.1 user-bubble fix

- 修复 DSH 0.2.2-rc.1 气泡模式下用户消息渲染崩溃：rc.1 官方 `conversation.chat.node` 的 `user` 注册新增 `children: { 'conversation.chat.user.before': { kind: 'chain' } }`，宿主据此向渲染器注入 `renderSlotChain`。插件重注册该插槽时只复制了 `name/key/priority/locale/inject`，丢掉 `children`，导致官方 `UserStyleBubble` 收到 `undefined` 并抛 `renderSlotChain is not a function`（宿主记录 slot entry crashed，用户气泡回退为原生样式）。
- 现在仅在原生注册声明了 `children` 时原样保留；rc.5 原生注册无该字段，路径与行为不变。补充 rc.1 形态的定向回归测试，不改宿主侧接口、功能、数据或安装格式。
- Fixes the rc.1 bubble-mode crash caused by dropping the official `user` seat's child-chain declaration when re-registering `conversation.chat.node`. The declaration is now preserved only when the native registration carries it, so rc.5 behavior is unchanged.
- 验证：rc.1 与 rc.5 隔离宿主打开真实会话，用户气泡恢复作者标签/皮肤且无 `renderSlotChain` 报错；原测试套件与冷审见交付报告。正式安装后客户端可能刷新即可加载；若宿主启动时缓存插件清单，则由所有者重启。
