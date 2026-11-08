# Session Link 0.8.7 — 宽表格在气泡内滚动 / wide tables stay inside the bubble

- 修复气泡模式中 4 列以上的 Markdown 表格溢出气泡、画到页面背景上的问题。宿主表格的滚动包裹层在“按内容收缩”的气泡里 `max-width:100%` 可能计算为 `none`，导致表格按最大内容宽度撑出气泡；现在把该包裹层约束在气泡宽度内，并恢复宿主表格自身的尺寸，横向滚动留在气泡内部。
- 普通（3 列及以下）表格行为不变；代码块、图片原本的宽度约束不变。
- 仅客户端 CSS 变化，不改数据、协议、权限或宿主；卡片模式不受影响。刷新页面即生效。
- Fixes wide Markdown tables painting outside a shrink-to-fit bubble: the Host's table scroll wrapper is now constrained to the bubble, restoring the native table sizing and keeping horizontal scrolling local. Client CSS only; card mode and data are unchanged.
