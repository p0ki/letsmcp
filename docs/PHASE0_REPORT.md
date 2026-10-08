# Phase 0 security-hardening report

Validation date: 2026-10-08. Branch: `security/phase-0-hardening` in both forks. This is a local, single-owner, Linux security baseline for synthetic data. No deployment, merge into main, real CV/LinkedIn data, provider credentials, OAuth authorization or paid inference was performed.

## Reproducible baseline and repository identity

| Repository | Fork | Preserved upstream baseline | Baseline inventory |
|---|---|---|---|
| JobOS | https://github.com/p0ki/JobOS | `7c70a863cca89c3dd619ff9bdd6ee8d4ebc3f41a` | 80 tracked files, 44 reachable commits |
| letsmcp | https://github.com/p0ki/letsmcp | `e9e8b2660a4fd534d66288e7bb053924d938c002` | 39 tracked files, 33 reachable commits |

GitHub fork parent identity was rechecked on the validation date. The two remotes retain the original repositories as upstream. Hardening appends commits without rewriting history; main remains at its baseline. Exact delivered commit identities and hosted CI results are recorded separately in the delivery summary because a commit cannot embed its own SHA. Existing MIT attribution is preserved.

[Baseline audit](BASELINE_AUDIT.md) inventories source and findings. [Independent runtime review](INDEPENDENT_REVIEW.md) records the follow-up review and its limits. [Supply-chain controls](SUPPLY_CHAIN.md) records pinned resolutions and provenance.

## Audit scope and malware conclusion

Every tracked baseline path was inventoried. First-party executable source, handlers, persistence, providers, configuration and tests were inspected directly and through complete-tree security-pattern searches. Documentation, lock metadata, Actions and reachable commit summaries were inspected. The current public extension ZIP was safely unpacked and all five original text source files inspected.

No confirmed obfuscated loader, covert persistence or hidden first-party backdoor was identified in that inspected source. Unsafe command execution, weak authorization and extension uploads were openly implemented. The author-backend upload is an unacceptable destination regardless of intent. This is not a malware-free certification: dependency tarball contents, every historical retired ZIP, every runtime path and hostile same-UID processes were not exhaustively assessed. Known upstream vulnerabilities remain visible in preserved Git history.

## Finding-to-change map

| Baseline finding | Implemented control | Evidence / remaining boundary |
|---|---|---|
| B01 arbitrary command execution | `executeCommand` removed from tool advertisement and explicitly denied, no spawn handler. | Tool tests and actual MCP SDK dispatch test; stdio remains trusted local launch. |
| B02 unrestricted reads/search | Explicit owned private safe directory, bounded regular-file operations and literal search. | `filesystem.ts`, tool traversal/search tests. |
| B03 prefix/symlink/race write escape | Canonical root policy, descriptor-anchored no-follow opens, target checks and atomic complete-file publication. | Symlink, ancestor, hardlink, FIFO, publication-race and concurrent-read tests. |
| B04 no backend auth | Opaque server-issued cookie sessions before all business routes; no default passphrase. | Mounted API negative/positive, expiry, rotation and restart tests. |
| B05 forged browser identity | Unsigned Google JWT/localStorage auth replaced by verified backend session. | AuthContext tests; future OAuth identity verification remains separate. |
| B06 SSRF | Public-only address classification, all DNS answers checked, connection IP pinned, every redirect revalidated, bounded bodies/deadlines. | 40 network tests plus API/MCP private-target denial. |
| B07 unsafe browser scraper | Browser tool and HTTP scraper disabled; browser/stealth dependencies removed. | Legacy invocation denies; authenticated HTTP route returns 410. |
| B08 permissive CORS | Exact configured Origin, mutation CSRF checks, cross-site rejection, Host allowlist and loopback listener. | API Origin/Host/cookie tests; CORS is not treated as authentication. |
| B09 untrusted HTML/XSS | Both HTML sinks removed, inert text rendering and safe external URL validation. | Malicious HTML/AI text and URL tests. |
| B10 browser AI secrets | Direct browser Gemini provider removed; legacy keys/custom backend URL stripped on settings read/write/import/export. | Migration/security tests; no user credentials were supplied. |
| B11 runtime provider reconfiguration | Config endpoint always forbidden; environment-only provider configuration. | API 403 and AI runtime-mutation tests. |
| B12 private logs/provider fallback | Generic errors, no raw prompt/response logs, selected provider only, AI off by default, key headers/fixed endpoints. | 37 mocked AI tests; no real inference. |
| B13 unsafe shared persistence | Backend state restricted to sandbox and atomic writes; queue mutations serialized. | Synthetic jobs/resume/profile and atomic-write tests. Multi-user database isolation and retention are deferred. |
| B14 resource exhaustion | Input/response/deadline/search limits, login throttle, request rate and active-work bounds, disconnect-safe accounting. | API/limiter/network tests. |
| B15 author deployment/network targets | Author IP/nip.io/runtime backend references removed, deployment workflow/manifests retired, listeners loopback only. | Source review and workflow policy checks; baseline main/history not rewritten. |
| B16 vulnerable supply chain/mutable Actions | SDK pinned 1.32.1, vulnerable resolutions updated, targeted DOCX override, Actions pinned by SHA, audit/Gitleaks/CodeQL CI. | Clean installs, audit zero, provenance scan and compatibility test. Hosted activation is a separate delivery observation. |

