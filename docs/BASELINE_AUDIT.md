# Phase 0 independent baseline security audit

Date: 2026-10-07 (Europe/Ljubljana). This report describes the upstream baselines, not the concurrent hardening working trees.

| Repository | Upstream baseline | Tracked files | Reachable commits |
|---|---|---:|---:|
| JobOS | `7c70a863cca89c3dd619ff9bdd6ee8d4ebc3f41a` | 80 | 44 |
| letsmcp | `e9e8b2660a4fd534d66288e7bb053924d938c002` | 39 | 33 |

## Method and scope

Read-only audit of exact `git show <baseline>:<path>` content, with isolated source copies under `/tmp/poki-phase0-baseline-audit`. Every tracked file was inventoried. First-party executable source, domain logic, storage, auth, providers, routes, MCP handlers, test/startup/build/deploy configuration and relevant UI handlers were inspected using direct source reads and complete-tree security-pattern scans. UI markup and CSS were scanned for external resources, script/HTML sinks, links and event handlers. Documentation was inspected for security claims, architecture, endpoints, install/startup/deploy commands and user-specific references. This is a focused static security review, not a formal verification of every UI branch or a certification that software is malware-free.

No repository code, tests, servers, npm lifecycle scripts or live AI calls were run by this audit. No deployment, external account action or real user data access occurred. The independent extension specialist owns unpacking and inspection of `public/LinkedInJobOS.zip`; this report inventories/hashes that archive but deliberately does not duplicate the extension verdict. Source copies were read from baseline Git objects so concurrent edits cannot contaminate conclusions.

No obfuscated dynamic-code loader, hidden scheduled persistence, unexplained first-party binary executable, covert telemetry or undeclared outbound credential upload was identified in the inspected first-party source. Command execution and network/file exposure are openly implemented/documented unsafe capabilities. That is evidence of severe security weaknesses, not evidence establishing malicious author intent. The extension's author backend is an unacceptable data destination even if originally intended as the author's deployment.

## Baseline findings

Line references in this section belong to the exact baselines above. Severity reflects exposure and potential impact; these are static findings, not live exploitation results.

