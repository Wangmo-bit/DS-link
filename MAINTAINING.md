# 维护约定（候选）

## 分支与版本

- `main` 保持可构建、可打包；开发分支按需短生命周期。
- 版本遵循 SemVer；候选阶段 `0.4.x`，首次公开发布前由所有者确认版本号。
- 每个发布 tag 对应一个本地 `npm pack` 产物；不在 CI 自动发布。

## 发布前检查（本地）

1. `npm ci`、`npm run build`、`npm pack --dry-run` 通过。
2. 检查 `npm pack` 清单：只含 `src/`、`dist/`、`cordis.patch.yml`、README/TESTING/THIRD_PARTY_NOTICES 与 package.json。
3. 测试按 [TESTING.md](TESTING.md) 的隔离前提执行；固定 `/tmp` 用例只在独立挂载/容器 `/tmp` 跑。
4. 安全/隐私复核：无真实会话、无本机绝对路径、无凭据；提交作者身份符合发布身份策略。
5. 由所有者批准后才创建远端 tag/发布；本仓不自动推送、不自动发包。

## 回滚

保留上一版 tgz 作为**代码回滚候选**；但“重装旧 tgz”**尚未证明**能兼容新版本已写入的 ledger、待投递队列与迁移状态。正式承诺数据可回退前，必须先做备份/恢复演练和跨版本 downgrade 测试，并在 release notes 标注已验证范围；当前只能视为未验证的应急路径。profile 备份见 README 安装节。

## 本机交接记录（2026-11-05，0.4.0 本地安装）

- 当前 web profile 安装自本地候选包；核心/host 对应 `0900249`，客户端 UI 对应 `250a6c4`。
- **当前 release/ 同名 tgz 是 09:23 后重新构建的 `045cb6be…`，不是独立冷审/首次验收所针对的 `1d890ea0…`。** 两者 runtime 同源但 tar 元数据与客户端 UI 不同；不要把旧 SHA/清单标签套到新包。
- 已装包当时实际核对的 tar SHA 为 `045cb6be…`，安装 dist 为 `f62d8e4c…`；`release/SHA256SUMS.txt` 已绑定该次重建包。
- 未来安装/发布前，必须按**实际文件**重新核 SHA、版本、包内容与清单绑定；不得沿用历史 manifest。
- 安装/回退备份见 `/home/<user>/.dsh/backups/session-link-install-20261105-082043` 与 `/home/<user>/.dsh/backups/session-link-ui-install-20261105-092534`（仅本机，0700）。
