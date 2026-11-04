# 测试说明（公开候选）

本文件描述公开候选的测试范围，**不是上游开发仓的全量测试**。

## 开发/测试需要源码仓

`npm ci`、`npm test`、`npm run build`、`npm pack --dry-run` 是**源码仓开发命令**；通过 tgz 安装的插件包不包含 `test/` 或 `scripts/`，不能在这些命令下运行测试。请从源码仓执行。

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

## 实测结果（候选自检，未由外部复验）

- `npm test`：305 total / 301 pass / 0 fail / **4 skipped**
- 4 个 skipped 用例仅在环境变量 `DSH_CLIENT_CONVERSATION` 指向已安装的 DSH client bundle 时运行；未设置即跳过（即使本机已安装但未提供路径也一样）。公开/干净环境通常没有该私有路径。
- `npm ci`、`npm run build`、`npm pack --dry-run` 均 exit 0。

## 与上游测试的差异（面向用户）

公开候选不携带绝大多数内部运维/试验脚本；保留了一个**测试专用 helper** `scripts/deactivate-managed-entry.mjs`，仅由 `scripts/deactivate-managed-entry.test.mjs` 通过临时 fixture 目录调用，用于验证 managed 行移除/崩溃安全；它带有 `/tmp` 与 `--allow-production` 守卫，**不提供默认运行入口，不要对真实 profile 运行**。opt-in 真实模型 fixture（`fixtures/live.js`）已移除，候选不含真实模型测试。相对于上游 `npm test`，删除了 4 个内部 runner/设计文档相关测试文件，另有 8 个本来就不在上游 `npm test` 通配内的 spike/harness 测试未纳入。因此公开候选**未验证**这些 runner/默认权限/模型 fail-closed 等内部范围，不能视为与上游等价。内部逐项映射与减少范围记录在本地准备材料中，不随包分发。

环境适配：`scripts/ui-incoming.test.mjs` 移除了针对特定本机安装路径的硬编码回退，只保留 `DSH_CLIENT_CONVERSATION` 环境变量入口；这属于环境调整，不是未修改测试。