| ID | Severity | Evidence | Consequence and Phase 0 requirement |
|---|---|---|---|
| B01 | Critical capability | letsmcp `src/tools.ts:756-828`, especially `775-778`; tool advertised at `266-297` | `executeCommand` spawns an arbitrary binary with arbitrary arguments and cwd, inheriting process credentials/environment. An MCP client or prompt injection can execute shells, read secrets or change files. Remove handler/list entry or fail closed. This is stdio MCP capability, **not a demonstrated unauthenticated HTTP RCE**. |
| B02 | High | letsmcp `src/tools.ts:421`, `601`, `677`; read at `628`; search at `709` | Directory summary/read/search resolve arbitrary absolute or traversing paths from cwd without containment. The unused `validatePath` helper at `122-132` is not an effective security boundary. Restrict all filesystem operations to an explicit dedicated safe directory. |
| B03 | High | letsmcp `src/tools.ts:520-557` | Save containment uses `startsWith`, accepting a sibling prefix such as `mcp-files-other`, and follows symlinks. `fs.access` before write also creates a race. Use separator-aware containment, realpath checks of root/ancestors, symlink rejection and no-follow opens/atomic safe writes. Retain an explicit assumption that unrelated hostile processes cannot rewrite parent directories during operations. |
| B04 | High | letsmcp `src/index.ts:19-35`, `src/api/routes.ts:21-31`; resume read/write `283-314`; profile `410-444`; jobs `450-548` | HTTP routes have no server-side auth or authorization. Anyone reaching the listener can read or change globally shared resume/profile/jobs and consume configured provider quota. Add server-verified sessions with origin/CSRF enforcement and per-user storage boundaries. |
| B05 | High | JobOS `src/context/AuthContext.tsx:7-14`, `22-34`, `src/services/storage.ts:32-49`; `src/ui/views/LoginView.tsx:85-107` | Google ID tokens are merely decoded with `atob`; signature, audience, issuer and expiry are not validated. LocalStorage identity is forgeable. Frontend namespace is not backend authorization; server data is shared. Baseline UI claims account privacy beyond what code enforces. Replace with a genuine backend session; keep future ChatGPT OAuth integration separate from unverified JWT decoding. |
| B06 | High | letsmcp `src/api/routes.ts:154-155`, `343-348`; `src/tools.ts:847-864` | URL fetches do not block loopback/private/link-local/metadata targets, all DNS results or private redirects. MCP only restricts HTTP(S). This permits SSRF and internal response disclosure. Validate scheme, credentials, ports/hostname/IP classifications, resolve and pin DNS addresses for socket connection, and revalidate every redirect. Limit total timeout and response size. |
| B07 | High | letsmcp `src/tools.ts:115-117`, `943-947`; `src/api/routes.ts:119`, `192`, `571-599` | LinkedIn URL checking uses a substring; other-host URLs can include it in path/query. Browser navigation and page subrequests/redirects can target internal resources. API scraper disables Chromium sandbox (`578-587`). Phase 0 should disable browser scraper or enforce a verified egress boundary on every browser request while retaining browser sandbox. |
| B08 | High | letsmcp `src/index.ts:20-24` | CORS reflects every Origin. An arbitrary site can invoke/read JSON API requests if the listener is reachable. Exact trusted-origin allowlist, rejected origins and credentials only for intended session clients are required; CORS alone is not authentication. |
| B09 | High | JobOS `src/ui/views/JobDetail.tsx:189`; `src/ui/components/ResumeAnalyst.tsx:90`, `95`, `100`, `163-186`, `304` | Stored job descriptions and AI-generated analysis enter `dangerouslySetInnerHTML` without sanitization. Job content arrives through unauthenticated backend/extension/import/AI paths. AI JSON strings are interpolated into HTML `<li>` elements. Render untrusted content as escaped text/React elements or use a maintained strictly configured sanitizer. XSS can expose browser CV/profile/AI secrets and issue requests through a future session. |
| B10 | High | JobOS `src/services/storage.ts:406-431`; settings writes `src/ui/components/SettingsModal.tsx:39-53`; export `storage.ts:354-355` | Gemini keys are persisted globally in localStorage and included in JSON backups. Remove direct browser credentials and migrate/remove legacy secret fields from read/import/export/write paths. Direct provider discovery sends key as URL query (`src/services/ai/providers/gemini.ts:66`). |
| B11 | Medium | letsmcp `src/api/routes.ts:51-68`; prod guard `54-56` | Runtime provider reconfiguration is disabled only when NODE_ENV exactly equals production; unauthenticated dev/config requests otherwise replace shared provider credentials/config. Remove or strongly restrict the endpoint; never rely only on environment labels. Production guard was introduced upstream and is not proof of full API authentication. |
| B12 | Medium | letsmcp `src/ai/providers/groq.ts:98-100`; provider error bodies: `claude.ts:44-46`, `groq.ts:45-47`, `gemini.ts:47-49`; service errors `src/ai/service.ts:95-103`; route error responses e.g. `src/api/routes.ts:96-99` | Raw AI output is logged on invalid email JSON; raw upstream response/error text is logged and returned to clients. Generated drafts may contain personal data; upstream errors may echo request/context. Use generic client errors and metadata-only log events. Move Gemini key out of query interpolation (`gemini.ts:25`) where practical. |
| B13 | Medium | letsmcp `src/api/routes.ts:17-19`, `485`, `529`, `542`; `.gitignore:32-35` | Shared cwd files and non-atomic read/modify/write can mix users, lose concurrent updates or expose plaintext data. `resume.txt` and screenshot output are not ignored at baseline. Store only synthetic data under ignored explicit root during Phase 0, partition by verified subject, and defer production migration until a reviewed database model exists. |
| B14 | Medium | letsmcp `src/tools.ts:597`, `671-709`, `768`, `841-878`; API `src/index.ts:27` | Caller-controlled limits/timeouts, unrestricted regex search, unbounded fetch response bodies and absent API rate limits enable resource exhaustion. Enforce server maxima, safe input validation, bounded search work and request limits. |
| B15 | Medium | JobOS `vite.config.ts:10-12`, `22-23`; both `.github/workflows/deploy.yml:3-5`, `11-26/27`; JobOS `ecosystem.config.cjs:1-9` | Development/preview binds all interfaces; allowed host includes author IP/nip.io. Main pushes trigger author-target SSH deployment if matching secrets exist. Disable deployment workflow in fork and use loopback-only local listeners/config. Remove author deployment IP/backend references while preserving upstream provenance and MIT attribution. |
| B16 | Supply-chain verification required | letsmcp `package.json:26`; both lockfiles and workflows | Manifest range says MCP SDK `^1.0.4` but lock resolves **1.25.2**. Do not misreport installed SDK as 1.0.4. Verify current advisories/patches via authoritative audit/docs and update lock/manifests on hardening branches. Actions use mutable tags (`actions/checkout@v4`, `actions/setup-node@v4`, `appleboy/ssh-action@v1`); pin trusted audited commit SHAs, minimum permissions and add dependency/secret/security CI. This independent audit did not query live advisory databases. |

