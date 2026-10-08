# Phase 0 adversarial runtime review

Date: 2026-10-07 (Europe/Ljubljana). Independent read-only review of the active hardening changes in both repositories; agents were editing concurrently. This is a review snapshot, not a report that every final check passed. No repository code, test suite, network request, real provider call or user-data action was run by this reviewer.

## Conclusion

No confirmed P0/P1 auth bypass, SSRF bypass, arbitrary command-execution path, stored browser XSS sink or default filesystem traversal/symlink bypass was found in the reviewed hardening runtime. The core changes address the upstream threat paths. All four concrete findings raised by this review are resolved in the latest observed source, including a follow-up disconnect/concurrency case. No remaining actionable P0/P1/P2 runtime blocker was identified within the reviewed boundaries. This is static review evidence, not a substitute for the owner's final test execution, dependency/secret checks or browser/extension QA. The local single-owner, Linux-only, synthetic-data limits below remain deliberate.

## Concrete review findings

### R1 — Unsafe configured root was accepted (resolved)

The first reviewed root policy accepted an explicit service-owned private `SAFE_DATA_DIR` such as `HOME/.ssh`; ordinary relative filenames then bypassed the tool input-name filter. The latest `letsmcp/src/security/filesystem.ts:11,25-45` rejects sensitive names anywhere in the configured root, including `.ssh`, `.aws`, `.git`, `.codex`, `.agents`, `.env.d`, `credentials`, `secrets`, `.gnupg`, `.kube`, `.docker` and `.azure`, plus unsafe generic/system roots. `src/tools.test.ts:107-112` exercises twelve credential-directory ancestor cases using temporary synthetic directories. No actual credential directory was accessed. Operator configuration remains trusted: name checks and private ownership alone do not prove a directory contains only safe data; use a new dedicated directory.

### R2 — Bound authenticated API concurrency/rate (resolved, including follow-up disconnect case)

The initial implementation had only login throttling, so one authenticated client could start many public fetches/provider calls. Current `letsmcp/src/security/limits.ts:4-31`, mounted before the body parser at `src/app.ts:25`, enforces 120 requests per source/minute, at most eight active requests, a bounded 1024-bucket map and generic 429 with Retry-After. `trust proxy` is disabled (`src/app.ts:14`); forwarded headers cannot mint rate identities. The loopback HTTP server caps connections at 128 and sets request/header timeouts (`src/index.ts:14-16`).

A follow-up version initially released the active slot on response close while async work could continue, allowing an authenticated client to abort sockets and evade the eight-operation limit. This was raised and corrected: `src/security/limits.ts:25-37` suppresses response-event release while real work is pending and releases exactly once when the operation settles; `src/api/routes.ts:41-42` wraps every async business handler with `trackRequestWork`. Disconnected callers can leave bounded work running until its existing deadline, but cannot use socket close to remove it from the work count.

Static test assessment: `src/security/limits.test.ts:5-35` covers capacity, finish/close double-release and a deferred real operation that remains counted after close until settlement. `src/api/routes.test.ts:104-111` covers request rejection and fresh-window expiry through the mounted app. This reviewer did not execute those tests. The owner reports the two focused limiter tests passed; the final full suite is the owner's responsibility.

### R3 — Stop local erasure when backend deletion fails (resolved)

Current `JobOS/src/ui/components/SettingsModal.tsx:58-74` requires a successful `/api/jobs` DELETE before calling `StorageService.clearAll` or reloading. Rejected responses and network errors retain the browser workspace and show an alert; the delete has a ten-second deadline and the UI guards duplicate submissions. `src/ui/components/__tests__/SettingsModal.test.tsx:18-46` checks 401/403/429/500 and network failure preserve a synthetic job without reload, plus successful deletion clears it. This resolves the reported false-success queue deletion path. It does not certify a comprehensive backend retention/erasure policy for every stored file; Phase 0 remains synthetic data only.

### R4 — In-place persistence can expose partial files (resolved for atomic publication)

Current `letsmcp/src/security/filesystem.ts:104-151` no longer truncates the existing target. It writes and syncs a new private 0600 sibling via the already-open parent descriptor, verifies its regular-file/link/inode state, then publishes with descriptor-anchored rename for overwrite or exclusive link for no-overwrite. Target symlinks, hardlinks and special files are rejected; private temporary names are inaccessible through the tool interface and only the operation's own temporary is removed. Directory metadata is synced. An already-open old version may safely have zero links after replacement (`filesystem.ts:79-81`). Confinement is preserved.

