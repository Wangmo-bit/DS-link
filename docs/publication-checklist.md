# 最后开门前 / Before pulling the trigger

[发布说明](../RELEASING.md) · [准备验收](open-source-readiness.md) · [首页](../README.md)

> 当前仓库仍为私有。合入主分支不是安装插件，也不是公开发布。本页不授予历史重写、强推、创建 Release、上传包、npm publish 或改变可见性的许可。

## 已完成

- 所有者已授权将准备分支合入 `main`；采用快进合并，不重写旧提交。
- 私有 GitHub runner 只有 2 核，已把 CI 容器配额从 4 调为 2，保留断网、非 root、只读根及独立 tmpfs 的隔离条件。
- [准备分支实际 CI](https://github.com/Wangmo-bit/DS-link/actions/runs/42470100506) 与 [main 实际 CI](https://github.com/Wangmo-bit/DS-link/actions/runs/42470323291) 均已通过：491 tests / 491 pass / 0 fail / 0 skipped，包白名单 38 文件。
- GitHub Release 的请求草案、候选包和校验和已在维护者本地准备；**未创建远端 Release、未打 tag、未上传制品**。
- npm 使用独立临时副本完成 `publish --dry-run --ignore-scripts --access public --tag next`，38 文件通过。只在临时副本移除 private 门做预演，仓库仍为 `private:true`；模拟包不是正式制品。
- 所有者后续独立授权后，同一已验收候选已升级日用安装；新客户端真实加载，气泡/卡片/原生引用 smoke 通过，未重启、未公开。详细安装及运行态范围见[升级记录](open-source-readiness.md#日用升级同日后续授权)。

## 仍需决定或提供的条件

### 1. 隐藏旧历史中的个人邮箱

- 之后的提交可使用 GitHub noreply 地址；GitHub 的隐藏邮箱设置不追溯修改旧提交。
- 已有历史若不希望随仓公开，需要**重写 author 与 committer 邮箱元数据**，不改文件内容；提交编号会改变，需要检查和更新旧引用。
- 实施前保存私有完整备份，在隔离镜像中预演映射，确认分支、标签、PR 等旧引用和 GitHub 缓存的处置。普通合并、`.mailmap` 或只改个人设置不能保证原邮箱从原始提交里消失。
- 真实历史重写与受保护的远端更新需要所有者**单独明确同意**，当前尚未执行；不会修改日用安装、Host 或会话数据。

### 2. npm 身份与 scope

- 所有者已注册并通过官方网页登录，CLI `npm whoami` 核验账号为 `wangmo-bit`；仅登录，未发布任何包。
- 所有者决定进一步统一名称：GitHub 仓库为 `Wangmo-bit/DS-link`，源码包名为 `@wangmo-bit/ds-link`；旧 `@wangmo/dsh-session-link` 日用安装按迁移规则处理。绑定 GitHub 与 CLI 登录不等于已配置自动发布或验证写入权限。
- 正式发布前仍需确认包名/scope、升级迁移和安全验证方式；不要把密码、OTP、token 或完整配置发到聊天、Issue 或代码里。
- 未经决定不擅自改包名。若需换 scope，先同步工具/安装/升级文档并复验。

### 3. 冻结首发版本与包

当前源码是 DS-link 统一包名候选 `0.8.16-pre.3`，日用仍为已获授权安装的 `0.8.16-pre.1`；均未对外发版。正式发布前确认目标版本和安装策略，从最终提交重新构建与核 SHA，不能把临时更改 private 字段的模拟包当成权威包，也不能覆盖旧版产物冒充同一包。

### 4. 等所有者扣扳机

GitHub 仓库公开、GitHub Release 上传和 npm 实际发布都分别是对外动作。**npm 即使在 GitHub 仓库还私有时发布，也会公开包内源代码**；不能用“仓库还没公开”把 npm 发布当作无外发预演。

所有者确认后再按顺序处理最终包/发布记录/公开可见性，并验收私密漏洞报告入口、下载与匿名安装路径。日用升级和服务重启仍是另一项独立授权。

## English summary

The preparation branch was fast-forwarded to main after real GitHub CI passed; main CI passed too (491/491, no skips). GitHub remains private. Release payloads are local only; npm dry-run used a temporary manifest, while source retains private:true. The CLI has since authenticated as wangmo-bit; final package scope and publication permissions still need review. The same verified candidate was separately authorized for daily-use installation; its client was smoke-tested without a service restart. Hiding the historical personal email requires separately authorized metadata history rewriting and old-reference/cache review; changing profile settings or a mailmap alone is insufficient. Publishing npm exposes packaged source even if GitHub stays private. Actual publication and daily-use upgrades remain separate owner decisions.