## Architecture and outbound data flow

JobOS is a React/Vite client. Most jobs, contacts, artifacts, drafts, company research, STAR stories and profile are persisted as plaintext browser localStorage, partitioned by a client-controlled ID. It fetches relative `/api/*` by default through the Vite proxy to loopback letsmcp port 3002; configurable `mcpUrl` can redirect AI/job-context requests elsewhere. Google Identity Services is loaded remotely by `index.html:8`. Direct Gemini SDK/client requests send prompt/job/resume/draft context to Google's endpoint when the browser key is configured. File extraction uses bundled PDF.js worker and Mammoth raw text extraction locally; there is no separate upload in that service. No document file-size/page-count bound is enforced (`src/services/fileExtraction.ts:15-55`).

letsmcp's entrypoint starts an Express HTTP server **and** connects stdio MCP (`src/index.ts:13-51`). Contrary to metadata describing HTTP MCP transport, there is no actual HTTP MCP tools transport in this baseline. REST API routes consume AI credentials configured in server env/runtime API and persist shared queue/profile/resume files in cwd. Stdio MCP advertises eight tools, including arbitrary process execution and filesystem access. Server-side fetches and browser scraper can visit caller-provided destinations; fixed provider destinations are `api.groq.com`, `api.anthropic.com`, and `generativelanguage.googleapis.com`. `AIService.executeWithFallback` silently tries additional configured providers after failure (`src/ai/service.ts:80-105`), so sensitive input can cross multiple processors. A later production/data policy should make that behavior explicit.

No first-party mail/Slack sender or automated application submission integration was found. UI “Mark Sent” records an artifact/engagement locally (`JobOS/src/ui/views/JobDetail.tsx:321-352`); it does not send the email. Dangerous tool access remains capable of arbitrary external actions unless removed.

## Install/startup/CI/test safety

Both root package manifests contain only ordinary dev/build/test/start scripts and no first-party `preinstall`, `install`, `postinstall`, `prepare` or publish hook. JobOS dev/preview starts Vite; letsmcp dev/start starts both HTTP and stdio and loads dotenv. Consequently do not start baseline letsmcp from a credentialed/user-data directory for “just a quick check.” Inspect environment and run synthetic isolated validation only.

JobOS baseline CI executes npm ci, lint, build and tests for main pushes/PRs; there is no explicit minimum permissions, pinned action SHA, secret scan or dependency security gate. letsmcp has only an author deployment workflow and no validation workflow. Source docs include remote deployment recipes and `curl ... | bash` Node installation instructions in `SELF_HOSTED.md:46` and `550`; those are documentation, not npm hooks and were not executed. Keep these legacy recipes clearly marked superseded or remove from the local Phase 0 path.

letsmcp baseline `src/tools.test.ts` writes/recursively removes fixed cwd directories `test-temp-dir`, `mcp-files`, `test-read-files`, `test-search-dir`; most notably cleanup removes all cwd `mcp-files` (`273-284`). Existing tests issue live `https://example.com` requests (`490-522`) and spawn node/bash/cmd through executeCommand (`453-487`). Its API tests mock `playwright` but source imports `playwright-extra`; this mock mismatch needs attention before relying on network/browser isolation. AI service tests mock global fetch. Test execution and results belong to the main hardening validation report; this audit ran no tests and does not claim they passed.

## Lockfile metadata and history checks

| Check | JobOS | letsmcp |
|---|---:|---:|
| Lockfile format | 3 | 3 |
| Package entries including root | 356 | 331 |
| Resolved package URLs | 355 | 330 |
| Resolved URL hosts | only `registry.npmjs.org` | only `registry.npmjs.org` |
| Resolved entries missing integrity | 0 | 0 |
| Reachable distinct historical blobs scanned for selected high-confidence secret signatures | 257 | 109 |
| Selected secret-signature matches | 0 | 0 |