`src/tools.test.ts:84-106` directly checks complete old/new JSON versions during 80 concurrent reads and 20 replacements, plus a competing no-overwrite publication in which exactly one complete version succeeds and temporary names are removed. The owner additionally reports a separate native smoke with 160 complete reads/40 replacements. This reviewer inspected implementation and regression tests but did not run either check. Atomic publication resolves partial visibility/target truncation; it does not provide multi-file database transactions, multi-process lost-update protection or a guarantee against hostile same-UID filesystem mutation. Current single-owner/one-service-process scope remains explicit.

## Remaining actions and limitations

- No new runtime fix is requested by this focused re-review. Preserve the reviewed boundaries and run the final required tests after edits settle; any further runtime change may need a focused re-review.
- Owner follow-up 2026-10-08: tool documentation now records 82 focused tests (42 tool + 40 network); the final full suite has 138 tests. See PHASE0_REPORT.md for executed checks; this review remains a static snapshot.
- Final browser flow/extension execution, CI/action/dependency provenance and advisory scanning are outside this review's execution evidence. No live provider call, OAuth/ChatGPT integration or deployment was verified.
- No real user data is authorized for Phase 0. File persistence/browser storage remain single-owner local state, not multi-user isolation or a comprehensive retention/erasure policy. Linux fd confinement and a dedicated private safe directory are mandatory. Hostile same-account local processes remain outside the OS trust boundary.

## Boundary review evidence

| Boundary | Static result and practical limit |
|---|---|
| All REST business endpoints | `createAPIRoutes` mounts `/auth` then `requireSession` before every business route; separately mounting the router remains fail-closed. Only login, session management and health have deliberate exceptions. Runtime config is 403 and browser scraper is 410 after auth. |
| Identity/session | Server issues 256-bit opaque random tokens, stores their digest with 8-hour expiry, rejects duplicated/fabricated cookie shapes, rotates login sessions and revokes logout; no frontend identity/unsigned JWT is trusted. No default password; bootstrap length and attempts/session-map bounds enforced. Later OAuth must issue sessions only after verified identity. Current owner is intentionally fixed `local-owner`, not a deployed multi-user service. |
| CSRF/CORS/Host | Exact Origin is required for mutations; differing Origin and Sec-Fetch-Site cross-site are rejected; CORS exact allowlist has credentials; Host allowlist blocks arbitrary DNS-rebinding hosts. Opaque cookie HttpOnly/SameSite Strict, Secure for configured HTTPS. The local OS user/process boundary is trusted; cookies are not a sandbox against another hostile process running as the same user. |
| SSRF | URL parser rejects non-HTTP(S), credentials and nonstandard ports; IP normalization precedes address classification; loopback/private/CGN/link-local/metadata/IPv4-mapped/NAT64/ULA/special IPv6 targets fail closed; all DNS answers are validated, selected address is pinned via lookup with fresh connections; every redirect is resolved/checked and HTTPS downgrade rejected. Body size and total timeout bounded. No independent real-network request was needed to assess these paths. |
| Filesystem | Explicit canonical owned private root; root/ancestor symlink checks; fd-anchored component opens with O_NOFOLLOW/O_DIRECTORY; regular files only, multiple hardlinks rejected, FIFO nonblocking rejection; sensitive/traversing paths denied; atomic fd-anchored complete-file publication; depth/work/read/search/output bounds; Linux-only fails closed. Outside hostile same-UID directory mutation is not established as safe by static review and must not be claimed. |
| Command/browser tools | `executeCommand` and `scrapeLinkedInJob` removed from tool list and explicitly rejected on invocation; no spawn/child_process/Chromium import remains in first-party runtime. MCP transport remains stdio; no arbitrary HTTP tools path appears. |
| Frontend networking | Central same-origin `/api/` helper forces same-origin credentials and redirect errors; browser settings custom backend URL is removed; all current browser business fetches use helper. A server 401 clears UI session; periodic/focus checks fail closed. |
| Browser secret migration | Closed settings schema on read/write/import/export strips keys/models/custom backend URL; old unsigned `job_os_auth` removed at startup; browser Gemini provider removed and no external Google identity script remains. No direct browser AI credential transport remains. |
| XSS | Both original `dangerouslySetInnerHTML` sinks replaced by React text; AI arrays filtered to strings and displayed as text; job links permit HTTP(S) only without credentials; user picture external resource removed. Current runtime pattern scan finds no dangerous HTML sink, eval/new Function or author IP/backend endpoint. |
| Extension | Manifest has only activeTab/scripting, no background/content auto-execution/host permissions/storage/network permission. Popup requires explicit Preview, checks exact LinkedIn HTTPS host and job path, injects isolated self-contained function, previews plain text, exports Blob locally. Profile import/backend upload disabled. Extension CSP connect-src none. Packaging script limits allowlisted regular sources, stable metadata and byte-for-byte --check path. Original archive verdict remains extension specialist's report. |
| AI credentials/output | AI off unless explicit env enable and selected provider/key; no silent cross-provider fallback; fixed HTTPS provider endpoint allowlist, redirects rejected, bounded prompt/body/timeout, generic errors and no raw response logs. Gemini key now header not query. Structured AI JSON still uses TypeScript casts rather than complete semantic schemas, so malformed provider content can cause fallback/UI errors; this is not an HTML/script execution route after text rendering. |

