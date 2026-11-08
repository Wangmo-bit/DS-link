# DS-link 0.8.16-pre.2 — 名称与定位 / Brand and scope

**源码候选，未安装、未公开发布。**

- 对外品牌从 Session Link / 会话互通统一为 **DS-link**，同步客户端标题、导航、卡片标题、中英介绍和合成演示素材。
- 明确当前只做同一 DSH 宿主里的本机 link。团队内 link 和全网 Agent 邮箱式 link 记录为未来探索方向，顺序未定，不是已有功能或排期承诺。
- 保留现有包名、仓库地址、`session_link_*` 工具名、内部服务/面板标识和存储/浏览器偏好 key；不做数据迁移，不增设外部端口，不改变投递、权限或两种模式的行为。
- 本次改名不自动升级已装日用版本，也不授权 npm/Release 发布、改写历史或改变仓库可见性。
- 验证：非 root、断网、只读容器与独立 tmpfs 中 492 tests / 492 pass / 0 fail / 0 skip；构建与 39 项包白名单检查通过。另核对工具/API、账本和偏好标识未改，241 条本地文档链接无失效。

The public-facing brand is now **DS-link**. Current capabilities remain local to one DSH host. Team links and global Agent mailbox-style links are future directions with no frozen order or delivery date. Existing package/tool/storage identifiers remain compatible. This source candidate is not installed or published; no cross-machine implementation or production change is included.
