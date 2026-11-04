# 打包说明（候选）

- `package.json` 的 `files` 为显式白名单：`src/core`、`src/host`、`dist`、`cordis.patch.yml`、`THIRD_PARTY_NOTICES.md`、`TESTING.md`；根 README 由 npm 强制包含。
- `prepack` 只运行 `npm run build`（本地 esbuild），不联网、不读 profile。
- 产物检查：`npm pack --dry-run --json --ignore-scripts` 后核对文件数/路径，不应出现 `docs/`、内部测试材料或 marker。
- 当前 `package.json` 为 `UNLICENSED`，未附 LICENSE；许可证决定后需同步更新 `license` 字段与包内文件。
- 版本与命名：包名/scope 已由所有者确定为 `@wangmo/dsh-session-link`，GitHub 仓为 `Wangmo-bit/dsh-session-link`；不再做中性化改名。安装命令、已有 profile 依赖与升级路径均以该标识为准。
