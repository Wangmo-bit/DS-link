# Session Link 0.8.9 — 收发状态小符号语义 / delivery glyph semantics

- 统一语义（用户 2026-11-08 确认）：
  - **发出**：转圈 = 还在投递/尚未确认；✓ = 对方宿主已确认收到；× = 失败/取消；? = 无法确认。✓ 不再表示“已进入上下文”，也不表示已读——细节放提示文字。
  - **收到**：绝不显示 ✓；只有“已记录但还没进入模型上下文”这一真实等待状态显示转圈，之后只写“收到消息”。
- 直接 agent 消息（`send_message`）新增“发送中”：工具调用记录一出现就显示胶囊＋转圈，宿主确认后变 ✓、失败变 ×。仅对可验证的直接父子会话接管，其余保持原生工具行；历史中未结算的旧调用显示 ?，不会永久转圈。卡片模式仍在确认后才出现，外观不变。
- 仅客户端展示变化；协议、账本、权限、宿主与卡片模式内容不变。
- Unified delivery glyphs: spinner while sending, ✓ only after the receiving Host confirms, × on failure, ? when unknown; received capsules never show a check and keep a spinner only while a recorded message still waits to enter context. Direct-agent messages now show a sending capsule from the tool call itself.
