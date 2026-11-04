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

保留上一版 tgz；回滚安装即重新 `dsh plugin add` 旧 tgz，并刷新/按需重启。profile 备份见 README 安装节。
