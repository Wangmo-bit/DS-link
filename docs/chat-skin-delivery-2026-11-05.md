# DS-Bot 式聊天交互交付记录

## 本轮范围

- 同一个会话互通插件内实现聊天皮肤，不新增插件，不改投递/账本/权限逻辑。
- 用户（王墨）靠右，助手与来信靠左。作者是气泡外的真实 React header，气泡内只有一层背景。
- 图片/附件在气泡内；保留宿主的授权加载、预览、复制、引用、文件打开以及回合尾操作。
- 长文超过 1500 Unicode codepoints 或 25 行后折叠；预览前 10 行、正文最多 600 codepoints；原位展开/收起；复制使用原文。流式输出不折。
- 完成回合收成一行：耗时、思考与工具次数，点击仍能查看原生过程；运行中显示思考中。数据缺失不编造。
- 跨会话发送在当前会话显示轻提示，不复制发件气泡；收到的消息显示发送者气泡。轻提示点开双方往返阅读器，支持引用、长文展开、复制与更早记录。
- 通信记录页复用同一气泡正文排版，并提供双方往返入口；不增加暂停/结束通信按钮。

## 实现边界

- 彻底撤掉原先对虚拟列表插 sibling、MutationObserver 和伪元素气泡的尝试。
- 用户节点包装公开原生 renderer，原生内容 factory 与操作不变。助手节点用公开 MarkdownText、reasoning factory、images factory 重画，避免重声明宿主子插槽。
- 原生错误、审批、命令、工具与未知节点不接管；原生回合尾的复制、反馈、分支、费用保持不变。
- 现有 Claude Style 保留外壳/主题/输入区。本轮只在独立 sl-chat 命名空间内管理消息表面。
- 当前组合验证的是 Claude Style（主题层）与本插件（消息层）。另一款也替换聊天节点的插件若同时启用，运行顺序可能决定谁接管节点，不能保证双渲染层叠加；没有修改或启用 DS-Bot 的整套应用。

## 已执行验证

### 自动测试

- 新增纯模型测试 18 个：Unicode、阈值、fence、展开、流式、原文复制、缺失统计、停止/错误状态。
- 新增 React/插槽测试 11 个：作者与气泡兄弟结构、单一表面、原生 inject 参数、factory 图片、状态展开、卸载清理、不修改聊天 DOM。
- 完整 npm test 在 bwrap 独立 tmpfs /tmp、非 root 下运行，npm cache 也隔离到该 /tmp。最终显式指定已安装的 Conversation SDK：350 total / 350 pass / 0 fail / 0 skipped。
- 既有 4 个实物 dispatcher 用例也实际执行，没有为通过而删除断言。另加 2 个来信正文测试，覆盖窗口闭包重建 100 次仅取一次正文、在途响应用最新身份校验。
- 首次隔离测试的 pack 检查因只读 npm cache 失败；指定隔离可写 cache 后全量通过。
- build 与 git diff --check 通过。

### 实际页面（安装前隔离浏览器预览）

同一实际 URL http://127.0.0.1:3080；只在测试浏览器拦截当前插件 bundle 响应为候选，没有启动替代服务器，也没有中途安装或重启。使用现有聊天记录，不重新发测试消息、不创建测试会话。

| 视口宽度 | 页面横溢 | 往返阅读器横溢 | 作者在气泡外 |
|---|---|---|---|
| 375 | 无 | 无 | 是 |
| 768 | 无 | 无 | 是 |
| 1440 | 无 | 无 | 是 |
| 2288 | 无 | 无 | 是 |

其它实测：
- 通信记录页能打开，选择旧记录后能加载完整线程；投递元数据默认折叠。
- 跨会话轻提示可打开双方阅读器，双方消息按时间排列，引用归属正确。
- Escape 关闭阅读器并将焦点归还触发按钮。自测发现宿主快捷键可能吞原生 cancel，已修复 capture/清理并复测。
- 长消息展开/收起保留同一个气泡 DOM 节点，高度增加后可恢复。
- 实际图片均包含在所属气泡中，没有双层背景；名字完整显示为会话名，不再从网页标题猜。
- 深色正文对比已目视检查，修复 compact Markdown 继承灰色正文的问题。

截图：
- [桌面聊天](../output/playwright/chat-1440.png)
- [桌面往返](../output/playwright/exchange-1440.png)
- [窄屏往返](../output/playwright/exchange-375.png)
- [原位长文折叠](../output/playwright/long-message-fold.png)
- [通信记录线程](../output/playwright/mailbox-thread.png)

## 已知环境项与未冒充验证项

- 宿主/Claude Style 既有字体资源 404、启动时 archive-manager ready 警告不在本轮修改范围。
- 加载较早记录时观察到宿主 system-message Definition withdrew materialized target 警告；本轮没有改任何该 Definition 或 Host assembler。
- 审批按钮、真实失败发送、真实上传/发消息未在生产主动制造；保留原生实现，并由代码/既有回归覆盖。没有用用户真实权限做破坏性状态注入。
- 人工最终验收人：王墨；候选自验不冒充用户验收。

## 安装与复验结果

- 仅 Web；没有改手机端、桌面端或其它端。
- 实现提交：`68060bf`；统一安装一次，使用官方 `dsh plugin --profile web add`，没有先卸载。
- 包：[Web 完整包](../release/chat-ui-68060bf/wangmo-dsh-session-link-0.4.0.tgz)；SHA256 `1af9273d47ac3422586db613055bcfada197f04000dc4c43a3a573691b67005a`。
- 安装版 client SHA256 `63fe5eb062dd1b3fabaeb82095c0ca15d17fa6b7c8a6d813f68505ffdacfef95`，与自验构建逐字节一致。
- [安装前备份](</home/<user>/.dsh/backups/session-link-web-complete-68060bf-20261105-165941/>) 包含 profile 清单、锁文件、patch 和旧插件。
- 没有重启，没有安排自动重启。安装前后 Web PID 一致，health 200；profile 的 dsh 选用组合及其他依赖完全不变。
- 撤销测试浏览器 bundle 拦截后刷新实际 URL：服务返回新气泡与往返代码，未包含测试导航钩子；实际消息正确显示外置作者名。
- 安装后的通信记录复验：完整线程 5 条、选中高亮 1 条、无页面 alert；双方往返阅读器首批载入 100 条，可关闭并归还焦点。
- [安装后往返截图](../output/playwright/installed-exchange.png)；[安装后记录截图](../output/playwright/installed-mailbox.png)。