Lock metadata marks JobOS `@swc/core@1.15.3`, `esbuild@0.25.12`, `fsevents@2.3.3`, and letsmcp `esbuild@0.27.2`, `fsevents@2.3.3`, nested Playwright `fsevents@2.3.2` as having install scripts. Their downloaded package contents/lifecycle script bodies were not inspected or executed by this independent audit. Registry provenance plus integrity reduces accidental drift but does not establish package trust or absence of malware.

A metadata-only scan of every reachable historical blob looked for Google API key, provider key, GitHub token, private-key header and AWS access-ID signatures. It emitted only rule/path/blob/line metadata and found no selected matches. This is not exhaustive secret detection, does not inspect host credentials, and does not certify history as secret-free. Original zip contents and images require their specialized review. Source pattern scans identified no `eval`, `new Function`, string timer execution or base64-decoded loader; the identified `atob` is the insecure Google JWT decoding already described.

Commit summaries were inspected for all 44/33 reachable commits. The history has ordinary feature/lint/docs/deployment sequences; risky capabilities are introduced overtly rather than disguised by commit metadata. JobOS history additionally contains retired `ecosystem.config.js`, `public/jobos-linkedin-scraper.zip`, and `src/services/ai.ts`. Preserve upstream history and do not rewrite it for cleanup. Historical extension variants were not fully unpacked by this independent audit. No submodule or tracked symlink is present in either baseline: every baseline Git entry mode is `100644`.

## Licenses

Both repos are MIT licensed with `Copyright (c) 2026 Shane Bennett` (`LICENSE:1-13`). Preserve copyright and permission notice when modifying/distributing the fork. Removing live author-backend references does not mean stripping license attribution/upstream URLs used solely for provenance.

## Inventory and coverage

All paths below are exact baseline tracked paths, not the changing hardening tree. “Inspected” means the static method described above; tests are read, not executed; binary/lock inspection is limited as stated.

### JobOS

**First-party source and source tests (inspected)**

- `src/App.tsx`
- `src/context/AuthContext.tsx`
- `src/context/auth.ts`
- `src/context/useAuth.ts`
- `src/domain/__tests__/application.test.ts`
- `src/domain/action.ts`
- `src/domain/ai.ts`
- `src/domain/application.ts`
- `src/domain/artifact.ts`
- `src/domain/engagement.ts`
- `src/domain/job.ts`
- `src/domain/person.ts`
- `src/domain/research.ts`
- `src/domain/star.ts`
- `src/domain/suggestion.ts`
- `src/domain/user.ts`
- `src/main.tsx`
- `src/services/__tests__/workflow.test.ts`
- `src/services/ai/ai.ts`
- `src/services/ai/providers/gemini.ts`
- `src/services/ai/providers/letsmcp.ts`
- `src/services/extractor.ts`
- `src/services/fileExtraction.ts`
- `src/services/recommendations.ts`
- `src/services/storage.ts`
- `src/services/workflow.ts`
- `src/types/google.ts`
- `src/ui/components/AppHeader.tsx`
- `src/ui/components/ArtifactList.tsx`
- `src/ui/components/CompanyResearchTab.tsx`
- `src/ui/components/ConfirmationModal.tsx`
- `src/ui/components/ContactList.tsx`
- `src/ui/components/DraftMessageModal.tsx`
- `src/ui/components/EngagementLog.tsx`
- `src/ui/components/HistoryModal.tsx`
- `src/ui/components/InterviewPrepTab.tsx`
- `src/ui/components/ResumeAnalyst.tsx`
- `src/ui/components/SettingsModal.tsx`
- `src/ui/components/SuggestionCard.tsx`
- `src/ui/components/SuggestionList.tsx`
- `src/ui/components/SuggestionModal.tsx`
- `src/ui/components/UserProfileModal.tsx`
- `src/ui/components/ViewMessageModal.tsx`
- `src/ui/components/__tests__/SuggestionCard.test.tsx`
- `src/ui/components/__tests__/SuggestionList.test.tsx`
- `src/ui/layout/DashboardLayout.tsx`
- `src/ui/views/AddJobView.tsx`
- `src/ui/views/DashboardView.tsx`
- `src/ui/views/ExtensionInstallView.tsx`
- `src/ui/views/JobBoard.tsx`
- `src/ui/views/JobDetail.tsx`
- `src/ui/views/LoginView.tsx`
- `src/ui/views/RoutineView.tsx`
- `src/utils/__tests__/streak.test.ts`
- `src/utils/streak.ts`
- `src/utils/uuid.ts`

