# 维护指南

本文件面向有合并、打包或发布权限的维护者；普通安装与使用见 [安装说明](docs/installation.md)。

## 权限与自动化边界

- 默认只做本地准备和检查。**push、改变仓库可见性、创建 tag/Release、`npm publish`、安装到日用/生产 profile、重启服务、改写历史**都需要所有者逐项授权。
- 不把发布、安装、重启或 Host 修改写进自动流程。CI 只做只读检查，不持有发布凭据，也不自动推送。
- 生产/日用 profile 不是试验场。任何安装、升级或回退都先备份目标 profile 和记录，再由获授权的人在隔离环境验证。
- 安全漏洞不进入公开 Issue；按 [SECURITY.md](SECURITY.md) 的私密渠道处理，报告材料使用合成或脱敏内容。

## 分支与版本

- `main` 保持可构建、可打包；开发分支短生命周期，合并前按改动面评审。
- 版本遵循 SemVer。仓库在公开准备阶段保留 `package.json` 的 `"private": true`；**pre-release 版本不是公开 Release**，候选版本号以 `package.json` 为准，不从旧文档或旧产物推断。
- 只有所有者明确决定公开后，才考虑去掉 `private` 和发布；本指南不把任何候选号写成已发布版本。
- 每个发布 tag 应对应从目标 commit 实际构建并核对过的 tgz；不在 CI 自动创建 tag 或上传制品。

## 变更评审

- 一个 PR 解决一个可单独审阅的问题；说明原行为、改动原因、兼容影响和另一显示模式是否检查过。
- 按改动面验证，不机械跑全量：先跑相关回归，再按证据扩大范围。跳过、未运行、失败不能写成通过。
- 涉及协议、账本/数据结构、权限、安装方式或显示模式的改动，先讨论再实现；不自行新增门禁、allowlist 或长期机制。
- 用户可见文案按现有中英结构同步；改功能、兼容或安全事实时，同步更新对应英文入口。
- 不把真实会话、凭据、个人路径或私有运维材料带进代码、fixture、日志或提交；截图和演示使用合成内容。

## 测试门禁

- 测试在**源码仓**运行；tgz 安装包不含 `test/` 和 `scripts/`。
- `npm ci` 只装开发依赖；不要把测试或安装脚本指向真实 profile，也不要在测试中读取或发送真实会话。
- `npm test` 涉及固定 `/tmp` 路径和 `chmod` 权限故障注入，**只能在非 root、一次性容器的独立 `/tmp` tmpfs 中运行**；不能在宿主共享 `/tmp` 上直接跑，也不能用 `TMPDIR` 代替独立 tmpfs。具体镜像、命令和已知副作用以 [TESTING.md](TESTING.md) 为准。
- 测试输出里的 skip 要单独记录；不要用“全量测试绿”替代对应用户路径的验收，也不要把跳过解释成通过。

## 打包与发布准备

- 打包白名单、产物检查和 `private` 边界见 [PACKAGING.md](PACKAGING.md)。
- 发布准备、候选构建、Release/npm 的授权边界见 [RELEASING.md](RELEASING.md)。
- 发布前至少核对：目标 commit、`package.json` 版本、tgz 内容、SHA-256、许可证/第三方声明、README/安装说明中英一致，以及实际加载的插件/客户端版本。
- 生产安装/升级和发布动作由所有者另行执行；本仓不自动 push、不自动发包、不自动更新任何 profile。

## 可选 Host 桥接

- 完整气泡桥接是**源码内的独立 Host 维护工具**，不是插件安装、不是官方 Host 改动，也不随 tgz 分发。
- 默认只读检查；`--apply` 需要另行授权、已存在的私有 `0700` 备份目录、精确版本/哈希/owner/非符号链接检查；拒绝 `sudo` 绕过。
- 不自动安装、不自动重装旧桥、不自动重启。宿主升级可能覆盖桥接；版本或哈希不匹配就停止，重新适配和验收。
- 操作命令、兼容范围与回退边界见 [安装说明](docs/installation.md) 的“可选 Host 桥接”一节。

## 回退

- 旧 tgz 只作为代码回退候选；账本、待投递队列和迁移状态的跨版本降级兼容**未验证**，不能承诺一键回退。
- 回退前备份 profile 与记录，在隔离环境演练；桥接另有自己的备份和收据，插件回退不能拿它覆盖 Host。
- 不用未知来源的备份、旧哈希或旧 manifest 推断当前安装态。

## 文档同步

- 安装/兼容事实同步 [docs/installation.md](docs/installation.md) 与 [docs/installation.en.md](docs/installation.en.md)；双模式与限制同步 [docs/known-issues.md](docs/known-issues.md) 和英文对应页。
- 许可、第三方声明和素材来源分别维护在 [LICENSING.md](LICENSING.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[ASSETS.md](ASSETS.md)；新增或移植第三方内容时同步更新。
- 语言覆盖与未翻译范围见 [LANGUAGES.md](LANGUAGES.md)。不要用 README 有英文版就推断整个 UI 或全部文档已双语完成。
