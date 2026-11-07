# 三路发布准备（本地检查单，不自动发布）

授权边界：本文只准备；不改变 GitHub 可见性、不创建 Release/tag、不 `npm publish`、不安装到当前运行 profile。

## A. GitHub 源码

- 仓库：`https://github.com/Wangmo-bit/dsh-session-link`（当前私有）。
- 发布前确认：目标 commit 的 README 中英、LICENSE、package.json/lock license 一致；CI 在私有 Actions 通过。
- 公开可见性、分支保护、私有漏洞报告启用由所有者操作；本仓不改。

## B. GitHub Release 制品

1. 从**目标 commit** 构建：`npm ci && npm run build`。
2. 打包：`npm pack --pack-destination release/` → `wangmo-dsh-session-link-0.6.3.tgz`。
3. 校验：`sha256sum release/*.tgz` 写入 `release/SHA256SUMS.txt`；记录 release notes 中对应的 commit SHA（构建时 `git rev-parse HEAD`）。
4. Release notes 用 `RELEASE_NOTES-0.6.3.md`（中英）；附 tgz 与 SHA256；标注已测/未测、升级/回滚边界。
5. 由所有者创建 tag/Release 并上传；本仓不推送 tag。

安装验证（隔离 profile，非生产）：

```bash
dsh plugin --profile <isolated-profile> add /path/to/wangmo-dsh-session-link-0.6.3.tgz --offline
```

回退：保留旧 tgz；但账本/队列跨版本兼容**未验证**，需先做备份/恢复与 downgrade 演练。

## C. npm

- 包名：`@wangmo/dsh-session-link`；当前 registry 查询 **404 未占用**（2026-11-04 只读核对）。
- 当前 `package.json` 为 `"private": true`：**npm 会拒绝 publish**；最终发布时需由所有者确认后改为 `false`（或移除），并重新打包/核对 SHA；本轮不修改。
- npm 身份：本机 `npm whoami` 返回 `ENEEDAUTH`（无登录）；不读/不打印凭据、不新登录。所有者需：登录 npm → 确认对 `@wangmo` scope 的发布权限（用户或组织）→ `npm publish --access public`（或按策略 restricted）。
- 包内容：`npm pack --dry-run` 检查 files 白名单；根 README/LICENSE 由 npm 强制包含；`prepack` 仅本地构建。
- 发布前：版本号、tag/commit、tgz SHA 与 npm 包一致；MIT 仅覆盖本项目代码，第三方 NOTICE 保留。
- 不做自动 publish/CI 发布；发布动作由所有者执行。
