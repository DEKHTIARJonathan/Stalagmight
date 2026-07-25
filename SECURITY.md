# Security Policy

## Supported versions

Stalagmight is pre-1.0 and under active development. Security fixes are made
against the **latest release** and the `master` branch. Older versions are not
maintained.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version/platform, and reproduction steps.

This routes the report privately to the maintainers. If private reporting is
unavailable to you, open a minimal public issue that says only that you have a
security report and asks for a private contact channel - **do not include
details** in that issue.

Please include, where possible:

- the affected version (and OS/platform),
- a clear description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

## What to expect

- We aim to **acknowledge** a report within a few days.
- We'll work with you on a fix and a coordinated disclosure timeline, and credit
  you in the release notes if you'd like.
- Please give us reasonable time to release a fix before any public disclosure.

## Scope

Stalagmight is a **desktop application** that processes local survey files. Its
attack surface is small and mostly local. Things especially worth reporting:

- **Malicious input files.** Parsing untrusted `.dmp` / `.tml` / `.mak` / `.dat`
  survey files that causes memory unsafety, a crash that loses or corrupts data,
  path traversal, or arbitrary file write/read outside the project.
- **Data-loss or data-corruption** paths in the save/import/undo pipelines.
- **Tile / network handling.** The map fetches satellite tiles and label fonts
  over the network; report any issue where a malicious response can compromise
  the app.
- **Telemetry.** Telemetry is **opt-in and off by default**, sends only
  anonymous aggregate counters (app version, OS, a random session id, event
  counts), and contains **no file paths, project names, survey data,
  coordinates, or user identity** (see [docs/telemetry.md](docs/telemetry.md)).
  Report anything that contradicts that.

Out of scope: issues that require an already-compromised machine, or social-
engineering of the user into running an untrusted build.

## A note on builds

Official releases may be unsigned/ad-hoc-signed depending on platform; verify
you obtained binaries from an official release. Building from source is always
supported (see [CONTRIBUTING.md](CONTRIBUTING.md)).
