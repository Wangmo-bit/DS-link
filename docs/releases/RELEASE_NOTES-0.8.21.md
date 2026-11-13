# 0.8.21 — 切回会话与原生同屏 / Capsules painted with the first render

Public release, published to npm and GitHub together. No protocol, ledger-format, permission or Host-bridge changes are included.

公开正式版，npm 与 GitHub Release 同步发布。本次不改协议、账本格式、权限或 Host 桥接。

## 改进内容 / Improvements

- 切回已经访问过的会话时，不再重建卡片定义；复用已注册定义并只补充新窗口的事件归属。
- 新窗口事件在首屏渲染前就绑定到会话，`match` 可以直接认领已核实胶囊，不再等首帧之后补映射。
- 切走时保留分组快照；切回来不会先散成单条再重新合并，后台扫描再校正。
- 已核实身份、未核实回退原生、身份不符/共享窗口冲突等安全边界保持原样。

- Returning to a previously visited session no longer rebuilds the card Definition; the registered Definition is reused and only the new window's event ownership is refreshed.
- New-window events are bound to their session before the first paint, so `match` can claim already-verified capsules without waiting for a post-render mapping pass.
- Grouping snapshots survive switch-away/switch-back, avoiding a single-to-grouped flash; the background scan still corrects them.
- Verified identity, unverified native fallback and identity-mismatch/fork-shared safeguards are unchanged.

## 验证 / Validation

- Full test suite in a disposable non-root Linux container with a private `/tmp` tmpfs, read-only root and no network: 526 passed, 0 failed, 0 skipped.
- New regressions cover: no Definition rebuild on cached return; group snapshot retained across a generation swap.
- Installed-preview switching measurement: first return native 915ms / capsule 929ms; second return native 327ms / capsule 302ms. Capsules now paint with the same render instead of trailing by 100–300ms.
- Card mode remains per-message; approvals, questions, attachments and copy are untouched.
- The npm package and GitHub release must be installed through the official plugin entry; this release does not restart Host or apply the optional Host bridge.

## 升级 / Upgrade

Existing 0.8.20 installations can upgrade with the normal plugin entry. No data migration is required. A Host restart may be needed for the new client bundle to load after an install; the install command itself does not restart the Host.

已有 0.8.20 可按正常插件入口升级，不需要数据迁移。安装后可能需要重启 Host 才能加载新的客户端 bundle；安装命令本身不会重启 Host。
