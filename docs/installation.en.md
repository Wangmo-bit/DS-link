# Installation, compatibility and upgrades

[简体中文](installation.md) · [Home](../README.md) · [First use](quickstart.en.md) · [Known issues](known-issues.en.md)

## What exists

- Public install paths: the **npm package `@wangmo-bit/ds-link`**, the `.tgz` attached to the GitHub release, or a source build.
- Install through DSH's official `dsh plugin` entry point. This repository does not auto-install, auto-patch the Host or auto-restart anything.
- Installing the plugin is not the same as applying the optional Host bridge; the bridge is a separate maintenance action, described below.

## Install from npm

Back up the target profile first; use an isolated profile for the first try:

```sh
dsh plugin --profile <your-profile> add @wangmo-bit/ds-link@0.8.18
```

You can also download `wangmo-bit-ds-link-0.8.18.tgz` from the [GitHub release](https://github.com/Wangmo-bit/DS-link/releases/tag/v0.8.18) and install that file through the same `dsh plugin ... add <path>` entry.

## Compatibility

| Item | Current statement |
| --- | --- |
| Communication layer | Historically supported DSH `0.2.1-rc.5` / `0.2.2-rc.1` |
| Full UI evidence | Historical daily-use validation: DSH `0.2.2-rc.1` plus exact bridge; this batch separately tests offline components and isolated SDK fixtures, without starting another DSH service |
| Node.js | 24 (tested v24.21.0) |
| Platform / browser | Linux Web; Chromium is the primary verified path |
| Card mode | Plugin only; no Host bridge required |
| Full bubble mode | Requires the optional Host bridge; without it you only get the older node-level fallback, not the full experience |

“Communication layer supported” means the message protocol was historically exercised on those Host versions; it does not mean the full bubble UI is verified on `rc.5`. macOS, Windows, the desktop app, other browsers and other DSH/Node versions are not promised as fully supported. Start small, with synthetic content, and verify in your own environment.

## Build and install from source

Before starting:

- Prepare Node.js 24 and a working DSH installation.
- **Use an isolated test profile** for the first install; do not experiment in a daily-use or production profile. Back up that profile's `package.json`, `pnpm-lock.yaml` and `cordis.patch.yml` first.
- The source build uses `npm`; no npm registry login is needed. `npm ci` installs development dependencies for build/test only. It does not install the plugin or modify a DSH profile or Host file.

```sh
git clone https://github.com/Wangmo-bit/DS-link.git
cd DS-link
npm ci
npm run build
mkdir -p output
npm pack --pack-destination ./output
VERSION=$(node -p "require('./package.json').version")
TGZ="$(pwd)/output/wangmo-bit-ds-link-${VERSION}.tgz"
dsh plugin --profile sl-test add "$TGZ"
```

Notes:

- Read the tarball name and version from `package.json`; do not hand-write an old version. Replace `sl-test` with your own isolated profile name.
- Never put access credentials in commands, scripts or commits.
- Different DSH versions may need extra `dsh plugin` arguments; follow that version's actual help. **Do not hand-copy files into an installed package.**
- After installing, check the **actually loaded plugin and client**, not just the version on disk. Client-only changes may appear after a browser refresh; Host-side or configuration changes may require a separately authorized DSH restart. Neither this guide nor the install command restarts anything automatically.

## Display modes and the optional Host bridge

Card mode uses the native Host path and **does not need** the bridge. Full bubble flow, per-turn stats and Agent hints need the Host's `conversation.chat.flow.adapter` seam. Stock DSH `0.2.2-rc.1` does not provide that seam; this repository ships a **source-only optional maintenance tool**, not part of plugin installation.

- The bridge tool is not distributed in the tgz and is never run by plugin install hooks.
- Without the bridge the plugin still works: card mode is fine, and bubble mode falls back to the older node-level skin. Message bodies may still render, but do not treat the full layout, stats or Agent hints shown in the demo as available.
- If you do not need full bubble mode, do not run the bridge tool.

### Check only (default; no writes)

```sh
node scripts/install-host-flow-bridge-rc1.mjs --dsh-root /absolute/dsh-prefix
node scripts/install-host-flow-bridge-rc1.mjs --dsh-root /absolute/dsh-prefix --check
```

`--dsh-root` is the DSH installation prefix and must be a canonical, non-symlinked absolute path. The tool looks for the target under that prefix at `lib/node_modules/@deepseek-ai/`. The default is a read-only check; it does not write the Host. A successful check reports `ready` or `already-installed`. If the version, hashes, file size, owner, permissions or symlink status do not match, it stops instead of forcing a patch.

### Apply (needs separate authorization)

```sh
node scripts/install-host-flow-bridge-rc1.mjs \
  --dsh-root /absolute/dsh-prefix \
  --apply --backup-dir /absolute/private-backups
```

`--apply` modifies a Host client file and **requires separate owner/maintainer authorization**. It is not “installing the plugin” and not a casual repair. Before running it:

- The backup directory must already exist, belong to the current user and have `0700` permissions. The tool creates private candidate, backup and receipt files inside it; it never overwrites somebody else's directory.
- The Host target file and its parent directory must belong to the current user and must not be writable by group or others. The tool refuses to bypass ownership with `sudo`.
- The tool is Linux-only. It re-checks the exact `0.2.2-rc.1` Host version, `@deepseek-ai/dsh` / `dsh-client-ui-chat` package identities, pinned hashes, file sizes, owner, non-symlink status and generator hash before and after applying. Any mismatch stops the operation.
- This is a **separate Host maintenance action**, not official plugin installation. It does not modify the profile, ledger, service or restart anything. Results carry `restarted: false` and a backup receipt.
- A Host upgrade may overwrite the bridge. Re-check the exact version and hashes after upgrading. If they do not match, stop; do not automatically reinstall an old bridge or reuse old hashes.

### Bridge rollback

The tool keeps `client.js.original`, the candidate and receipts in the private backup directory. Rollback is a separate controlled operation: verify the backup's version, hashes, owner and target, then restore from the actual files. There is no automatic rollback, and never overwrite the Host from an unknown backup.

## Renaming an existing installation

The external names are **DS-link**, **`Wangmo-bit/DS-link`** and **`@wangmo-bit/ds-link`**. The legacy `@wangmo/dsh-session-link` package is the same product, not a second edition to run beside it.

- Back up the profile, previous tarball and installation; rehearse in an isolated profile first.
- Use the official plugin manager to disable the old bundle, then install/enable the new one. Never activate both copies of the same service, tools or client slots. Verify before removing the old dependency, and retain its tarball; never delete the ledger or restore a whole stale profile.
- The `session_link_*` tools, `/api/session-link/api`, `session-link` service/panel, `state/dsh-session-link` and browser preference keys stay compatible. No second empty ledger is created.
- A repository rename is not publication. The package remains a private candidate; refresh/restart requirements follow the actual official-manager result and owner authorization, not an automatic server restart.

## Upgrading and rolling back

- Upgrade the plugin through DSH's official plugin entry point and back up the target profile first. Do not hand-edit the installed package.
- Keep the previous `.tgz` as a **code rollback candidate**, but that does not prove a newer ledger, pending-delivery queue and migration state can be safely downgraded. Cross-version compatibility is currently **unverified**. Back up the profile and records before rolling back, and do not rehearse on a production profile.
- Plugin rollback and bridge rollback are separate. Do not use a plugin rollback to overwrite Host files, or a bridge backup to change plugin packages.

## When installation fails

- Registry package not found or the network fails: check the package name and version against the official registry; do not install from a guessed URL.
- Wrong `npm pack` filename: use `VERSION=$(node -p ...)` above to read it from `package.json`; do not type an old version from memory.
- Plugin installed but full bubbles are incomplete: first check whether you actually need the bridge, then read [known issues](known-issues.en.md). Never force-patch an unknown version.
- When reporting a problem, include the plugin, DSH and Node versions, OS/browser, display mode, whether the bridge was installed, and minimal steps. Redact logs; never include tokens, cookies, private keys, real conversations or a full profile.

Development and tests happen in the source repository; the `.tgz` does not contain `test/` or `scripts/`. Tests must run as a **non-root user in a disposable container with its own `/tmp` tmpfs**, not directly on a host's shared `/tmp`. See [TESTING.md](../TESTING.md) for the exact preconditions. `npm ci` installs development dependencies only; never point tests or install scripts at a real profile.
