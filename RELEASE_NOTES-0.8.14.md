# Session Link 0.8.14 — 引用归位到消息操作行 / quote action joins the native action strip

- “引用”从作者行（只读统计/信息区）移到消息下方的宿主原生操作行：**复制 → 引用 → 好评/差评 → 分支 → 信息**，使用 16px 引用图标，随操作行一起悬停显示；键盘可聚焦、有 aria 名称。
- 点击后行为不变：把该条消息作为宿主原生原子引用插入输入框、输入框聚焦；改动的是位置与语义，不再让人误以为在引用“统计/工具”。
- 引用内容改为消息的 **Markdown 源文本**（来自会话 durable blocks），保留代码/强调等格式；超过约 1200 字按节选插入并标注“引用节选”。
- 卡片模式不显示该按钮（卡片模式保持原样）；用户消息没有公开动作槽，仍用宿主“选中文本→引用文本”。
- Moves the quote action from the read-only stats line into the Host's assistant action strip (after copy), renders markdown source rather than rendered text, and keeps card mode untouched.
