# 测试与验证 / Testing

[贡献说明](CONTRIBUTING.md) · [English contribution guide](CONTRIBUTING.en.md)

## 先隔离，再测试

测试包含固定 `/tmp/dsh-session-link-*` 路径、子进程、文件删除、锁竞争和 chmod 故障注入。不要在日用宿主的共享 `/tmp` 上运行完整套件。仅设置 TMPDIR 或换用户不够；root 还会绕过权限故障。

`npm test` 现在先检查 **Linux、非 root、独立挂载到 `/tmp` 的 tmpfs**，不满足就退出，避免误清理。按下面方式在一次性容器中运行：

```sh
docker build -f scripts/test.Dockerfile -t session-link-check .
docker run --rm --network=none --read-only --user=node \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --memory=3g --cpus=4 \
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=1g,mode=1777 \
  session-link-check
```

镜像构建阶段 `npm ci` 需要访问依赖源；测试运行阶段断网、只读根文件系统，源码/依赖复制到 tmpfs 后才测试、构建和核对包清单。退出即销毁所有测试数据。固定 Node 24 镜像 digest 见 Dockerfile；不是启动新的 DSH 服务。

`npm test` 用 `scripts/run-tests.mjs` 发现 test 和 scripts 的测试，包括 rc.1 桥接与安装器，不再手写容易漏挂的长列表。新增脚本子目录如需被发现，须修改 runner 的白名单。安装器测试使用合成前后像；它的隔离环境变量由经过守卫的 runner 设置。

## 哪些测试依赖实际 Host

上述镜像在构建时用 `scripts/prepare-host-fixtures.mjs` 获取并核验三份固定公开 SDK bundle，运行时只读使用；因此 CI 配方可以覆盖这些集成用例。直接运行源码而未提供夹具时，下列用例会明确跳过，不能把跳过算成兼容通过：

| 环境变量 | 需要的文件 / 范围 |
| --- | --- |
| `DSH_CHAT_FLOW_CLIENT` | 精确 rc.5 chat bundle，用于旧桥接用例 |
| `DSH_CHAT_RC1_CLIENT` | 原始 DSH `0.2.2-rc.1` chat bundle；精确 SHA 校验、桥生成和一次性前缀安装器验收 |
| `DSH_CLIENT_CONVERSATION` | 对应版本 conversation bundle；真实 dispatcher 的 4 个集成用例 |
| `DSH_CHAT_CLIENT` | 旧滚动补丁需要的精确 client artifact（具体入口以测试源码为准） |

只读挂载相应公开 SDK 夹具进测试容器并设置变量，禁止挂载生产 profile 或真实会话。桥接测试只修改 `/tmp` 中专门创建的假安装前缀，不改系统 DSH。不同历史测试的实际变量名以源码为准，不伪造环境使 skip 变 pass。

## 按改动选择证据

- 协议/存储：幂等、显式 reply、暂停、unknown、超时、旧数据迁移、锁与恢复。
- 客户端：气泡/卡片两条路径、作者身份、附件、审批、引用、操作行、Agent 归属与滚动。
- Host 维护：精确前后像、版本拒绝、备份、并发写入、原子替换、失败证据和重试。
- 包与文档：`npm run build` 后 `npm run check:public -- --pack`。检查是有限规则，不代替全历史人工审计。

UI 的 React/合成用例不是实际模型、图片上传、浏览器全部时序或真实权限验证。代码中保留原生动作也不等于已点过。应分别报告通过、失败、跳过和未运行。

## 演示素材不是验收录像

```sh
npm ci
# 若尚无浏览器，开发者可自行安装与 playwright-core 匹配的 Chromium。
# 或通过 CHROMIUM_PATH 显式指定一个已有浏览器。
npm run docs:assets
```

离线组件演示不连接 DSH、不读取 DSH_HOME、不发送消息，只有虚构会话和标注的宿主替身。生成说明和可选 GIF 工具见 [ASSETS](ASSETS.md)。生成素材本身不证明真正的跨会话调用或生产可用。

## English summary

The full suite mutates files, uses fixed /tmp names and starts subprocesses. Run it only in the documented disposable, non-root Linux container with a private tmpfs mounted at /tmp; TMPDIR alone is not isolation. The default runner refuses unsafe environments. Dependencies are fetched during image build, then tests/build/pack run offline. Optional Host SDK tests skip explicitly unless exact read-only fixtures are supplied. Synthetic UI images are presentation fixtures, not end-to-end, live-model, permission or production-installation evidence.
