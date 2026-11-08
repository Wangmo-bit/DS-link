# Session Link 0.8.13 — 气泡内“引用”按钮 / one-click message quote

- 每条**已结束且有正文**的助手气泡，在作者行统计后新增“引用”按钮。点击后：
  - 该条消息的渲染文本被插入当前输入框，作为**宿主原生原子引用**（蓝色引用块，可删除、可编辑，和宿主“选中文本→引用文本”完全同一机制）；
  - 输入框自动获得焦点，用户直接输入要回复的内容并发送；
  - 模型在下一轮以 `> 引用…` 的引用块看到被回复的那条消息。
- 超过约 1200 字的引用按节选插入，并标注“引用节选”，避免一条超长回复撑爆下一次请求。
- 不修改任何消息记录，不自动发送；卡片模式与用户消息的原生操作不变（用户消息仍可选中文本后点“引用文本”）。
- Adds a “引用” action to each finalized assistant message in bubble mode: it inserts that message as the Host's native atomic quote into the composer and focuses it, so the next message can directly answer that specific message.
