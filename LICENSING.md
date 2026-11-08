# 许可证与第三方内容

## 状态

**MIT License 已生效**，不是建议草案。正式文本见根目录 [LICENSE](LICENSE)；`package.json` 与 lock 中的 `license` 为 `MIT`。版权人署名为 `Wangmo-bit`。

## 项目自有内容

本项目有权许可的代码和文档采用 MIT。MIT 只覆盖这些内容；不自动覆盖第三方代码、图标、素材、依赖、字体或参考项目的作品。

**不要把本仓库描述成“没有第三方代码”或“全部原创”**：仓库中包含从 DSH 派生的桥接代码/片段、来自 Lucide/Feather 的图标路径，以及适配自 DS-Bot `fold.js` 的 fold/preview helpers；这些材料各自保留许可证，完整文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 第三方材料与参考

- **DeepSeek Harness（DSH）**：MIT，`Copyright (c) 2026 DeepSeek`。可选 Host 气泡桥接工具从精确版本的 DSH Web Chat 客户端派生/打补丁，相关材料保留 DSH 的 MIT 许可；桥接工具本身不在插件 tgz 内。
- **Lucide 图标**：ISC，`Copyright (c) 2026 Lucide Icons and Contributors`。一键引用图标来自 Lucide 的 `quote` 图标。
- **Feather 派生图标**：MIT，`Copyright (c) 2013-present Cole Bemis`。侧栏 `link` 图标是 Feather 派生路径（经 Lucide 的 Feather-derived 集合）。
- **DS-Bot**：Apache-2.0，`Copyright 2026 Fei2411 and DS Bot contributors`。`src/client/chat-skin-model.mjs` 的 fold/preview helpers 适配自 `ds-bot/src/client/fold.js`，改为按 Unicode code point 计数并使用独立返回契约；气泡当前不折叠长消息，但该 helper 仍留在客户端源码/构建路径。DS-Bot 的 runtime、Bot roster、服务器逻辑、头像和美术没有打包；适配代码及其 Apache-2.0 声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **dsh-go**：公开文档与开源准备方式参考；没有复制其代码/美术。
- **开发依赖**：React、React DOM、esbuild、playwright-core 等只用于构建/测试，各自保留自己的许可证；它们不随插件 tgz 以第三方源码形式 vendored，也不因本项目 MIT 而重新许可。
- **Host peer dependencies**：`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 及 React 等由各自作者提供，本项目不 vendored、不重新授权。

## 边界

- 许可证兼容性、署名和 NOTICE 在新增/移植第三方内容时必须重新核对；不能凭“旧版没有声明”推断新内容可以并入。
- 不复制 AGPL 代码或美术；需要参考设计时自行实现，并保留必要的来源说明。
- 第三方依赖的许可独立于本项目 MIT；分发本项目不改变它们各自的条款。
- 提交贡献即表示你有权提交该内容，并同意按项目 MIT 提供；若包含第三方材料，提交者需同时提供来源、版本/提交、许可证和修改说明。
- 以上是工程署名与来源说明，不是法律鉴定或最终合规意见；新增、移植或改变第三方内容的许可判断都需单独复核。
