# Session Link 0.8.12 — 恢复助手消息操作按钮 / message actions are back

- 修复 0.8.x 回归：气泡模式把宿主的 `turn-tail` 行当成机制行静默，连带删掉了每条助手消息下方的操作行——复制、好评/差评、在新对话中分支、用量/时间信息、以及“信息”按钮全部消失。
- `turn-tail` 改为正常渲染：与气泡左对齐、紧跟气泡下方，沿用宿主原生悬停显示（鼠标移到消息下方即可看到按钮），键盘与无障碍名称不变。
- 只恢复宿主原本的能力，不复制、不重造按钮；卡片模式、用户消息操作、投递协议不变。
- Restores the Host's `turn-tail` row in bubble mode so copy / rating / branch / usage actions appear under each assistant message again (hover-revealed, native, unchanged semantics).
