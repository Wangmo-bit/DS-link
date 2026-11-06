# 官方安装规范合规自查与整改（通信插件，2026-11-06）

范围：仅本仓 `<repo>`。本轮为**只准备**：不安装、不重启、不改当前 web profile、不写仓外标准目录、不清空旧包。
规范依据：`<public-handbook>/workflows/插件官方安装规范-草案.md`、`scripts/plugin-install-check.mjs`、`templates/插件安装自查表.md`（只读引用）。

## 0. 身份与包

| 项 | 值 |
| --- | --- |
| 插件名 | `@wangmo/dsh-session-link`（会话互通） |
| 源码仓 | `dsh-session-link-public-candidate`，HEAD `7566b3a` + 本轮未提交改动 |
| 当前已装版本 | `0.4.0`（真实 profile 指向 `release/chat-ui-68060bf/wangmo-dsh-session-link-0.4.0.tgz`，SHA `1af9273d…`） |
| 最新源码/准备包版本 | `0.5.0` |
| 准备包路径 | `release/0.5.0/wangmo-dsh-session-link-0.5.0.tgz`（仓内） |
| 准备包 sha256 | `d97f34eb661da64d6dd14e7a525365e18c4fe5638261dca4b54a29919a08084e` |
| 标准目标（未落盘） | `~/.dsh/plugin-artifacts/dsh-session-link/wangmo-dsh-session-link-0.5.0.tgz` |
| 是否需要重启 | 需人类确认后执行；安装由 profile 依赖变更触发，含宿主侧代码变更通常需重启，刷新不足以保证生效 |

## 1. 三层状态（不要混为一谈）

1. **仓内准备包质量**：`0.5.0` 包在隔离 profile 用官方入口安装、挂载、客户端 bundle 与设置页均验证通过；六项合规项全部 PASS。
2. **仓外标准目标**：`~/.dsh/plugin-artifacts/dsh-session-link/` 尚未创建，本轮按边界**未写入**。
3. **当前安装态**：仍是 `0.4.0` 旧包且 profile 记录的来源是旧 tgz；与最新源码版本不一致 → 该项**保留 FAIL**。

## 2. 六项逐项（人工补充脚本盲区）

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 包内 MIT 全文 + `license: MIT` | PASS | 仓内 `LICENSE` 为 21 行完整 MIT（1067 B，四段条款齐全）；`package.json.license = MIT`；包内 `package/LICENSE` 1067 B 全文一致 |
| 2 | 安装来源 `file:` 标准 tgz，非 `link:`/复制目录 | 准备包 PASS / 当前安装态部分 FAIL | profile 记录为 `file:`（非 link），但指向**旧** `release/chat-ui-68060bf/…0.4.0.tgz`，不是本轮标准包 |
| 3 | 标准目标 `~/.dsh/plugin-artifacts/<简称>/` 且文件名带版本 | **未落盘** | 目标路径已给出；本轮禁止写仓外，未创建目录。仓内暂存于 `release/0.5.0/`（版本化命名） |
| 4 | 内容变更升版本、禁同版本覆盖重打包 | PASS（已整改） | 由 `0.4.0` 升为 `0.5.0`；同步 `PLUGIN_VERSION`、`exports` 精确入口 `entry-0.5.0.js`、mount id `session-link-runtime-0-5-0`、`package-lock` 根版本、README/EN 安装片段、RELEASING/RELEASE_NOTES/CHANGELOG。旧 `0.4.0` 包**未覆盖**（见 §4） |
| 5 | `files` 声明全存在、未声明不进包 | PASS | 7 项声明全部存在；`npm pack` 实际 27 个条目，含 LICENSE/README/TESTING/THIRD_PARTY_NOTICES/icon/cordis.patch.yml/dist/src，无 `test/`、`docs/`、`scripts/`、`node_modules` |
| 6 | 无 node_modules / 凭据 / 日志 / 真实会话数据 / 测试证据 | PASS | 包内无上述条目；本仓无凭据文件；`THIRD_PARTY_NOTICES.md` 仅声明设计参考，未 vendored 第三方代码 |

脚本盲区已按总负责人提示人工补证：脚本只校验 `file:` 前缀、不查标准目录/真实 tgz 内容/完整 MIT/运行版本/包 sha；以上 PACK/FAIL 结论均附人工证据。

## 3. 官方入口隔离验证（不触碰真实 profile）

- 隔离 `DSH_HOME=/dev/shm/...`，`dsh --from-default-profile web --profile <隔离名>` 初始化。
- `dsh plugin --profile <隔离名> add file:…/0.5.0.tgz` → 依赖写入 `file:` 精确路径，`node_modules` client SHA `afd49a25…` 与包内一致。
- `--dump-config` 出现 `id: session-link-runtime-0-5-0`，`name: '@wangmo/dsh-session-link'`。
- 之后启动隔离实例（临时端口），「插件 → 已安装插件」可见该包，「会话互通」设置页可打开（气泡/卡片两项 + 保存），`data-slot-error` 为 0。
- 结束后删除隔离 `DSH_HOME`；真实 web profile 依赖、安装 dist、版本、服务 PID 均未变化。

