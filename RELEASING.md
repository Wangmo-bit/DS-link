# 发布准备（不自动发布）

本文是**所有者/获授权维护者**的发布检查单，不是发布授权。准备内容已获准合入 `main`，但没有公开 Release 或 npm 包，也不改动已安装的生产 profile。当前 CI、npm 预演、历史邮箱与扣扳机前的事项见[最后开门前](docs/publication-checklist.md)。

## 授权边界

- 改变仓库可见性、创建 tag/Release、上传制品、`npm publish`、安装到日用/生产 profile、重启服务、改写历史，都必须由所有者逐项授权。
- 本仓不自动 push、不自动发包、不自动创建 Release/tag、不自动安装或重启。
- 发布检查只在隔离环境和源码仓进行；生产/日用 profile 不是试验场。

## 版本与候选

- 版本以 `package.json` 为准：

  ```sh
  VERSION=$(node -p "require('./package.json').version")
  git rev-parse HEAD
  ```

- 准备分支的 `package.json` 仍为 `"private": true`；`npm publish` 会被拒绝，这是有意的。
- pre-release（例如带 `-pre` 的候选号）**不是公开 Release**，也不能写成“已发布”“稳定版”或对外可下载。候选号不写死在文档和命令里，避免旧版本被沿用。
- 只有所有者明确决定公开后，才考虑去掉 `private`、发布 tag/Release 或 npm 包；这些动作本指南不执行。

## A. GitHub 源码

- 仓库：`https://github.com/Wangmo-bit/DS-link`（当前私有；公开可见性由所有者操作）。
- 目标 commit 上确认：README 中英、安装说明中英、LICENSE、THIRD_PARTY_NOTICES、`package.json`/lock 的版本与许可证一致。
- 在目标 commit 跑源码检查，确认没有真实会话、凭据、个人路径或私有运维材料；公开前提交历史和远端设置仍需人工复核。
- 不把公开可见性、分支保护或私密漏洞报告的启用说成“已完成”，这些都要实际核验；见 [SECURITY.md](SECURITY.md)。

## B. 构建制品与安装验证

1. 从目标 commit 构建并检查包内容：

   ```sh
   npm ci
   npm run build
   mkdir -p output
   npm pack --dry-run --json --ignore-scripts
   npm pack --pack-destination ./output
   VERSION=$(node -p "require('./package.json').version")
   sha256sum "./output/wangmo-bit-ds-link-${VERSION}.tgz"
   git rev-parse HEAD
   ```

   白名单和产物细节见 [PACKAGING.md](PACKAGING.md)。记录 SHA-256 与构建 commit，不要沿用旧 manifest。

2. 测试门禁：按 [TESTING.md](TESTING.md) 在一次性容器、非 root、独立 `/tmp` tmpfs 中跑；不要在宿主共享 `/tmp` 上直接跑，也不要连接真实 profile。当前仓库的容器入口为：

   ```sh
   docker build -f scripts/test.Dockerfile -t session-link-check .
   docker run --rm --network=none --read-only --user=node \
     --cap-drop=ALL --security-opt=no-new-privileges \
     --pids-limit=512 --memory=3g --cpus=4 \
     --tmpfs /tmp:rw,nosuid,nodev,exec,size=1g,mode=1777 \
     session-link-check
   ```

   跳过或未运行的用例单独记录，不能写成通过。

3. 隔离 profile 安装验证（不是生产）：

   ```sh
   PROFILE=sl-test
   VERSION=$(node -p "require('./package.json').version")
   TGZ="$(pwd)/output/wangmo-bit-ds-link-${VERSION}.tgz"
   dsh plugin --profile "$PROFILE" add "$TGZ"
   ```

   安装前备份 profile 的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`；安装后核对实际加载版本/客户端，不能只看磁盘。

4. Release notes 从目标 commit 的真实结果写：已测/未测、兼容范围、已知限制、升级/回退边界和第三方声明。不要承诺未验证的平台或数据回退。

5. 所有者确认后创建 tag/Release 并上传 tgz/SHA；本仓不自动上传。

## C. npm（未发布）

- `private: true` 会阻止 `npm publish`；当前没有公开 npm 包，也不提供 registry/npx 安装链接。不要用猜的地址测试“发布是否成功”。
- 发布 npm 是所有者的独立动作：需另行确认版本、包内容、许可证/声明、tag/commit 与 registry 身份，并在实际发布后核对可匿名安装的包。本仓不记录或读取发布凭据，不自动登录。
- 如果只做源码构建，用 `npm ci` / `npm run build` / `npm pack`；不要把“本地 pack 成功”说成“npm 已发布”。

## 回退

- 保留上一版 tgz 作为代码回退候选；账本、待投递队列与迁移状态的跨版本降级**未验证**。
- 回退前备份 profile 与记录，在隔离环境演练；不要在生产 profile 直接降级。
- Host 桥接有独立的备份和收据；插件回退不能拿它覆盖 Host，桥接回退也不能覆盖插件包。见 [安装说明](docs/installation.md)。

## 材料与安全

- 发布前复核 [LICENSING.md](LICENSING.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[ASSETS.md](ASSETS.md)，确保第三方许可、图标/桥接归属和演示素材来源没有被漏掉。
- 所有截图、日志、Release notes 和 Issue 使用合成或脱敏内容；不提交真实会话、凭据、私钥或完整配置。
- 安全报告走 [SECURITY.md](SECURITY.md) 的私密渠道；不要在公开 Release 说明里贴漏洞细节。
