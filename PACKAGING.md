# 打包说明（候选）

- `package.json` 的 `files` 为显式白名单：`src/core`、`src/host`、`dist`、`cordis.patch.yml`、`THIRD_PARTY_NOTICES.md`、`TESTING.md`、`assets/icon.svg`；根 README 由 npm 强制包含。
- `prepack` 只运行 `npm run build`（本地 esbuild），不联网、不读 profile。
- 产物检查：`npm pack --dry-run --json --ignore-scripts` 后核对文件数/路径，不应出现 `docs/`、内部测试材料或 marker。
- 当前 `package.json` 为 `license: MIT` 且仓内有 `LICENSE`；`assets/icon.svg` 随包发布。修改许可需同步更新 `license` 字段、`LICENSE` 与第三方声明。
- **宿主私有桥接不属于本包**：`scripts/dsh-web-flow-bridge*.mjs`、`scripts/install-host-flow-bridge-rc1.mjs` 不在 `files` 内，也不应打进 tgz；它们是一次性的、版本绑定的 Host 维护工具，单独授权、备份和验收。
- 版本与命名：包名/scope 已由所有者确定为 `@wangmo/dsh-session-link`，GitHub 仓为 `Wangmo-bit/dsh-session-link`；不再做中性化改名。安装命令、已有 profile 依赖与升级路径均以该标识为准。
