# Contributing

[简体中文](CONTRIBUTING.md) · [Project home](README.md)

Issues with real use cases, bug reports and improvement ideas are welcome, and so are pull requests once the direction has been discussed. This repository is a **private pre-release**; whether and when it becomes public is the owner's decision.

## Open an issue before a large PR

- **Bugs, install failures and feature ideas**: use the matching issue template. Describe the real scenario, what you expected and what actually happened. Chinese or English is fine.
- **External pull requests are welcome**, but please open an issue first to explain the problem and the intended direction. For a larger change, wait until the direction is agreed so you do not spend time on something that has to be reworked.
- We do **not auto-close a PR just because its author is external**, and there is no mandatory allowlist, automatic admission list or extra gate. A maintainer may ask you to narrow the scope, add tests or split the change.
- Small fixes such as typos or broken links can go straight to a PR without an issue.
- Changes to the protocol, ledger/data format, permissions, installation flow or either display mode should be discussed in an issue first. Do not add gates, allowlists, permissions or long-lived mechanisms on your own.

## Filing an issue

- One issue, one problem. For a bug, include the plugin version, Host / Node / OS / browser and display mode (bubble or card), plus minimal reproduction steps.
- For install failures, use the "Install issue" template and include the install method and the error text (redacted).
- **Do not submit real conversation content, real user data, credentials, API keys, tokens, cookies, private keys, signed private links or unredacted logs.** Reproduce with synthetic content; redact session names, accounts and personal paths from screenshots.
- Do not open a public issue for a security problem. Use the private route described in [SECURITY.en.md](SECURITY.en.md).

## Development setup

Public-candidate development and testing happen in the source repository. A plugin installed from a `.tgz` does not contain `test/` or `scripts/`, so these development commands cannot run there.

- Node.js 24 (tested with v24.21.0).
- DSH `0.2.1-rc.5` or `0.2.2-rc.1`; Linux Web is tested. Other Host/Node versions and platforms are unverified — do not assume they work.
- From the source repository:

  ```bash
  npm ci
  npm test
  npm run build
  npm pack --dry-run
  ```

`npm test` includes Host integration cases that are skipped when the corresponding client-bundle environment variable is absent. **A skip is not a pass**; report them separately.

## Test isolation (important)

The test suite is not side-effect-free: some cases spawn child processes or recursively remove temporary directories, and a group of cases uses **fixed `/tmp/dsh-session-link-*` paths**.

- Run fixed-`/tmp` cases only inside an **independent mount namespace or a container with its own `/tmp`**, after confirming that `/tmp` is not mapped to the real host path.
- `TMPDIR` alone is not enough: a fixed literal path does not follow `TMPDIR`.
- Do not run the suite blindly on a shared `/tmp`, and do not delete or probe unknown pre-existing temporary files.
- A container runs as root by default, which defeats tests that inject write failures with `chmod`. Run as a non-root user, as CI does.

See [TESTING.md](TESTING.md) for the full preconditions, side effects and known gaps.

## Scope and verification

- One PR should solve one reviewable problem. Say what the old behavior was, why it needs to change and what the new behavior is. Avoid unrelated renames, formatting or directory moves.
- **Verify according to the change surface**: run the focused regression first, then widen only as the evidence requires. A green full suite does not replace acceptance on the relevant real path.
- Add tests for behavior changes. For copy or layout-only changes, provide a check result or a screenshot built from synthetic data.
- Check **the other display mode** and shared functionality too: a bubble-mode change must not regress card mode, and vice versa.
- For protocol, ledger/data format, configuration or installation changes, describe compatibility impact and migration. Cross-version ledger/rollback compatibility is currently **unverified**; do not present it as guaranteed.
- Run `npm run build` after changing source. Do not hand-edit generated files in `dist/`.
- Keep user-facing copy in sync across the existing Chinese/English structure, and update both language versions of the docs when behavior, compatibility or security facts change.
- Do not bring real conversations, credentials, personal paths or private operational material into code, fixtures, logs or commits. Use synthetic test data.
- The Host-side private bridge is separate from plugin installation. It is not part of the plugin `.tgz` and is a separately authorized, controlled maintenance action. Do not bundle it into the plugin or assume it grants permission to install or restart anything.

## AI-assisted contributions

AI assistance is allowed, but the submitter must still read and understand the change, run it, and take responsibility for the result. It is helpful to mention in the PR which parts used AI assistance; this is not an extra admission condition.

## Third-party content and licensing

- Project-owned code and documentation use the **MIT License** (see [LICENSE](LICENSE)). By submitting, you confirm you have the right to contribute the content and agree to provide it under the project's MIT license; existing licensing does not change.
- Before referencing or porting third-party code, assets, fonts or icons, check that the license is compatible, and preserve the source, version or commit, modifications and required notices. Do not copy AGPL code or artwork; implement from the design yourself.
- Third-party dependencies and assets keep their own licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); this project's MIT license does not relicense them.

## Submitting a PR

Use the default PR template and state:

1. the problem and the change;
2. the **verification you actually ran** and its result;
3. what was **not verified or skipped**, and why;
4. compatibility impact and whether the other display mode was checked.

Review the diff before submitting: no credentials, real conversations, personal configuration, build caches or unrelated files.