## Validation assessed, not executed by this reviewer

Read the changed network, session/API, frontend security/auth/XSS and provider tests. They cover many expected negatives with synthetic fixtures and mocks. Current network tests include private IP variants, mixed DNS, pinning, per-redirect DNS rebinding, private redirects, HTTPS downgrade, DNS/body deadlines and bounded streamed response. API tests enumerate business auth routes, cookie properties/rotation/expiry/restart, origin/Host/cookie ambiguities, disabled routes, synthetic queue/resume/profile writes and symlink rejection. Frontend tests cover forged local identity, 401 expiry, secret settings migration and inert malicious HTML.

These source reads are not test execution evidence. The main task must run appropriate checks and preserve final results after concurrent edits settle. This reviewer inspected the new root-policy, atomic-publication, erase-failure, rate-window and disconnect-work regressions as well; pass counts relayed by the owner are explicitly attributed above. Live ChatGPT plan integration, current dependency advisories, CI action provenance, final extension artifact QA and deployment controls are handled by other task owners and are not certified by this runtime review.

## Reviewed runtime snapshot hashes

The hashes below identify current files at focused re-review completion. They allow the main task to notice concurrent changes and request focused re-review. They are not commit identities or proof that a branch is frozen.

### letsmcp

- `src/security/auth.ts` — SHA-256 `321dbce7b2807e1c36f55409501ebdd972aa899b82d0040b7e4a95bea0ea8099`
- `src/security/network.ts` — SHA-256 `8d247aed67e37c6326380aec44f364c69bc974377f2ad0f05d82984cd248dfc6`
- `src/security/filesystem.ts` — SHA-256 `89d1ac463aa315f2cd891212e9151aada7366731484c617668753fbc09c2e027`
- `src/app.ts` — SHA-256 `86709e71f32c98651b09c6fd15deffb33e24a456b1548b71944fecc40c557bb6`
- `src/api/routes.ts` — SHA-256 `16366f0b52ad9f5af77c7011d29cfc4f932c412ca0af7af74cb996bf64a87412`
- `src/index.ts` — SHA-256 `7ed9a53712a59e79dfaedc4c17a02d2a38da4341cd4057378d94fd5fa0c3799f`
- `src/server.ts` — SHA-256 `0345bae8c86788d13c3d7a0f5a6c584e2e93d57e6b8daef2aa39b8d9003805e6`
- `src/tools.ts` — SHA-256 `16425f15a56894c3d993ecdc9c1de90360436c4ee5793353783c109e8874d2fe`
- `src/ai/service.ts` — SHA-256 `7ff1104557c673ff41e8cb59d49110a249e148346cc0c4cda8558d4388eb7fde`
- `src/ai/providers/request.ts` — SHA-256 `2563cdacb49292c68b5d158f8cb3a8fe65dc26ff59d57ca32656aae14bc7981a`
- `src/ai/providers/claude.ts` — SHA-256 `e7806f5a52c12cd9ae6e6d224c746251026bb91351901b6c47d66ae22c86c6b6`
- `src/ai/providers/gemini.ts` — SHA-256 `b1b37f0fb5fa6091ff173b325b8e8099364fd7cb510e94a276450b3be3d336ef`
- `src/ai/providers/groq.ts` — SHA-256 `e81f722343e9aac99024a71990c1d045d870971c0b6027634aab22bff7d85794`
- `src/security/limits.ts` — SHA-256 `fe28c2412a191214a2248687dc0c465868d76072f0dfc19f85a000abc2310a35`
- `src/security/limits.test.ts` — SHA-256 `5cc95889c88a095b9d030f927caefbee58b3c05942040b626a227998ce690504`
- `src/tools.test.ts` — SHA-256 `bac80a3299a35cb22e0fc494a06c6a13c9c2a9c026c900f06f6961e4288836dd`
- `src/api/routes.test.ts` — SHA-256 `95a15e15f3a412c7cf4dcad355e210a201c278c9ba12580da04bcecda0ed9d4c`

### JobOS

