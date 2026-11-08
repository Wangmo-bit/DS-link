# Session Link 0.8.6 — 本轮 agent 小人状态颜色修复 / per-turn agent badge state fix

- 修复气泡模式作者行右侧的 agent 小人只显示灰色“未确认”：此前只要本轮通过 `ask_agent` 复用既有 agent，完成证据就被一律视为“仅确认投递”，导致已经正常结束的 agent 也永远停在灰色。
- 现在的语义（与 0.7.0 已确认规则一致）：**运行中蓝色 → 正常结束绿色 → 无法确认/中断灰色**；红色只留给宿主能证明的真实失败，宿主目前把取消与错误折成同一个布尔，因此中断仍显示灰色，不误标失败。
- 判定收紧在必要处：本轮新建的 agent、显式 `ask_agent` 成功返回、或本轮实际观察到运行，才把“最新一轮已完成”当作本轮完成证据；仅有 Team 投递确认、历史完成或后续轮次会占用该 agent 时，仍显示未确认。已结束轮次不会被后续活动重新染蓝或染绿（旧回归保留）。
- 修复同毫秒边界：本轮新建的 agent 即使激活时间与创建时间同毫秒也按运行中显示；复用 agent 仍需严格晚于投递时间。
- 仅客户端 bundle 变化，不改数据、协议、权限或宿主；卡片模式不受影响。已安装后刷新页面生效；运行中的后端进程仍为旧版本，若要让后端也报告 0.8.6 需另行重启。
- Fixes agent badges stuck in gray after a normal finish: completion now requires positive in-turn evidence (created this turn, a successful explicit-id follow-up, or an observed run), and the documented blue → green → gray semantics apply. Red remains reserved for a host-provable failure; the current Host cannot distinguish cancellation from error, so interrupted runs stay gray.
