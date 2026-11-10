# 最后开门前 / Before pulling the trigger

[发布说明](../RELEASING.md) · [准备验收](open-source-readiness.md) · [首页](../README_ZH.md)

> 0.8.19 已公开发布：仓库公开、npm latest 与 GitHub Release 同步上线、匿名下载与隔离安装通过。本页保留发布与验收记录。

## 0.8.19 发布记录（2026-11-10）

- **源码提交**：`409e658`，tag `v0.8.19`；发布说明见 [RELEASE_NOTES-0.8.19.md](releases/RELEASE_NOTES-0.8.19.md)。
- **制品**：43 文件，`wangmo-bit-ds-link-0.8.19.tgz`，SHA-256 `03073d7aa2009559f8c47308d78fba4dd154b86f931ca4959643e74952c0bf80`。
- **GitHub Release**：`https://github.com/Wangmo-bit/DS-link/releases/tag/v0.8.19`，非草稿、非预发布；匿名下载 SHA-256 与本地一致。
- **npm**：`@wangmo-bit/ds-link@0.8.19` 已上线并成为 latest；registry tarball SHA-256 与 GitHub 资产一致，隔离 profile 从 registry 安装通过。
- **验证**：隔离容器 524/524 通过、0 跳过；真实安装包浏览器验证收发双向 `×3`、合并弹窗三条正文、卡片逐条、分轮不误合并。
- **日用**：本地预览 `0.8.19-pre.2` 已装但未重启；是否切换到正式 npm 包与重启由所有者另行确认。

## 已完成

- **0.8.18 公开版**：`package.json` 去掉 `private`，版本升至 `0.8.18`；README 中英、安装说明、发布/打包/维护文档已改为公开安装与发布口径。
- **历史重写（2026-11-10）**：author/committer 全部改为 `Wangmo-bit <Wangmo-bit@users.noreply.github.com>`；历史中的本机用户目录、内部项目根目录和内部项目名替换为占位符；覆盖 `main`、`prep` 分支与标签。重写前完整 bundle 在私有备份区，旧 SHA 引用失效。
- **仓库 topics**：`multi-agent`、`deepseek-harness`、`dsh-plugin`、`dsh`、`agent-collaboration`、`local-first`。
- **制品**：43 文件白名单，无 `test/`、`scripts/`、`docs/`；从最终提交重新构建并核 SHA；隔离安装通过。
- **npm 已发布**：`@wangmo-bit/ds-link@0.8.18` 已上线（latest），匿名下载与隔离安装通过；registry 包与 GitHub Release 包 43 个文件内容一致。
- **日用**：仍为 `0.8.17`，未重启、未替换；0.8.18 与 0.8.17 运行时代码相同，仅打包身份与文档变化。

## 公开后验收（已完成，2026-11-10）

- 仓库可见性：**public**；匿名 clone 成功，公开 API 返回 `private: false`。
- GitHub Release：匿名下载 `wangmo-bit-ds-link-0.8.18.tgz` 返回 200，SHA-256 与发布清单一致。
- npm：registry 公开，唯一版本 `0.8.18`（latest），匿名下载与隔离安装通过。
- 私密漏洞报告：已启用，API 返回 `enabled: true`，Security Advisories 页面可访问。
- 仓库 topics：`multi-agent`、`deepseek-harness`、`dsh-plugin`、`dsh`、`agent-collaboration`、`local-first`。
- 仍存在的历史缓存说明：GitHub 可能通过已知旧 SHA 返回旧提交；仓库从未提前公开、无 fork，外部不知道旧 SHA。如需彻底清理缓存，联系 GitHub Support。

## English summary

Release 0.8.19 is public: the source commit is `409e658` (tag `v0.8.19`), the npm package is latest, and the GitHub release tarball is anonymously downloadable. The registry and GitHub tarballs have the same SHA-256 (`03073d7a…c0bf80`) and the same 43 files; an isolated registry install passed, and the full suite passed 524/524 in the isolated container. The repository remains public.

Release 0.8.18 is public. The repository is now public; the npm package `@wangmo-bit/ds-link@0.8.18` is published as latest and the GitHub release is anonymously downloadable. The registry tarball and the GitHub release tarball contain the same 43 files. GitHub private vulnerability reporting is enabled and verified (`enabled: true`). Anonymous clone, anonymous release download, and anonymous npm install all passed. History was rewritten on 2026-11-10 (noreply authors, local paths replaced), and repository topics were added. GitHub may still serve previously known old commit SHAs; the repository was never public before this switch and has no forks. The daily installation stays on 0.8.17 and was not restarted; 0.8.18 has the same runtime code and differs only in packaging identity and documentation.
