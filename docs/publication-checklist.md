# 最后开门前 / Before pulling the trigger

[发布说明](../RELEASING.md) · [准备验收](open-source-readiness.md) · [首页](../README_ZH.md)

> 0.8.18 公开版已发布：npm 包与 GitHub Release 均已上线，文档和仓库 topics 已就绪；只剩 **仓库可见性切换**，以及公开后立即启用 **私密漏洞报告**。本页不授予可见性切换许可。

## 已完成

- **0.8.18 公开版**：`package.json` 去掉 `private`，版本升至 `0.8.18`；README 中英、安装说明、发布/打包/维护文档已改为公开安装与发布口径。
- **历史重写（2026-11-10）**：author/committer 全部改为 `Wangmo-bit <Wangmo-bit@users.noreply.github.com>`；历史中的本机用户目录、内部项目根目录和内部项目名替换为占位符；覆盖 `main`、`prep` 分支与标签。重写前完整 bundle 在私有备份区，旧 SHA 引用失效。
- **仓库 topics**：`multi-agent`、`deepseek-harness`、`dsh-plugin`、`dsh`、`agent-collaboration`、`local-first`。
- **制品**：43 文件白名单，无 `test/`、`scripts/`、`docs/`；从最终提交重新构建并核 SHA；隔离安装通过。
- **npm 已发布**：`@wangmo-bit/ds-link@0.8.18` 已上线（latest），匿名下载与隔离安装通过；registry 包与 GitHub Release 包 43 个文件内容一致。
- **日用**：仍为 `0.8.17`，未重启、未替换；0.8.18 与 0.8.17 运行时代码相同，仅打包身份与文档变化。

## 只剩两件对外动作

1. **切换仓库可见性**：由所有者把 `Wangmo-bit/DS-link` 从 private 改为 public。
2. **启用并验收私密漏洞报告**：该功能只能在仓库公开后启用（当前返回 404）；切换后立即打开并验收 **Report a vulnerability** 入口。

## 建议顺序

1. 所有者切换仓库可见性为 public。
2. 立即启用 GitHub 私密漏洞报告，并打开 Security Advisories 页面验收入口。
3. 验收公开 clone、Release 下载、npm 匿名安装、Issue 模板与 Security 入口。

## English summary

Release 0.8.18 is public: the npm package `@wangmo-bit/ds-link@0.8.18` is published as latest and the GitHub release is live; the registry tarball and the GitHub release tarball contain the same 43 files. `private` was removed, README/installation/release docs were rewritten for public install, history was rewritten on 2026-11-10 (noreply authors, local paths replaced), and repository topics were added. Only two external actions remain: flip repository visibility from private to public, then enable and verify GitHub private vulnerability reporting (which can only be enabled once the repository is public). The daily installation stays on 0.8.17 and was not restarted; 0.8.18 has the same runtime code and differs only in packaging identity and documentation.