## 4. 旧包保全（本轮无清理动作）

未执行任何 `rm` 于 `release/`、`dist/`、`plugin-artifacts`；仅新增 `release/0.5.0/` 目录与文件。现存历史包保持原样：

| 包 | sha256 | mtime |
| --- | --- | --- |
| `release/chat-ui-68060bf/wangmo-dsh-session-link-0.4.0.tgz`（**当前 profile 指向**） | `1af9273d47ac3422586db613055bcfada197f04000dc4c43a3a573691b67005a` | 2026-11-05 16:59 |
| `release/wangmo-dsh-session-link-0.4.0.tgz`（更早 0.4.0 包） | `09c999870cc342630f43e7ad25e49ee102632d3f83c9a1585f40d577fe0424d2` | 2026-11-05 15:38 |

两者与 `release/SHA256SUMS.txt` 中的历史记录不同名不覆盖；不声称本轮重新打包能恢复任何旧包。**注意**：当前实际运行 client（`afd49a25…`）是 13:50 直接装入 node_modules 的字节，**不等于** profile 所指向旧 tgz 中的 `63fe5eb0…`；即当前安装态本身已与记录来源不一致，任何后续安装都会覆盖。

## 5. 同名同版本重复目录（回应总负责人）

`<main-dev-checkout>`（主开发仓，HEAD `01d03e4`，`UNLICENSED`，无 LICENSE）与 `dsh-session-link-public-candidate`（HEAD `7566b3a`，MIT）**无共同祖先**，是两个独立历史的同包名仓库：

- 主仓缺本轮 Web 文件（`src/client/native-flow.jsx`、`display-mode.mjs`、`subagent-message.jsx` 等），不是本次待发布候选。
- 两仓 dist 不同：主仓 `fed6ac1d…`，候选 `afd49a25…`。
- 候选仓才是本轮准备包来源；主仓不作为另一插件，不覆盖、不删除。
- 旧同版本 `0.4.0` 哈希一律不沿用；本轮以 `0.5.0` 新包与 `d97f34eb…` 为准。

## 6. 已做整改

1. 版本 `0.4.0` → `0.5.0`（`package.json`、`package-lock.json`、`src/core/constants.js:PLUGIN_VERSION`）。
2. 新增精确版本物理入口 `src/host/entry-0.5.0.js`；`exports` 改为 `./runtime-0.5.0` 与 `.` 同指该文件（硬编码版本一致性由 `test/host-package.test.js` 守住）。
3. mount id 改为 `session-link-runtime-0-5-0`，与版本推导规则保持测试通过。
4. 版本断言测试（host-connection / core-settings / core-dispose / host-package）同步 `0.5.0`。
5. README/README_EN 安装片段 `VERSION=0.5.0`；RELEASING、RELEASE_NOTES、CHANGELOG 同步；新增 `RELEASE_NOTES-0.5.0.md`。
6. 重建 `dist/client.js`（字节仍为 `afd49a25…`，UI 内容未改）并打出 `0.5.0` 包。
7. 全量隔离测试 407/407 通过（bwrap 临时 `/tmp`）。

## 7. 待人类统一确认的准确命令（尚未执行）

```bash
# 1) 把准备包落到标准目录（本轮未写仓外；目录尚不存在）
mkdir -p ~/.dsh/plugin-artifacts/dsh-session-link
cp <repo>/release/0.5.0/wangmo-dsh-session-link-0.5.0.tgz ~/.dsh/plugin-artifacts/dsh-session-link/
sha256sum ~/.dsh/plugin-artifacts/dsh-session-link/wangmo-dsh-session-link-0.5.0.tgz   # 应等于 d97f34eb…

# 2) 备份 profile 后由官方入口安装（会改写当前 profile 依赖与 node_modules）
cp ~/.dsh/profiles/web/package.json ~/.dsh/backups/profile-web-$(date +%Y%m%dT%H%M%S).json
dsh plugin --profile web add ~/.dsh/plugin-artifacts/dsh-session-link/wangmo-dsh-session-link-0.5.0.tgz

# 3) 验收：插件页可见、版本 0.5.0、来源为上述标准 tgz file: 路径
# 4) 需要重启时由人类执行（本插件含宿主侧代码变更，刷新可能不足）
```

升级风险：`0.4.0` → `0.5.0` 客户端 UI 内容与已装 `afd49a25…` 一致，但宿主侧入口版本号/mount id 变化，安装后需重启才保证新宿主代码生效；ledger 数据结构未改（`STATE_VERSION` 仍为 3），回退到 0.4.0 包在数据层未见新构造，但**未验证**。

## 8. 未验证项

- 未在真实 web profile 安装 `0.5.0`，未重启验证宿主侧入口切换。
- 未验证 `0.4.0` ↔ `0.5.0` 的 downgrade/rollback 兼容性（无演练）。
- 未将包写入 `~/.dsh/plugin-artifacts/dsh-session-link/`（本轮边界）。
- 主仓 `01d03e4` 与本候选的关系仅做只读比对，未合并、未同步。
