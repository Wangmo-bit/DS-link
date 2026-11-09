# Known limits and troubleshooting

[简体中文](known-issues.md) · [Installation](installation.en.md) · [Home](../README.md)

- **Full bubble flow / Agent hints missing:** the stock Host lacks the optional composition seam. Check the compatibility matrix; never force-patch an unknown bundle. Card mode is available without the bridge; node-level bubble fallback is not full support.
- **Host upgrade changes the UI:** upgrades may replace the bridge. Re-check the exact version and bytes; do not automatically reinstall an old bridge.
- **No quote icon on my own message:** the added action uses the assistant action slot. Select user text and use the Host's quote action instead.
- **Only the start of a long reply was quoted:** quotes over 1,200 code points use a marked opening excerpt. Select a later passage explicitly when needed.
- **Markdown in the preview:** source text preserves formatting markers; the preview is not promised to be rich text.
- **Agent reuse not counted:** name-only reuse or automatic resumes may lack persistent identity evidence. Grey means uncertain, not necessarily failed.
- **Busy target:** delivery waits for a step boundary and does not interrupt the active tool batch; no maximum busy-time latency is promised.
- **Unknown / timeout:** unknown is never automatically resent; timeout does not cancel work. Verify before acting.
- **Paused chain without a resume button:** per-chain pause/resume/close UI is not implemented; use existing qualified tools/owner controls, not the global pause switch.
- **User-row plugin decorations missing:** rc.1 child-slot adaptation can suppress before decorations. Test combinations such as LiveShare separately.
- **Stale receipts:** observer failures may stop real-time evidence. Queued does not mean read; preserve the record and report the issue.
- **Scrolling / browser differences:** older scroll protection is not fully ported to rc.1. The bridge uses CSS @scope; Chromium is the primary verified browser path.
- **Rollback:** package/config backups are materials, not proof that a newer ledger and pending queue can safely be downgraded.

## Report installation trouble

Include plugin, DSH and Node versions; OS/browser; display mode; whether the separate bridge was installed; minimal steps; and redacted logs. Use the [installation template](https://github.com/Wangmo-bit/DS-link/issues/new?template=install.yml). Never include login URLs, tokens, private conversations or full config files.

Do not hide an issue with repeated resends or manual edits to installed files. Model-provider and tool-execution delays are not plugin delivery latency.
