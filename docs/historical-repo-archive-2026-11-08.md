# 历史开发仓归档记录（2026-11-08）

## 是什么

`/path/to/dsh-session-link` 是本插件的**早期开发仓**：2026-11-01 首次提交，最后提交 2026-11-06（`12caa6d docs(agents): reference the shared plugin installation spec`），覆盖 0.1.0 – 0.4.0 阶段，含 V0.2/V0.3/V0.4 蓝图与验收记录、v04 隔离验证 harness 与截图、0.1–0.4 发布包、以及该阶段研发/开源准备材料。

它不是当前交付仓。0.5.0 起的实现、发布与安装记录都在 `dsh-session-link-public-candidate`（本仓）。两仓是**独立 Git 历史**，无共同祖先。

## 处置

用户于 2026-11-08 确认：历史仓已过期，若无价值则删除。处置方式为**先归档后删除工作树**：

- 归档：`/path/to/.archive/dsh-session-link-dev-2026-11-01_2026-11-06.tar.zst`
- SHA256：`c493c4b8303394b179f4ff065185b8503095a76a4515f9f661071766447ac556`
- 大小：20 MiB，2078 个条目；包含 `.git`（879 项）、0.1–0.4 发布包（17 个 v04 tgz 等）、v04 证据截图（87 张 PNG）与全部未提交研发材料。
- 排除项：`node_modules/`（11 MiB 依赖）与 `.playwright-cli/`（临时页面日志）。
- 归档前已用 `zstd -t` 校验、抽样解包核对 README/.git/证据 PNG。
- 删除后原路径曾短暂保留一个指向归档的 `README-ARCHIVED.md`，作为 DSH 工作区 `插件丨会话通信` 的路径锚点。

## 占位目录也已删除

2026-11-08，本会话被移动到 `dsh-session-link-public-candidate` 工作区后，用户确认不再需要旧路径锚点，占位目录 `/path/to/dsh-session-link/` 已删除（含其中的 `README-ARCHIVED.md`）。

- 旧工作区注册项仍在：`插件丨会话通信`（id `36718989-7df0-457c-b63c-9263c98dd4fd`），其路径现已不存在；其中的会话是两条 cold 会话（`session-a0798d44…`、`session-c1bd5803…`），会话数据本身不受影响，如需继续使用应在界面中把工作区改指到本仓或删除该工作区。
- 归档与恢复方式不变，见上。

## 影响与注意

- 本仓（public-candidate）没有任何代码或测试依赖历史仓绝对路径；删除后无需改动。
- 跨会话记录曾把 `/path/to/dsh-session-link/scripts/v04-ui-harness/artifacts/*.png` 当作证据引用；这些引用现在只能指向归档内容，原路径已不可访问。
- 需要时从归档恢复到临时目录即可，不应恢复为工作仓继续开发。
- 归档文件是唯一保留副本；删除它等于彻底放弃 0.1–0.4 历史。除非确认不再需要，不要清理 `/path/to/.archive/`。

## 当前唯一权威仓

`/path/to/dsh-session-link-public-candidate`，产品需求见 [PRD.md](../PRD.md)。
