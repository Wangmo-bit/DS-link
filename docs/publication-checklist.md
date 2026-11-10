# 最后开门前 / Before pulling the trigger

[发布说明](../RELEASING.md) · [准备验收](open-source-readiness.md) · [首页](../README_ZH.md)

> 0.8.18 公开版已准备：npm 包、GitHub Release、文档和仓库 topics 已就绪；只剩 **npm 实际发布**（需要所有者登录）和 **仓库可见性切换**。本页不授予可见性切换许可。

## 已完成

- **0.8.18 公开版**：`package.json` 去掉 `private`，版本升至 `0.8.18`；README 中英、安装说明、发布/打包/维护文档已改为公开安装与发布口径。
- **历史重写（2026-11-10）**：author/committer 全部改为 `Wangmo-bit <Wangmo-bit@users.noreply.github.com>`；历史中的本机用户目录、内部项目根目录和内部项目名替换为占位符；覆盖 `main`、`prep` 分支与标签。重写前完整 bundle 在私有备份区，旧 SHA 引用失效。
- **仓库 topics**：`multi-agent`、`deepseek-harness`、`dsh-plugin`、`dsh`、`agent-collaboration`、`local-first`。
- **制品**：43 文件白名单，无 `test/`、`scripts/`、`docs/`；从最终提交重新构建并核 SHA；隔离安装通过。
- **日用**：仍为 `0.8.17`，未重启、未替换；0.8.18 与 0.8.17 运行时代码相同，仅打包身份与文档变化。

## 只剩三件对外动作

1. **npm 发布**：CLI 当前未登录（`E401`）。需要所有者在本机执行 `npm login`；登录后由维护者执行 `npm publish --access public`，并核对 registry 页面与匿名安装。
2. **启用私密漏洞报告**：GitHub 当前返回 404，尚未启用；开源前由所有者或获授权维护者打开并实际验收入口。
3. **切换仓库可见性**：由所有者把 `Wangmo-bit/DS-link` 从 private 改为 public。

## 建议顺序

1. 所有者 `npm login`。
2. 维护者发布 npm `@wangmo-bit/ds-link@0.8.18`，核对 registry 与匿名安装。
3. 启用并验收 GitHub 私密漏洞报告。
4. 所有者切换仓库可见性。
5. 验收公开 clone、Release 下载、Issue 模板与 Security 入口。

## English summary

Release 0.8.18 is prepared as the public release: `private` removed, version bumped, README/installation/release docs rewritten for public install, history rewritten on 2026-11-10 (noreply authors, local paths replaced), and repository topics added. The package contains 43 allowlisted files and installs in an isolated profile. Only three external actions remain: publish the npm package after the owner runs `npm login`, enable GitHub private vulnerability reporting (currently 404), and flip repository visibility from private to public. The daily installation stays on 0.8.17 and was not restarted; 0.8.18 has the same runtime code and differs only in packaging identity and documentation.
