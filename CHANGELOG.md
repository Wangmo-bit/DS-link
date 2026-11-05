# Changelog

## Unreleased — 0.4.0 candidate

- `session_link_create` 新增 `existingProject:{path,title?}`：通过 Host workspace registry 登记已有项目目录，不创建/读取/修改目录内容；与 `workspaceId`/`newProject` 三选一，旧模式兼容。

- 会话间 send/reply/create 与投递/回执/回复状态。
- 双向聊天卡片：三行摘要、方向着色、卡内完成态技术行与轨迹入口。
- 设置页暂停/并发/回复等待/正文保留；记录页状态与关联组操作。
- 本地候选：尚未发布、未选许可证。

（更早的 0.2/0.3 历史保留在私有开发仓，不随本候选导入。）
