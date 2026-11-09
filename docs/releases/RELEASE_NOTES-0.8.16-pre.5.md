# DS-link 0.8.16-pre.5 — 美元金额显示修复

**日用修复候选，未公开发布。**

- 气泡模式中，当同段多个美元金额被宿主误当成一段数学公式时，对可明确识别的常见写法做保守显示修正；继续使用宿主原生正文组件、图片和操作行。
- 原始消息、复制与引用不改；常见行内/块级公式、代码及链接保持原意，用户消息和卡片模式的宿主原生渲染不被接管。
- Markdown 中货币与单美元数学本身存在歧义；未闭合反引号/链接括号会保守保留原样，卡片模式及其他模糊写法可能仍受宿主解析器影响。详情见[已知限制](../known-issues.md)。
- 非 root / 隔离 tmpfs 完整回归 500/500、无跳过；真实 Host parser 与隔离浏览器合成消息验证金额、加粗、公式、代码和双模式。未更改账本格式、Host 安装、服务进程或公开状态。

Bubble mode conservatively disambiguates obvious currency prose from inline math for presentation only. Original text, copy/quote and native Host actions remain unchanged; ambiguous or malformed input and native card-mode rendering remain subject to Host parsing. No public release.
