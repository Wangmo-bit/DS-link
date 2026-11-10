# Reporting security issues

[简体中文](SECURITY.md)

Do not post exploit details, keys, private keys, real conversation content, real user data or complete diagnostic archives in public issues, comments or pull requests.

## Current status and reporting channel

Release 0.8.18 is public. GitHub private vulnerability reporting can **only be enabled after the repository becomes public**: while the repository is still private, the advisory endpoint returns 404. The `SECURITY.md` file itself does not enable this feature.

**Before the repository becomes public:** contact the project owner privately through the private collaboration channel you already have, or through another private channel the owner designates. Do not describe the vulnerability or post exploit details in a public issue.

**After the repository becomes public (owner action):** the owner must enable GitHub private vulnerability reporting immediately and open the [Security Advisories](https://github.com/Wangmo-bit/DS-link/security/advisories) page to verify that the **Report a vulnerability** entry works. Only after that verification may the entry be described as the project's reporting channel.

**After the repository is public (reporters):** if the Security Advisories page shows **Report a vulnerability**, use it to submit a private report. If the entry is unavailable, open an issue that **only asks how to contact the maintainer privately**, then wait for a private contact route. Do not describe the vulnerability, attach reproduction data or identify an affected deployment in that issue.

## What to include

- Plugin version (the installed `.tgz` version or the version shown in settings); for source-level reports, include the commit.
- DSH version, Node version, operating system and browser; mention bubble or card mode when relevant.
- Impact, preconditions and minimal reproduction steps.
- Reproduction material built from fictional content, test accounts or synthetic fixtures, plus only the necessary redacted logs.
- What you verified and what you did not; include results from other versions if you checked them.

Real API keys, tokens, cookies, private keys, real conversation content, signed private links and complete personal diagnostic archives are not required. If your own credentials have been exposed, revoke or replace them with the relevant service first.

## Scope

This repository contains a local session-collaboration plugin for DSH, plus version-pinned Host bridge tools that are not distributed in the plugin package. Reports may cover credential exposure, unauthorized access, approval or authorization bypasses, treating conversation text as user authorization, misleading message states, and similar issues.

The plugin works through the Host's owner-only authenticated interfaces. Receiving a message does not grant a session extra permissions, and the plugin does not bypass the Host's owner authentication. The bridge tools are not shipped in the plugin `.tgz`; installing, restarting or rolling back still requires separate authorization. Reporting a security issue does not grant permission for those operations.

Reproduce issues only with **your own environment, accounts and data**, or in an environment where you have explicit authorization. Do not access other people's sessions or content, perform destructive actions or disrupt live services to validate a report. This policy does not authorize testing any third-party service.

Model behavior, provider latency, the DSH Host itself and third-party services are outside this plugin's scope. If you are unsure whether a problem involves the plugin/Host seam, describe it privately first so its ownership can be determined.

## Supported versions

Security fixes are promised only for the latest tagged release; earlier versions are not covered. See [README.md](README.md) for the DSH/Node compatibility range.

## Handling and disclosure

Use the private channel to discuss reproduction, impact and fix validation, then coordinate public disclosure with the owner. Identify affected versions in the report. This policy makes no fixed response-time, repair-deadline, bounty or long-term old-version support commitment.