## Resulting architecture

```text
Browser UI --same-origin /api, HttpOnly cookie--> loopback HTTP API
  |                                               |
  | inert imported/AI text                        | verified local-owner session
  | no provider keys                              | exact Origin/Host, work limits
  | synthetic localStorage                        | sandboxed atomic local state
                                                  | public-only DNS-pinned fetch
                                                  | AI disabled unless explicit opt-in
Trusted local MCP client --stdio--> reduced tools -+
Extension --explicit Preview--> local JSON download (no backend/network upload)
```

The backend owns identity; browser storage is not an authorization boundary. The local bootstrap bridge issues 256-bit opaque sessions, stores their digest with eight-hour expiry and rotates/revokes them. HTTP is permitted only for the intended loopback setup; HTTPS uses Secure cookies. A later verified Sign in with ChatGPT flow may issue equivalent sessions after successful OAuth/PKCE and identity verification. It is not implemented or entitlement-tested by this branch.

`SAFE_DATA_DIR` must be a new dedicated private owned directory outside generic/system/credential roots. Linux descriptor anchoring, no-follow traversal, regular-file constraints and atomic publication fail closed. An unrelated hostile process with the same OS account is outside this containment promise. Browser localStorage and local files remain unsuitable for real personal data or multiple users until storage/retention/isolation are designed and approved.

## Extension audit and artifact

The original archive contained five UTF-8 source files, 23,482 extracted bytes. Its plaintext job/profile uploads went to the author's hardcoded HTTP server; it had excessive persistent access and weak message checks. No obfuscated/eval/remote-JS or credential-cookie API behavior was found in those files.

| Archive | SHA-256 |
|---|---|
| Original upstream | `71646fa13922bd4cf08438562d1414cf70bf45ed52126bd6fbe0be3cc5fbece1` |
| Reviewed deterministic replacement | `6573d7442f5d7409f3ce02a4ac65085004d41f93268dfee391b874e7a869f0ba` |

New source is reviewable in JobOS `extension/LinkedInJobOS/`. Only activeTab/scripting permissions remain; no background/content auto-execution, host/network/storage permissions or direct upload. CSP denies connections. The user explicitly previews a bounded plain-text job from an exact HTTPS LinkedIn numeric job URL, then separately downloads a local JSON. Profile capture and backend pairing are disabled. Packaging rejects unexpected entries and checks byte-for-byte source/ZIP parity.

All seven extension tests and parity checks passed. These use synthetic DOM/Chrome API fixtures; actual Chrome installation and current live LinkedIn selectors remain unverified. Existing installed old extensions were not revoked.

## Validation actually completed

