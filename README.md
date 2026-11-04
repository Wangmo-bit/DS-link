# Session Link for DeepSeek Harness

让已有 DSH 普通会话之间可靠地互相发消息、请求协作并收取明确回复；无需新建 Bot 团队，也不要求在聊天框里手动转发。

> License、发布渠道与正式名称待项目所有者决定；本仓为本地候选，尚未公开发布。

## 兼容范围

- DeepSeek Harness **0.2.1-rc.5**
- **Node.js 24（已验证 v24.21.0）**；`package.json` 的 `engines: >=24` 只是运行时下限声明，**不代表 24 以上所有版本都测过**；其他版本未验证，未来大版本不保证
- **Linux Web**（本机浏览器 GUI）
- 不承诺 Windows/macOS、其他 DSH/Node 版本或其他部署形态；升级宿主前请先核对 `package.json` 的 `engines` 与 peer 依赖。Node 24 以外的版本未验证。

## 能力

- 主会话通过 `session_link_send` / `session_link_reply` / `session_link_create` 与其他普通会话通信。
- 聊天内双向卡片：发件人/收件人/主题三行摘要，按当前会话收发方向着色；展开后同一外框显示正文、默认收起的技术详情与原生轨迹入口。
- 设置页可暂停新投递、限制并发、调整回复等待与正文保留；记录页可查看投递/回执/回复状态、取消未投递、暂停/结束关联组。
- 明确区分“已持久化（accepted）”“已进入对方上下文（receipt）”“对方明确回复”；不宣称未证实的已读/已处理。

## 安装（本地包）

```bash
# 将 VERSION 替换为实际版本，tgz 放在当前目录或改用绝对路径
VERSION=0.4.0
dsh plugin --profile web add "./wangmo-dsh-session-link-${VERSION}.tgz" --offline
```

安装/升级前建议备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`。仅客户端 bundle 变化时通常刷新浏览器即可看到新界面；**若包含宿主侧代码或插件配置变化，可能需要按你的维护权限重启 DSH**，不要假定“刷新一定生效”。不要手工改已安装包文件。

## 开发

以下命令需在**源码仓**执行；安装后的 tgz 不含测试与开发脚本。

```bash
npm ci
npm test          # 公开候选测试（305 total / 301 pass / 4 skipped；非上游全量），见 TESTING.md
npm run build     # 生成 dist/client.js
npm pack --dry-run
```

## 安全边界

- 通信是**会话协作**，不是本人授权：收到消息的会话不会因此获得额外权限，也不能替用户批准操作。
- 插件按 owner-only 的宿主认证接口工作；不要向不可信会话发送敏感内容。
- 暂停/恢复、投递状态、失败原因都以账本事实为准；模型执行时间不属于插件延迟。

## 已知限制

- 目标会话忙碌时，消息在下一个 step 边界投递，不打断正在执行的工具批。
- 真实模型/供应商延迟不在本插件控制范围；生产忙时延迟尚未有公开基准。
- 本仓当前为个人自用候选，未承诺跨版本升级/回滚路径；如后续提供 release notes，升级前请阅读。

## 许可

当前尚未选择开源许可证，正式公开前由项目所有者决定。
