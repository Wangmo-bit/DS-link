# 安装、兼容与升级

[English](installation.en.md) · [首页](../README.md) · [第一次使用](quickstart.md) · [已知问题](known-issues.md)

## 先说清楚：现在有什么、没有什么

- 当前支持**从源码构建并安装**；构建、测试和打包都在源码仓进行。
- **没有公开的 npm 包，也没有公开的 GitHub Release 下载。** 不要用 `npx @wangmo-bit/ds-link`、猜的 registry 地址或假想 Release 链接来安装。
- 仓库的 `package.json` 仍保留 `private: true`，因此 `npm publish` 会被拒绝。这是有意的发布门，不是安装故障。
- 插件安装走 DSH 官方 `dsh plugin` 入口；本仓库不会自动安装、自动修改 Host 或自动重启服务。

## 兼容范围

| 项目 | 当前说法 |
| --- | --- |
| 通信层 | 按历史版本支持 DSH `0.2.1-rc.5` / `0.2.2-rc.1` |
| 完整 UI 验证范围 | 历史日用验证为 DSH `0.2.2-rc.1` + 精确桥；本批另验离线组件及隔离 SDK 夹具，不启动新 DSH 服务 |
| Node.js | 24（实测 v24.21.0） |
| 平台 / 浏览器 | Linux Web；Chromium 为主验证路径 |
| 卡片模式 | 只装插件即可，不需要 Host 桥接 |
| 完整气泡模式 | 需要可选 Host 桥接；没有桥时只退回旧的节点皮肤，不是完整体验 |

“通信层支持”只表示消息协议在这些宿主版本上做过历史验证，不等于完整气泡 UI 在 `rc.5` 上已验收。macOS、Windows、桌面客户端、其他浏览器和其他 DSH/Node 版本没有承诺完整支持，使用前请先按小范围、合成内容自查。

## 从源码构建并安装

开始前：

- 准备 Node.js 24 和一个可用的 DSH 安装。
- **选一个隔离的测试 profile**，不要拿日用或生产 profile 做第一次安装。安装前备份该 profile 的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`。
- 源码构建使用 `npm`；不需要登录 npm registry。`npm ci` 只装构建/测试用的开发依赖，不会安装插件，也不会修改 DSH profile 或 Host 文件。

```sh
git clone https://github.com/Wangmo-bit/DS-link.git
cd DS-link
npm ci
npm run build
mkdir -p output
npm pack --pack-destination ./output
VERSION=$(node -p "require('./package.json').version")
TGZ="$(pwd)/output/wangmo-bit-ds-link-${VERSION}.tgz"
dsh plugin --profile sl-test add "$TGZ"
```

说明：

- tarball 名和版本从 `package.json` 读取，不要手写旧版本号。安装命令里的 `sl-test` 要换成你自己的隔离 profile 名。
- 如果仓库还未公开，clone 需要所有者授权；不要把访问凭据写进命令、脚本或提交。
- 不同 DSH 版本的 `dsh plugin` 可能需要额外参数；以该版本的实际帮助为准，但**不要复制已安装包里的文件**。
- 安装后要核对**实际加载的插件和客户端**，不能只看磁盘上的版本。纯客户端变化可能刷新浏览器后生效；涉及宿主侧或配置的变化，可能需要另行授权的 DSH 重启。本指南和执行安装命令都不会自动重启。

## 显示模式与可选 Host 桥接

卡片模式使用原生 Host 路径，**不需要**桥接。完整气泡流、本轮统计和 Agent 小提示需要 Host 的 `conversation.chat.flow.adapter` 接缝；原生 DSH `0.2.2-rc.1` 没有这个接缝，本仓库提供的是**源码内的可选维护工具**，不是插件安装的一部分。

- 桥接工具不随 tgz 分发，也不会被插件安装钩子自动执行。
- 不安装桥接时，插件仍可工作：卡片模式正常；气泡模式会退回旧的节点皮肤，正文仍可显示，但不能把演示里的完整布局、统计或 Agent 提示当作已获得。
- 不需要完整气泡时，不要运行桥接工具。

### 只检查（默认，不写入）

```sh
node scripts/install-host-flow-bridge-rc1.mjs --dsh-root /absolute/dsh-prefix
node scripts/install-host-flow-bridge-rc1.mjs --dsh-root /absolute/dsh-prefix --check
```

`--dsh-root` 是 DSH 安装前缀，必须是规范、非符号链接的绝对路径；工具会在该前缀下的 `lib/node_modules/@deepseek-ai/` 查找目标。默认是只读检查，不写 Host。检查成功会报告 `ready` 或 `already-installed`；版本、哈希、文件大小、owner、权限或符号链接不匹配时会停止，不会强行打补丁。

### 应用（需要单独授权）

```sh
node scripts/install-host-flow-bridge-rc1.mjs \
  --dsh-root /absolute/dsh-prefix \
  --apply --backup-dir /absolute/private-backups
