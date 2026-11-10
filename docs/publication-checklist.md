# 最后开门前 / Before pulling the trigger

[发布说明](../RELEASING.md) · [准备验收](open-source-readiness.md) · [首页](../README_ZH.md)

> 当前仓库仍为私有。合入主分支不是安装插件，也不是公开发布。本页不授予历史重写、强推、创建 Release、上传包、npm publish 或改变可见性的许可。

## 已完成

- 所有者已授权将准备分支合入 `main`；采用快进合并，不重写旧提交。
- 私有 GitHub runner 只有 2 核，已把 CI 容器配额从 4 调为 2，保留断网、非 root、只读根及独立 tmpfs 的隔离条件。
- [准备分支实际 CI](https://github.com/Wangmo-bit/DS-link/actions/runs/42470100506) 与 [main 实际 CI](https://github.com/Wangmo-bit/DS-link/actions/runs/42470323291) 均已通过：491 tests / 491 pass / 0 fail / 0 skipped，包白名单 38 文件。
- 所有者于 2026-11-09 授权私有预发布，2026-11-10 授权 `v0.8.17` 私有正式版（取代 `v0.8.16`）；安装包与校验以[Release 页面](https://github.com/Wangmo-bit/DS-link/releases/tag/v0.8.17)为准。此授权不包括公开仓库、npm 发布、上传视频或更新日用。
- npm 使用独立临时副本完成 `publish --dry-run --ignore-scripts --access public --tag next`，38 文件通过。只在临时副本移除 private 门做预演，仓库仍为 `private:true`；模拟包不是正式制品。
- 所有者后续独立授权后，同一已验收候选已升级日用安装；新客户端真实加载，气泡/卡片/原生引用 smoke 通过，未重启、未公开。详细安装及运行态范围见[升级记录](open-source-readiness.md#日用升级同日后续授权)。

## 仍需决定或提供的条件

### 1. 历史身份（已完成，2026-11-10）

- 所有者单独授权后已执行历史重写：author/committer 全部改为 `Wangmo-bit <Wangmo-bit@users.noreply.github.com>`，覆盖 `main`、`prep/open-source-20261108` 和 `v0.8.17` 标签。
- 历史文件中的 `/home/<user>`、`/path/to/...`、`internal-project` 已替换为占位符（`/home/<user>`、`/path/to/...`、`internal-project`）；当前代码树与重写前一致。
- 重写前完整 bundle 保存在私有备份区；仓库无 fork、无 Pages、无 Actions artifact。提交编号已变化，旧 SHA 引用失效。
- `王墨` 是公开笔名而非真名，只从当前测试夹具移除；历史 PRD 中的笔名保留为公开署名，不构成真名泄露。
- GitHub 可能在一段时间内仍能通过已知旧 SHA 访问缓存对象；仓库从未公开、无 fork，外部不知道旧 SHA，风险有限。公开后如需彻底清理缓存，需另行联系 GitHub Support。

### 2. npm 身份与 scope

- 所有者已注册并通过官方网页登录，CLI `npm whoami` 核验账号为 `wangmo-bit`；仅登录，未发布任何包。
- 所有者决定进一步统一名称：GitHub 仓库为 `Wangmo-bit/DS-link`，源码包名为 `@wangmo-bit/ds-link`；日用已从旧 `@wangmo/dsh-session-link` 迁移至新包，只保留新包启用，旧包与配置备份仍保留。绑定 GitHub 与 CLI 登录不等于已配置自动发布或验证写入权限。
- 正式发布前仍需确认包名/scope、升级迁移和安全验证方式；不要把密码、OTP、token 或完整配置发到聊天、Issue 或代码里。
- 未经决定不擅自改包名。若需换 scope，先同步工具/安装/升级文档并复验。

### 3. 冻结首发版本与包

本轮私有正式版源码为 `@wangmo-bit/ds-link@0.8.17`；日用仍保留原先的 `0.8.16-pre.5` 安装，本轮不更新。私有 Release、公开可见性和 npm 包是三个不同状态。制品须从最终提交重新构建与核 SHA，不能把临时更改 private 字段的模拟包当成权威包，也不能覆盖旧版产物冒充同一包。

### 4. 等所有者扣扳机

GitHub 仓库公开、GitHub Release 上传和 npm 实际发布都分别是对外动作。**npm 即使在 GitHub 仓库还私有时发布，也会公开包内源代码**；不能用“仓库还没公开”把 npm 发布当作无外发预演。

所有者确认后再按顺序处理最终包/发布记录/公开可见性，并验收私密漏洞报告入口、下载与匿名安装路径。日用升级和服务重启仍是另一项独立授权。

## English summary

The preparation branch was fast-forwarded to main after real GitHub CI passed; main CI passed too (491/491, no skips). GitHub remains private. The owner separately authorized the private v0.8.17 GitHub release; final assets and checksums are listed on its Release page. Repository visibility, npm publication, video uploads and daily-use installation updates remain outside that authorization. The npm dry-run used a temporary manifest, while source retains private:true. The CLI has since authenticated as wangmo-bit; final package scope and publication permissions still need review. The same verified candidate was separately authorized for daily-use installation; its client was smoke-tested without a service restart. On 2026-11-10 the owner authorized a full history rewrite: author/committer metadata now uses the GitHub noreply address, and historical local paths were replaced with placeholders across main, the prep branch and the tag. Old commit SHAs are invalid; a pre-rewrite bundle remains in private backup. Wangmo is a public pen name, not a real name. Publishing npm exposes packaged source even if GitHub stays private. Actual publication and daily-use upgrades remain separate owner decisions.
