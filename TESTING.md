# 测试说明（公开候选）

本文件描述公开候选的测试范围，**不是上游开发仓的全量测试**。

## 开发/测试需要源码仓

`npm ci`、`npm test`、`npm run build`、`npm pack --dry-run` 是**源码仓开发命令**；通过 tgz 安装的插件包不包含 `test/` 或 `scripts/`，不能在这些命令下运行测试。请从源码仓执行。运行 `npm test` 前必须满足下文的独立 `/tmp` 隔离前提；仅设置 `TMPDIR` 不够。

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

## 测试结果与环境

- 测试数量和结果以目标提交的本次运行记录为准；旧版候选的统计不代表当前版本。
- 宿主集成用例需显式提供对应的 client bundle 环境变量；未提供时会跳过，不能把跳过当作通过。
- 运行完整测试套件前，必须满足本文件下方的隔离前提；仅设置 `TMPDIR` 不够。

## 与上游测试的差异（面向用户）

公开候选不携带绝大多数内部运维/试验脚本；保留了一个**测试专用 helper** `scripts/deactivate-managed-entry.mjs`，仅由 `scripts/deactivate-managed-entry.test.mjs` 通过临时 fixture 目录调用，用于验证 managed 行移除/崩溃安全；它带有 `/tmp` 与 `--allow-production` 守卫，**不提供默认运行入口，不要对真实 profile 运行**。opt-in 真实模型 fixture（`fixtures/live.js`）已移除，候选不含真实模型测试。相对于上游 `npm test`，删除了 4 个内部 runner/设计文档相关测试文件，另有 8 个本来就不在上游 `npm test` 通配内的 spike/harness 测试未纳入。因此公开候选**未验证**这些 runner/默认权限/模型 fail-closed 等内部范围，不能视为与上游等价。内部逐项映射与减少范围记录在本地准备材料中，不随包分发。

环境适配：`scripts/ui-incoming.test.mjs` 移除了针对特定本机安装路径的硬编码回退，只保留 `DSH_CLIENT_CONVERSATION` 环境变量入口；这属于环境调整，不是未修改测试。

## CI 运行身份（重要）

CI 在一次性容器中运行，但容器默认是 **root**。部分存储测试用 `chmod` 只读来注入写入失败，root 会绕过权限导致“期望拒绝未发生”。因此 CI 在 `npm ci` 后执行 `chown -R node:node .`，并以镜像内非 root 用户 `node` 运行 `npm test`/`build`/`pack`。不要为了让测试变绿而删除或跳过这些断言；若在本地以 root 运行测试，同样会失效，应先切到非 root。

## 测试副作用与资源边界（重要）

测试**不是**无进程、无删除、无固定路径副作用的：

- `test/core-lock-multiprocess.test.js` 会 `spawn` Node 子进程（持锁/竞争）。**正常路径**：`SIGTERM` 后 `await waitExit`；**异常兜底**：`finally` 里的 `SIGKILL` **没有 await 退出**，因此不保证异常分支子进程已收回。代码等待也不等同于外部可审计的进程树终态。
- `test/core-create.test.js`、`scripts/v04/fixture-guard.test.mjs`、`scripts/deactivate-managed-entry.test.mjs` 等使用真实文件系统并递归 `rm` 临时目录；多数用 `mkdtemp` 唯一根，但并非所有用例都如此。
- `scripts/v02/fixture-guard.test.mjs`、`scripts/v03/fixture-guard.test.mjs`、`scripts/v03/fixture-model.test.mjs`、`scripts/stress/fixture-guard.test.mjs` 使用**固定** `/tmp/dsh-session-link-*` 目录；重复运行可能覆盖/清理同路径旧物，运行前无法证明归属。
- 因此“测试通过”不能证明没有子进程、没有删除、没有覆盖旧临时文件。**固定字面量 `/tmp/...` 不受 `TMPDIR` 重定向影响；新用户也不自动隔离 `/tmp`**，二者都不足以保护这些用例。
- 运行固定路径用例的前提：在**独立挂载命名空间或容器内独立 `/tmp`** 中，并先证明该 `/tmp` 未映射宿主真实路径；否则这些用例先不跑。
- 本候选此前那次 `npm test` 运行日志 `/tmp/final-test.log` 的写前状态同其他固定路径一样未知，不能仅凭“当前没有文件”推断无影响；不要删除/探测未知内容，记录为未知事实。
- 不要在本机共享 `/tmp` 上盲跑，也不要把本候选测试当作无副作用验证。