```

`--apply` 会修改 Host 客户端文件，**必须有所有者/维护者的单独授权**，不能把它当成“安装插件”或“顺手修复”。执行前：

- 备份目录必须已经存在，归当前用户所有，权限为 `0700`；工具会在里面创建私有候选、备份和收据，不会覆盖别人的目录。
- Host 目标文件与父目录必须归当前用户所有，且没有组/其他人写权限；工具拒绝通过 `sudo` 绕过权限检查。
- 工具只支持 Linux；它会在应用前后反复核对精确的 `0.2.2-rc.1` 宿主版本、`@deepseek-ai/dsh` / `dsh-client-ui-chat` 包身份、固定哈希、文件大小、owner、非符号链接和生成器哈希。任何一项变了就停止。
- 这是**独立的 Host 维护动作**，不是官方插件安装；工具不修改 profile、账本、服务，也不重启任何东西。应用结果会带 `restarted: false` 和备份收据。
- 宿主升级可能覆盖桥接。升级后要重新检查精确版本和哈希；不匹配就停，不要自动重装旧桥，也不要套用旧哈希。

### 桥接回退

工具会在私有备份目录保留 `client.js.original`、候选文件和收据。回退必须作为另一项受控操作执行：先核对备份的版本、哈希、owner 与目标，再按实际文件恢复；没有自动回退，也不要用未知来源的备份覆盖 Host。

## 旧包改名迁移

外部名称已统一：**DS-link** / **`Wangmo-bit/DS-link`** / **`@wangmo-bit/ds-link`**。旧包 `@wangmo/dsh-session-link` 是同一产品的旧名称，不是另一个需要并行安装的版本。

- 先保存 profile、旧 tgz 和当前安装备份，在隔离 profile 验证迁移。
- 通过官方插件管理入口停用旧包，再安装并启用新包；不得让两个包同时提供相同服务、工具或客户端插槽。验证新包正常后再移除旧依赖，保留旧 tgz；不能直接删除账本或改写全部 profile。
- 既有 `session_link_*` 工具、`/api/session-link/api` 接口、`session-link` 服务/面板以及 `state/dsh-session-link` 和浏览器偏好 key 保留兼容，不复制出一套空记录。
- 改仓库名不等于发布。新包当前仍是私有候选；是否需要刷新或重启，按官方管理入口的实际结果和获准范围判断，不擅自启动新服务。

## 升级与回退

- 升级插件仍走 DSH 官方插件入口，并先备份目标 profile；不要手工编辑已安装包。
- 保留旧版 tgz 作为**代码回退候选**，但它不能证明新账本、待投递队列和迁移状态一定能安全降级。跨版本兼容目前**未验证**；回退前先备份 profile 和记录，不要在生产 profile 上直接演练。
- 桥接与插件回退是两件事；不要用插件回退覆盖 Host 文件，也不要用桥接备份修改插件包。

## 安装失败时

- `npm publish` 被拒、registry 找不到包：这是 `private: true` 和“尚未发布”的正常结果；当前没有公开 npm 包。
- `npm pack` 产物名不对：用文中的 `VERSION=$(node -p ...)` 从 `package.json` 读取，不要凭记忆写版本。
- 插件装上了但完整气泡不完整：先确认是否确实需要桥接，再看[已知问题](known-issues.md)；不要对未知版本强打补丁。
- 需要报告问题时，附插件版本、DSH/Node 版本、OS/浏览器、显示模式、是否安装桥接和最小步骤；只贴脱敏日志，不要贴 token、Cookie、私钥、真实会话或完整 profile。

开发和测试在源码仓进行；tgz 不含 `test/` 或 `scripts/`。测试要在**非 root 的一次性容器**中使用独立 `/tmp` tmpfs，不能在宿主共享 `/tmp` 上直接跑；具体前提见 [TESTING.md](../TESTING.md)。`npm ci` 只装开发依赖，不要把测试或安装脚本指向真实 profile。
