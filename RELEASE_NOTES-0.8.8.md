# Session Link 0.8.8 — 宽表格真正收进气泡 / wide tables inside the bubble

- 修复 0.8.7 的遗留问题：宽表格虽然不再撑宽气泡，但宿主的“全出血”样式给包裹层加了负起始外边距与等量内边距（`margin-left: calc(-1 * var(--dsh-table-lead))` + `padding-left`），把滚动视口推到气泡左外侧，导致表格左侧被裁、滚动条画在气泡外。
- 现在在气泡（含用户气泡）内抵消该偏移，表格从气泡内容区开始、在泡内横向滚动；表格自身尺寸仍用宿主原生规则。
- 仅客户端 CSS；数据、协议、权限、卡片模式不变。刷新页面即生效。
- Cancels the Host's full-bleed wide-table offset inside bubbles, so the table starts at the bubble content edge and scrolls locally instead of shifting its viewport outside the surface.
