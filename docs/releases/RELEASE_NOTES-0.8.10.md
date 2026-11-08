# Session Link 0.8.10 — 子代理交互不占主时间线 / internal agent messages stay off the timeline

- 气泡模式下，父子 agent 之间的消息（“收到消息，来自 子代理”/“已发消息给 子代理”）不再显示胶囊。主会话时间线只出现与**平行会话**的通信胶囊（用户 2026-11-08 决定）。
- 消息本身仍照常写入会话日志和模型上下文；投递、回执、权限均未改变。无法可靠识别的关系仍保持原有回退。
- 上一版新增的“直接消息发送中/失败 ×”胶囊因此在气泡模式不再出现；平行会话的“转圈 → ✓ / × / ?”语义保持不变。
- 卡片模式保留原有子代理卡，未改动。
- Bubble mode no longer paints capsules for parent↔child agent messages; only peer-session communication appears on the main timeline. Delivery, receipts, permissions and card mode are unchanged.
