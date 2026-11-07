# Session Link 0.8.2 — 图标统一候选 / Unified icon candidate

- 仅替换插件图标，功能、配置、数据与安装格式均不变。
- 新图标遵循 `2026-11-07` 自制插件图标规范：64×64 画布、圆角方底 `#e9edf9`、单色线条 `#33499f`（`stroke-width=3.4`、圆头），符号为两个圆角对话气泡相扣；包内仍只含 `assets/icon.svg` 矢量图，`package.json` 的 `icon` 继续指向它。
- Icon-only release: unified 64×64 rounded tile (`#e9edf9`) with one monochrome line symbol (`#33499f`, stroke 3.4, round caps) showing two interlocking speech bubbles. No functional, configuration, data or install-format changes.
- 本版按任务边界**未安装到任何 profile**；候选包仅打包交付。升级前请备份 profile，安装后按 `TESTING.md` 的隔离要求运行完整测试；旧包与配置保留不等于数据回退已演练。
