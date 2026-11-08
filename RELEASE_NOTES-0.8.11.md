# Session Link 0.8.11 — 失败收进气泡一行 / terminal failures stay in the bubble

- 终态失败（`turn-error`、token 上限）不再作为气泡外的原生块出现。该轮气泡的一行摘要直接说明状态：`执行失败` / `已停止` / `超过上限`，后接真实耗时、思考次数、工具次数；不带错误码。
- 行尾提供“查看原因”，默认折叠；展开后宿主原始错误块显示在**气泡内**，可随时收起。原始内容不丢失。
- 用户主动停止、超过 token 上限与失败同一规则；没有气泡可承载的终态行保持原生可见，绝不静默吞掉。
- 卡片模式与投递协议不变。
- Terminal failures now collapse into the turn bubble's single summary line, with an in-bubble, collapsed-by-default "查看原因" disclosure that reveals the original Host block on demand.
