# 打包说明

本文件讲**如何从源码产出一个可安装的 tgz**；发布授权、tag/Release/npm 的边界见 [RELEASING.md](RELEASING.md)。

## 包边界

- `package.json` 的 `files` 是显式白名单：`src/core`、`src/host`、`dist`、`cordis.patch.yml`、`THIRD_PARTY_NOTICES.md`、`TESTING.md`、`assets/icon.svg`。
- npm 按自身规则会带上根 `package.json`、`README.md`、`LICENSE` 等基础文件；默认 `README.md` 为英文；中文 `README_ZH.md` 当前不在自动包含范围。以实际 `npm pack --dry-run --json` 的文件列表为准，不用旧清单推断。
- `prepack` 只运行本地 `npm run build`（esbuild），不联网、不读取 DSH profile、不安装插件。
- `dist/client.js` 是构建产物；改源码后重新构建，不要手改 `dist/`。
- **Host 桥接工具不随包分发**：`scripts/dsh-web-flow-bridge-rc1.mjs`、`scripts/install-host-flow-bridge-rc1.mjs` 不在 `files` 里，也不应打进 tgz。它们是精确版本、源码内、单独授权的 Host 维护工具，不是插件安装的一部分。
- 文档站、演示素材、测试、内部检查脚本、`release/`、`artifacts/`、marker 等不应出现在 tgz。

## 版本与私有门

- 版本从 `package.json` 读取；示例命令不要手写旧版本号：

  ```sh
  VERSION=$(node -p "require('./package.json').version")
  ```

- 公开准备阶段保留 `"private": true`；`npm publish` 会被拒绝，这是有意的发布门。不要在打包阶段擅自改成 `false`，也不要因为本地能 pack 就宣称已发布。
- 候选可以是 pre-release 号，但 **pre-release 不是公开 Release**；是否发布、何时发布由所有者单独授权。
- 包名/scope 为 `@wangmo-bit/ds-link`，仓库为 `Wangmo-bit/DS-link`。

## 构建与检查

```sh
npm ci
npm run build
mkdir -p output
npm pack --dry-run --json --ignore-scripts
npm pack --pack-destination ./output
```

- `npm ci` 只装开发依赖，不安装插件、不修改 profile。
- 先看 dry-run 的文件数和路径，再产出 tgz；产物名从包元数据生成，例如 `wangmo-bit-ds-link-<version>.tgz`。
- `npm run check:public -- --pack` 会检查公开准备必需文件、文档相对链接、包白名单，以及版本/`private`/许可证元数据；它是窄检查，不替代 Git 历史、远端设置和人工许可复核。
- 产物的 SHA-256 应单独记录并在发布说明中对应到构建 commit；不要用旧 SHA 或旧 manifest 套新包。
- `npm pack` 会执行 `prepack` 构建；若用 `--ignore-scripts` 检查清单，先手动 `npm run build` 并明确知道此举跳过生命周期脚本。

## 安装验证（隔离环境）

```sh
PROFILE=sl-test
VERSION=$(node -p "require('./package.json').version")
TGZ="$(pwd)/output/wangmo-bit-ds-link-${VERSION}.tgz"
dsh plugin --profile "$PROFILE" add "$TGZ"
```

- 只用隔离/测试 profile；安装前备份目标 profile 的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`。
- 不要拿日用/生产 profile 试验，不要手工改已安装包。
- 安装后核对实际加载的插件/客户端，而不是只看磁盘版本；安装命令和本仓都不会自动重启。

## 许可与声明

- 项目自有代码/文档为 MIT；`package.json` 的 `license`、根 `LICENSE` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 必须同步。
- 第三方代码、素材、图标和依赖保留各自许可；打包时不要删 NOTICE 或把第三方内容重新授权为 MIT。见 [LICENSING.md](LICENSING.md)。
- 修改第三方内容或许可时，重新核对包内声明和来源，不凭旧记录推断。