- `src/context/AuthContext.tsx` — SHA-256 `278c18eefd694d2a049ec94b0118c36c4802f62b5f558868c7d2f8f5e808f14d`
- `src/context/auth.ts` — SHA-256 `a038ade3f712db0544688c21c0b750049f79673d1eb9b0d13ac0e3bb1c50307c`
- `src/App.tsx` — SHA-256 `e0ca14e1bef33f9f9d53bbe53cd61f073690afca9c26f517bd81bb65c4e86bd4`
- `src/services/api.ts` — SHA-256 `3f7ad52747a3ab2f555c58662cd5a5d44ac8af1ec953ea65f879b26a5c55b657`
- `src/services/storage.ts` — SHA-256 `37d473376413a6989f3c3144a76826c58f4ab58c66fb3aa9ad6264abea229427`
- `src/services/ai/ai.ts` — SHA-256 `7869f0943042806beebc64a8937bcd799846676b8f300309038f29292496bb90`
- `src/services/ai/providers/letsmcp.ts` — SHA-256 `48574f034e020fc155bd03da9ad70bebf29410b88119a3e46d722bd86b3b7e57`
- `src/services/fileExtraction.ts` — SHA-256 `a45fee6c60dfe6f43d92162ed29c2359ddb70dc0f742916da2051e35917c889e`
- `src/utils/urls.ts` — SHA-256 `9ca2ce5aaf9dbf55da304a10ba3ac6898753f96329a1c06bbc1d66964802f434`
- `src/ui/components/AppHeader.tsx` — SHA-256 `0b762c99369cb1ba499597ec7f7719d02cdc7bf6d6384611ebc8cef7ee06e28d`
- `src/ui/components/CompanyResearchTab.tsx` — SHA-256 `86d61c30d4f4b5b267cdc6d88a9845eebf35e950efd14e2843e74084e1d1f1ca`
- `src/ui/components/DraftMessageModal.tsx` — SHA-256 `a56c8dfef5296397f4d9822ae1ebf8f2e72049ba09383bec05cdcbce7188a1db`
- `src/ui/components/ResumeAnalyst.tsx` — SHA-256 `9c48893086fb666d407406d8688e1e285ebeb87da58a6c58debeb28fd025fab8`
- `src/ui/components/SettingsModal.tsx` — SHA-256 `750b47e2ca119b4b94c5b5f92d0fdeec55c892c1bb222ae01beefb3ae0573b19`
- `src/ui/components/UserProfileModal.tsx` — SHA-256 `e9aec54de2db4fa1f92f1a350ae6fcccf74dd3fbb3eabc9b811f9e022eebdc8b`
- `src/ui/views/AddJobView.tsx` — SHA-256 `a705f51a4b453080f01b8a978820e4f29218fe4e4d03479feb28b4d901bfb3ee`
- `src/ui/views/ExtensionInstallView.tsx` — SHA-256 `375e95fb04a2ae03a6cdcc203701a8784f2f048eef8a1b883c47551e828f60e6`
- `src/ui/views/JobBoard.tsx` — SHA-256 `1cc19866bf60cf8af48b3eaf78130910dd2b670a8f05f09400fc6812c8ff39a1`
- `src/ui/views/JobDetail.tsx` — SHA-256 `30e9f933429a86c6221d18e702660694d85268f176523bf5043ccc935666fd21`
- `src/ui/views/LoginView.tsx` — SHA-256 `e8e6fdec45a68681d8412e3f16d6f7a1e5a281bb75c455de7fe1ba22b9f0b9ba`
- `extension/LinkedInJobOS/manifest.json` — SHA-256 `ab1a385392b035cd5fa7aa7d1322d088242fb630dc193d37df74b2ae2ba9bf7e`
- `extension/LinkedInJobOS/content.js` — SHA-256 `d2903422d552a07030a7298918834e63b0c80975ec018b2dbc2d8033af87356e`
- `extension/LinkedInJobOS/popup.js` — SHA-256 `fbc9b2163a5be1efd8b43c279ccc7c35853a4e329fbc21ae66dd4e32fe00ac62`
- `extension/LinkedInJobOS/popup.html` — SHA-256 `5b5a8a901fe65dcae6d33162d95713c509260d31567c4ca0ecc175266252a765`
- `extension/LinkedInJobOS/popup.css` — SHA-256 `8b41d7ed07454942c34539233b0df09dada67a4a385e53275051db2172e7a090`
- `scripts/build-extension.py` — SHA-256 `8c5a59f7c17b1f875f98e6d0cfbec170a3c0a48e124b9caeb63a34e6a2b35afc`
- `vite.config.ts` — SHA-256 `2c9146791b7cc303abb391e76bb9cc1ed9b07f0ccb19782c903c51958e162870`
- `index.html` — SHA-256 `2bc210f34c5054f4f05f0ea6f0629bbea1b0ccefe33ff0b35d040a609f09c2c7`
- `ecosystem.config.cjs` — SHA-256 `f478b1e00d8a947681200f799e4f54c2f0a518acc4d61f88370294f058b46466`
- `src/ui/components/__tests__/SettingsModal.test.tsx` — SHA-256 `2fe7c2ce891d7150712f8b394a7c4802dc176219aa5051a4df10cba995dc12fd`
