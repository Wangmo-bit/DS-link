# 0.8.20 — 会话切回时胶囊即时显示 / Instant capsules on return

Public release, published to npm and GitHub together. No protocol, ledger-format, permission or Host-bridge changes are included.

公开正式版，npm 与 GitHub Release 同步发布。本次不改协议、账本格式、权限或 Host 桥接。

## 修复内容 / Fixes

- 气泡模式收到/已发胶囊不再在每次会话切换时重新等待 `card_lookup` 身份查询。已经核实过的持久消息身份会按会话保留；切回会话时先立即画出胶囊，再后台刷新最新状态。
- 切回时重新绑定新窗口的事件对象并立即重新注册卡片定义；状态刷新、分组更新和回复状态仍在后台进行。
- 会话被删除、插件卸载或显式销毁时才清掉身份缓存；普通切走/切回不再清空。
- 仍未核实、身份不符或共享窗口冲突的消息继续退回原生显示，不猜测、不冒充。
- 卡片模式、分组规则、审批/提问、附件、复制和协议均不变。

- Bubble-mode received/sent capsules no longer wait for a fresh `card_lookup` identity round trip on every session switch. Verified durable-message identity is retained per session; returning to a session paints capsules immediately and refreshes status in the background.
- A returning window is rebound to its event objects and the card definition is republished immediately; status, grouping and reply facts still refresh asynchronously.
- Identity is cleared only on session deletion, plugin disposal or explicit teardown, not on ordinary switch-away/switch-back.
- Unverified, identity-mismatched or fork-shared events still fall back to native rendering; nothing is guessed or spoofed.
- Card mode, grouping rules, approvals/questions, attachments, copy and the protocol are unchanged.

## 验证 / Validation

- Full test suite in a disposable non-root Linux container with a private `/tmp` tmpfs, read-only root and no network: 525 passed, 0 failed, 0 skipped.
- New regression: at the pre-fix baseline, a replacement eventSource generation cannot claim an already-verified capsule immediately (fails); after the fix it can.
- Installed-preview browser check: returning to a session shows capsules with the native conversation instead of a blank verification pause; card mode remains per-message.
- The npm package and GitHub release should be installed through the official plugin entry; this release does not restart Host or apply the optional Host bridge.

## 升级 / Upgrade

Existing 0.8.19 installations can upgrade with the normal plugin entry. No data migration is required. A Host restart is needed for the new client bundle to load when the package changes; the install command itself does not restart the Host.

已有 0.8.19 可按正常插件入口升级，不需要数据迁移。安装包变化后需要重启 Host 才能加载新的客户端 bundle；安装命令本身不会重启 Host。
