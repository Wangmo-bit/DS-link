# Changelog

## Unreleased — 0.5.0 candidate

- Web 反馈批次：原生思考/工具过程收进同一气泡（默认折叠、运行中可展开、真实计时）、气泡/旧三卡整套显示模式（本浏览器保存）、往返记录 20 条分页与居中加载、收发提示小状态图标、子 agent 直接消息同款展示、思考省略号动画（尊重减少动态）。
- 官方安装合规整改：版本 0.4.0 → 0.5.0（避免同版本覆盖重打包）；新增精确版本物理入口 `src/host/entry-0.5.0.js` 与 mount id `session-link-runtime-0-5-0`；release notes 改为 0.5.0。
- 0.4.0 候选（未发布）保留其历史记录。

## Unreleased — 0.4.0 candidate

- `session_link_create` 新增 `existingProject:{path,title?}`：通过 Host workspace registry 登记已有项目目录，不创建/读取/修改目录内容；与 `workspaceId`/`newProject` 三选一，旧模式兼容。

- 会话间 send/reply/create 与投递/回执/回复状态。
- 双向聊天卡片：三行摘要、方向着色、卡内完成态技术行与轨迹入口。
- 设置页暂停/并发/回复等待/正文保留；记录页状态与关联组操作。
- 本地候选：尚未发布、未选许可证。

（更早的 0.2/0.3 历史保留在私有开发仓，不随本候选导入。）
