# 0.8.19-pre.2 — Local preview / 本地预览（未发布）

This is a local preview, not an npm or GitHub release. The latest public version remains 0.8.18. No protocol, ledger format, permission or Host bridge changes are included.

这是本地预览，不是 npm 或 GitHub Release；公开最新版本仍为 0.8.18。本次不改协议、账本格式、权限或 Host 桥接。

## Capsule grouping / 胶囊分组

- Bubble mode groups adjacent same-turn messages in both directions, for the same verified peer, message kind and evidence-based state, with at most five minutes between neighbors. Card mode stays per-message. A sender's three calls in one turn may group while the receiver's three separate turns do not: grouping is local to the displayed conversation.
- `request`, `notification` and `reply` remain distinct. Unknown turn/peer/time is kept separate. Visible message text, native fallback messages, questions, plan confirmations and opposite-direction capsules break a run.
- Status grouping distinguishes dispatch, context receipt (`queued` versus `received`), reply state and stale lookups; waiting messages cannot disappear under a confirmed-receipt capsule.
- Durable tool-call sequence/time replaces provisional live-chunk evidence, and sent-only history initializes on first open, without waiting for a received message.
- Group computation is linear per timeline; unchanged state no longer triggers redundant publication. Old generation/window metadata is revoked.
- The previous local 0.8.19 physical entry is retained for already-resolved imports. Local previews have distinct artifact paths; do not overwrite installed tarballs or hand-edit installed code.

- 气泡模式收发规则一致：同轮、相邻、同一已核实对象、同消息类型、同真实状态，且相邻间隔不超过五分钟。卡片仍逐条。发送方同轮三次可合为 ×3，接收方分别开三轮则不能合并；分组以当前显示会话的轮次为准。
- 请求、通知、回复不混并。轮次、对象或时间不明时逐条保留；可见正文、原生回退消息、提问、计划确认、反向胶囊会断开分组。
- 区分投递、上下文回执（排队/已进入）、回复与陈旧查询状态，避免等待消息藏在“已收到”的分组里。
- 修复流式调用从临时序号交接到持久序号，以及只有发送记录的历史首次打开未建分组的问题。
- 分组计算改为线性；相同状态不重复广播，窗口代际更换撤销旧元数据。
- 保留前一个本地预览的物理入口；预览制品使用独立文件路径，不能覆盖已有安装包或手改安装代码。

## Validation boundary / 验证边界

Focused tests cover grouping, receipt/freshness boundaries, native fallback/identity conflicts, questions/plan confirmations, static sent-only initialization, stream-to-durable handoff and store lifecycle. Full-suite and live-browser evidence must be recorded separately before claiming installation or acceptance.

专项回归覆盖合并、回执/新鲜度、原生回退/身份冲突、提问/计划确认、静态发送历史初始化、流式交接与 store 生命周期。全量测试、实际浏览器与安装证据需另行记录，不能以源码或单测代替本人验收。