Checks use synthetic data. Fresh install commands suppress lifecycle scripts and use the final lockfiles. Installs ran under the supported host Node 26/npm 11; executable checks below used the checksum-verified official Node 24.21.0 LTS runtime used by the CI major line. MCP SDK 1.32.1 was reconfirmed as the registry's current release on this date.

| Check | Result |
|---|---|
| JobOS `npm ci --ignore-scripts` | 289 installed, 290 audited; passed |
| letsmcp `npm ci --ignore-scripts` | 235 installed, 236 audited; passed |
| Both `npm audit --audit-level=low` | 0 vulnerabilities |
| JobOS Vitest | 81 tests / 10 files passed |
| JobOS ESLint | Passed |
| JobOS TypeScript build and Vite build | Passed; existing large bundle warning remains |
| Real synthetic DOCX extraction + Mammoth CLI/argparse compatibility | 2 tests passed; no parser mocks |
| Extension security tests | 7 passed |
| Deterministic ZIP/source parity | Passed |
| letsmcp Vitest | 138 tests / 6 files passed |
| letsmcp TypeScript noEmit + build | Passed |
| Both scanner regressions | 2 per repository passed, including staged-only secret + redaction |
| Gitleaks scopes | 0 detected findings in reachable history, immutable staged-index blobs and working source snapshots; no suppressions |

The backend suite comprises 42 tool/filesystem, 40 network, 37 AI, 16 API/session, two active-work limiter and one actual MCP SDK integration tests. Independent review resolved R1 sensitive root configuration, R2 disconnect/concurrency accounting, R3 erase-on-failed-delete and R4 partial-file persistence. The reviewer inspected tests; execution counts above belong to the owner.

The CLI/scanner child-output checks and HTTP tests needed authorized host execution because this sandbox suppresses child output/restricts sockets. Test passes are not inferred from the earlier sandbox failures. No production environment file was loaded for integration tests.

## Browser evidence and current limitation

On 2026-10-07, the real supported browser verified unavailable/wrong/correct login, verified session reload, logout, settings without key fields, keyboard login and extension guidance at desktop and 390x844. A mobile clipping issue was fixed and rechecked; screenshots are retained as local synthetic evidence outside the published repository.

On 2026-10-08, the final post-update browser rerun could not proceed: `cua.getTab` for `http://127.0.0.1:8080/` was rejected by browser security policy as an unsupported URL/protocol, despite listing HTTP/HTTPS as allowed. No alternative surface, indirect navigation or policy workaround was attempted. Current frontend tests/build passed; today's visual/browser rerun is explicitly unverified, not reported as a pass. This limitation does not authorize deployment or real-data use.

## Scanning and hosted settings

Both CI configurations use immutable official Actions SHAs, restricted permissions, no checkout credential persistence, no deployment workflow and no `pull_request_target` execution. Gitleaks 8.30.1 is SHA-256 verified before extraction; no scan suppressions were added. The scanner scans immutable index blobs separately so a clean working file cannot hide a staged secret. Negative tests construct invalid synthetic token-like fixtures only in temporary repositories and check that output never exposes values.

CodeQL security-extended configuration is committed, not proof of a completed hosted analysis. Dependabot's branch-target settings may not activate until GitHub reads approved configuration from the default branch; main was intentionally not changed. Private vulnerability reporting, push protection, branch protections and global GitHub security settings were not modified. Delivery reports actual run links/status or concrete activation blockers; no disabled check is described as a success.

## Remaining gates

- Keep the implementation on the hardening branches; no automatic merge or deployment.
- Resolve/report any hosted CI or CodeQL activation/upload limitation from actual remote observations.
- Re-run affected browser flows when authorized browser access is available; actual Chrome/LinkedIn extension QA remains pending.
- Implement verified ChatGPT OAuth and verify actual plan entitlement in a separately authorized phase; never copy subscription/Codex credentials into the project.
- Design database/user isolation, retention and recovery before introducing real CV or LinkedIn data.
- Scope optional safe extension pairing before re-enabling direct import.
- Audit evidence and automated checks reduce specific risks; they do not prove absence of all malware or vulnerabilities.
