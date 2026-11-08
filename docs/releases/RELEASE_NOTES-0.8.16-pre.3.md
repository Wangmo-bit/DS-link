# DS-link 0.8.16-pre.3 — 统一仓库与包名 / Unified identity

**私有候选，尚未公开发布。**

- 产品和界面：**DS-link**。
- 同一 GitHub 仓库改名为 **`Wangmo-bit/DS-link`**，保留仓库身份和历史，不创建另一个公开镜像。
- npm 包统一为 **`@wangmo-bit/ds-link`**；包元数据、客户端 module id、当前入口、安装命令、问题模板和文档同步。
- 原 `session_link_*` 工具、API 路径、服务/面板 id、账本目录和浏览器偏好 key 保持兼容。旧名只保留在兼容接口、迁移说明或历史记录，不作为另一套产品。
- 新旧包不得同时启用。日用迁移须先验证、保留旧包和配置备份，再经官方插件管理入口处理；不会为了改名删除数据、手改已安装文件或擅自重启。
- 未实现团队/全网连接，未发布 npm/Release，未改变仓库私有状态或改写历史。

DS-link now uses one external identity: repository `Wangmo-bit/DS-link`, npm package `@wangmo-bit/ds-link`. Existing tool/API/state/preference namespaces remain compatible. Do not activate the legacy and renamed bundles together. Renaming is not permission to publish or restart; team/global links remain future work.