**Build, package, workflow, environment and client configuration (inspected)**

- `.env.example`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `.gitignore`
- `ecosystem.config.cjs`
- `eslint.config.js`
- `index.html`
- `package.json`
- `tsconfig.app.json`
- `tsconfig.json`
- `tsconfig.node.json`
- `vite.config.ts`

**Documentation and license (relevant security content inspected)**

- `LICENSE`
- `PROJECT_STATUS.md`
- `README.md`

**Lockfile metadata (parsed, not downloaded dependency body inspection)**

- `package-lock.json`

**Static text assets (scanned for script/resources)**

- `public/vite.svg`
- `src/App.css`
- `src/assets/react.svg`
- `src/index.css`

**Binary/archive assets (hash/signature inventory; extension separate)**

- `docs/screenshots/jobos-1-dashboard.png` — 106736 bytes; SHA-256 `38fcfc63359b5225001149828820f38808762323588570ebe72758781cbaea1f`; signature `89504e470d0a1a0a`
- `docs/screenshots/jobos-2-board.png` — 96669 bytes; SHA-256 `713ad947d4922f461d7908ee67b78086e71f92998c9a809b06ed3dd2fd8bc39a`; signature `89504e470d0a1a0a`
- `docs/screenshots/jobos-3-detail.png` — 109456 bytes; SHA-256 `b2fba0433d88c8a78a0efeae04f8bece429aae74697bb6e63fde9586d0ca6e8c`; signature `89504e470d0a1a0a`
- `public/LinkedInJobOS.zip` — 7559 bytes; SHA-256 `71646fa13922bd4cf08438562d1414cf70bf45ed52126bd6fbe0be3cc5fbece1`; signature `504b030414000000`

### letsmcp

**First-party source and source tests (inspected)**

- `src/ai/index.ts`
- `src/ai/prompts.ts`
- `src/ai/providers/claude.ts`
- `src/ai/providers/gemini.ts`
- `src/ai/providers/groq.ts`
- `src/ai/providers/index.ts`
- `src/ai/service.test.ts`
- `src/ai/service.ts`
- `src/ai/types.ts`
- `src/api/index.ts`
- `src/api/routes.test.ts`
- `src/api/routes.ts`
- `src/index.ts`
- `src/server.ts`
- `src/tools.test.ts`
- `src/tools.ts`
- `test-echo.ts`
- `test.ts`

**Build, package, workflow, environment and client configuration (inspected)**

- `.env.example`
- `.github/workflows/deploy.yml`
- `.gitignore`
- `antigravity-mcp-config.json`
- `fly.toml`
- `package.json`
- `railway.json`
- `render.yaml`
- `tsconfig.json`
- `vitest.config.ts`

**Documentation and license (relevant security content inspected)**

- `DEPLOYMENT.md`
- `LICENSE`
- `MCP_CONFIG.md`
- `PROJECT_STATUS.md`
- `README.md`
- `SELF_HOSTED.md`
- `TESTING.md`
- `TEST_README.md`
- `TOOLS.md`
- `TOOL_GUIDE.md`

**Lockfile metadata (parsed, not downloaded dependency body inspection)**

- `package-lock.json`

## Residual limits and hardening handoff

This audit establishes a reproducible upstream baseline and a list of security changes to validate. It does not establish a final hardened state, safe production deployment, real ChatGPT plan integration, absence of all malware/backdoors, comprehensive historical artifact review, an exhaustive dependency/tarball review, or runtime resistance to DNS/filesystem races. No real CV, LinkedIn profile, credentials or production data should be introduced as a consequence of this baseline report alone. The main agent must map findings to actual branch changes, tests, current dependency audit results and extension specialist evidence before declaring Phase 0 complete.

The report is intentionally outside either repository so workers can integrate reviewed portions into repository security docs without conflicting edits. Temporary baseline copies are synthetic upstream source, contain no user data, and can be removed after evidence integration.
