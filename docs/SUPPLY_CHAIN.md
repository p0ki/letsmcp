# Phase 0 supply-chain controls

Review date: 2026-10-08. Changes belong to `security/phase-0-hardening`; upstream history and MIT notices are preserved. No deployment is part of this work.

## Dependency findings and changes

The original lockfile at `e9e8b2660a4fd534d66288e7bb053924d938c002` produced **22 npm audit findings: 5 moderate, 15 high and 2 critical**. Counts include vulnerable package entries and transitive propagation; they do not represent 22 proven remotely exploitable application bugs.

The baseline manifest requested MCP SDK `^1.0.4`, but its lockfile actually resolved **1.25.2**. The hardening branch pins `@modelcontextprotocol/sdk` to **1.32.1**, the current patched v1 package verified through the official npm registry during setup. This updates the compatible v1 release line rather than conflating it with the separately packaged v2 SDK. The SDK change accompanies application-level command/filesystem/network/session hardening; a dependency upgrade alone does not fix unsafe tool design.

Browser scraping and command execution were disabled. Unused `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth` and `node-fetch` dependencies were removed. URL retrieval now uses the constrained builtin HTTP(S) implementation documented in `TOOLS_SECURITY.md`; no browser download or stealth-plugin install is needed.

| Selected locked package | Baseline | Updated resolution |
|---|---:|---:|
| `@modelcontextprotocol/sdk` | 1.25.2 | 1.32.1 |
| Express (direct dependency) | 4.22.1 | 4.22.3 |
| Vitest | 4.0.17 | 4.1.11 |
| Vite (transitive test tooling) | 7.3.1 | 8.3.3 |
| PostCSS | 8.5.6 | 8.5.29 |

**Final local validation, 2026-10-08:** clean `npm ci --ignore-scripts` installed 235 packages and audited 236; explicit `npm audit --audit-level=low` reported **0 findings**. Under Node 24, all 138 isolated backend tests, typecheck and build passed. Both scanner regression tests passed, including detection of a secret present only in the staged index. Advisory results are time-bound evidence, not certification that packages are malware-free. Hosted CI/CodeQL execution is not yet verified.

## Installation and provenance

Baseline installation and CI use `npm ci --ignore-scripts`. No root preinstall/install/postinstall/prepare hook was found. Remaining lock metadata marks esbuild and optional fsevents as having install hooks; they are suppressed. Tests must use synthetic isolated state and mocked external providers; do not start a credentialed server to validate a dependency update.

Lockfile format is v3. Resolved package URLs use only `https://registry.npmjs.org/` and SHA-512 integrity; the scanner rejects other provenance or missing integrity. These checks detect drift, not malicious package authorship. CI uses Node 24; the manifest permits Node 24–26.

## CI and scanner pins

The author-target SSH deployment workflow was removed from this branch. Validation runs on `security/**`/main pushes and pull requests, using read-only contents permission and checkout credential persistence disabled. No `pull_request_target` execution of contributed code is configured.

| Component | Exact pin |
|---|---|
| `actions/checkout` v6 | `d23441a48e516b6c34aea4fa41551a30e30af803` |
| `actions/setup-node` v6 | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
| `github/codeql-action` v4 | `7999b86c43a865dc79d8923397f35af22de63401` |
| Gitleaks | 8.30.1 Linux x64 archive, SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` |

Pins were verified against official repositories/releases during setup. The scanner installer verifies the archive before extracting its binary. Gitleaks scans complete reachable history and a snapshot of tracked/non-ignored source with full redaction; output contains only rule/path/line/commit metadata. Scanner tests require rejection of synthetic secrets and unsafe configuration. Private runtime files, unsupported lockfile provenance, unpinned Actions and deployment workflows also fail security checks. CodeQL uses extended JavaScript/TypeScript queries and gets `security-events: write` only in the analysis job. Dependency audit fails for every advisory severity.

Dependabot requests weekly npm/Actions updates against the hardening branch, without automatic merging. Repository-level Actions enablement, CodeQL availability, Dependabot/security alert settings, secret push protection and required-check branch rules require separate owner verification; committed workflows alone do not enable every GitHub feature. Hosted CodeQL results are not equivalent to local typecheck/build/tests.
