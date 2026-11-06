# Session Link for DeepSeek Harness

[English](README_EN.md) | 简体中文

![DSH 0.2.1-rc.5](https://img.shields.io/badge/dsh-0.2.1--rc.5-2f6f4f?style=flat-square) ![Node 24](https://img.shields.io/badge/node-24-4b6fff?style=flat-square) ![License MIT](https://img.shields.io/badge/license-MIT-2f6f4f?style=flat-square)

让**已有 DSH 普通会话**之间直接互发消息、请求协作、收取明确回复——不需要新建 Bot 团队，也不用在聊天框里手工转发。

![Session Link 演示：产品周报 · 讨论 向 设计评审 · 笔记 发出周报评审请求，并收到明确回复；卡片显示发件人/收件人/主题与投递状态](assets/screenshots/demo-cards.png)

*合成演示：会话名与内容均为虚构，来自隔离测试环境，不含真实用户数据或凭据。*

> **状态：私有预发布（private pre-release），尚未公开。** 仓库当前为私有；许可证（MIT）与包名/scope（`@wangmo/dsh-session-link`）已确定，是否公开/发布时间仍待项目所有者决定。截图来自隔离合成会话（`产品周报 · 讨论` / `设计评审 · 笔记`），不含真实对话或凭据。

## 为什么用它

- **普通会话即可参与**：只要符合 Host 身份校验，不需要固定 ID、标题或预先建团队。
- **消息有状态，不靠猜**：明确区分“已持久化（accepted）”“已进入对方上下文（receipt）”“对方明确回复”，不把 accepted 当已读。
- **双向卡片**：发件/收件方向着色；展开同一张卡看正文、技术详情和原生轨迹入口，不额外堆一行。
- **可控制**：设置页可暂停投递、限制并发、调整回复等待；记录页可查看状态、取消未投递、暂停/结束关联组。

## 语言状态（不要把它当成多语言 UI）

| 层 | 当前状态 |
| --- | --- |
| README / 开发文档 | 中文 + [English](README_EN.md) 两份入口 |
| 插件 UI（卡片、设置、状态、错误） | **中英双语**，跟随宿主语言；用户正文/主题/身份/技术原值不翻译 |
| `locale` 元数据 | 当前无 locale 资源；未注册插件名称/描述的多语言元数据 |
| 维护/安全/测试文档 | SECURITY 为英文，TESTING/MAINTAINING/PACKAGING/CHANGELOG 以中文为主 |

首期范围：仅中文 + 英文（不再扩日文等）。英文 UI 已在隔离环境做设置页/卡片冒烟验证；动态错误与长文案仍在补全。详见 [LANGUAGES.md](LANGUAGES.md)。

## 快速开始

1. **获取源码**：仓库当前为私有，地址 `https://github.com/Wangmo-bit/dsh-session-link`（需要所有者授权访问，尚未公开）：

   ```bash
   git clone https://github.com/Wangmo-bit/dsh-session-link.git
   cd dsh-session-link
   ```

   公开后同一地址可匿名 clone；公开前请勿把私有访问凭据写进命令或提交。
2. **构建并安装**：见下方“安装”节。
3. **先找可用会话**：在设置/记录页查看可通信的普通会话；不要向不可信会话发送敏感内容。
4. **发送第一条消息**：
   - 先调用 `session_link_operation` 获取 `operationId`（重试需复用同一 id，避免重复投递）。
   - 再调用 `session_link_send`，指定 `targets`、`kind`（`notification` 或 `request`）、`subject`、`text`。
   - `request` 表示请对方明确回复；`notification` 不要求回复，也不代表已读。
5. **查看状态**：卡片显示“已持久化 / 已进入上下文 / 明确回复”；这些是不同事实，不能把 accepted 当已读。
6. **回复**：收到 request 的会话用 `session_link_reply`，带原消息 `messageId` 与新的 `operationId`；仅对方显式回复才算回复。

## 安装

兼容：**DSH 0.2.1-rc.5 / Node 24（实测 v24.21.0）/ Linux Web**。其他版本未验证。

从源码构建并本地安装（当前未发布到 registry、未提供 Release tarball；需要 Node 24 + DSH 0.2.1-rc.5）：

```bash
npm ci
npm run build
npm pack
# 得到 wangmo-dsh-session-link-<version>.tgz
VERSION=0.6.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

安装/升级前备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`。仅客户端 bundle 变化时通常刷新浏览器即可；若含宿主侧代码或插件配置变化，可能需按维护权限重启 DSH——不要假定刷新一定生效。不要手工改已安装包文件。

## 使用

在会话里让模型调用：

- `session_link_send`：向一个或多个普通会话发送 notification/request。
- `session_link_reply`：对收到的 request 给出明确回复。
- `session_link_create`：创建会话并立即派首条任务（不提供空会话入口）；位置三选一：已有 `workspaceId`、新建 `newProject`、或登记已有目录 `existingProject:{path,title?}`（后者只调用 Host workspace registry 登记，不创建/读取/修改该目录内容；省略 `title` 时 workspace 标题采用 Host registry 的目录默认名）。

收到消息的会话会在下一个 step 边界看到它；忙碌时不会打断正在执行的工具批。所有投递/回执/回复状态以账本事实为准。

## 安全边界

- 收到消息**不等于**获得本人授权：对方会话不会因此多出权限，也不能替用户批准敏感操作。
- 插件按 Host owner-only 认证接口工作；不要向不可信会话发送凭据、私密历史或敏感资料。
- 暂停/恢复、失败原因、投递状态均以账本为准；模型/供应商耗时不属于插件转发时间。

## 文档

| 文档 | 内容 |
| --- | --- |
| [TESTING.md](TESTING.md) | 测试范围、跳过条件、测试副作用与隔离前提 |
| [SECURITY.md](SECURITY.md) | 私密漏洞报告渠道（待建）与支持范围 |
| [MAINTAINING.md](MAINTAINING.md) | 分支/版本/发布/回滚维护约定 |
| [PACKAGING.md](PACKAGING.md) | 打包白名单、产物验证、发布前检查 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [LANGUAGES.md](LANGUAGES.md) | 四层语言覆盖现状与缺口（非多语言 UI 声明） |
| [LICENSING.md](LICENSING.md) | 许可证建议与待确认草案（尚未生效） |

## 已知限制

- 目标会话忙碌时消息在下一个 step 边界投递，不打断当前工具批；忙时延迟尚无公开基准。
- 真实模型/供应商延迟不在插件控制范围。
- 当前为个人自用候选，未承诺跨版本升级/回滚路径；如后续提供 release notes，升级前请阅读。

## 许可

本项目自有代码采用 **MIT License**（见 [LICENSE](LICENSE)，版权人 `Wangmo-bit`）。第三方代码/素材/依赖的许可独立保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与各自许可中，**不因本项目 MIT 而改变**。决策记录见 [LICENSING.md](LICENSING.md)。
