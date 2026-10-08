# Security policy for Phase 0

This branch is a local security-hardening review, not a supported production release. Do not deploy, add real personal data/provider credentials, or merge into main without explicit approval. Review [Phase 0 report](docs/PHASE0_REPORT.md) and its limits before using it.

Report vulnerabilities privately to the fork owner through GitHub private vulnerability reporting if enabled. Do not include credentials or personal CV/LinkedIn data in public issues. No private-reporting or GitHub security settings have been changed by this task.

CI runs on the security branches and pull requests with SHA-pinned actions and minimum permissions. Gitleaks history/index/source scans redact findings, a lockfile provenance check rejects non-registry/unverified resolutions, npm audit blocks all advisory severities, and CodeQL uses security-extended queries. Dependency-update PRs target the hardening branch. Manual GitHub feature activation may be required in a fork; configuration alone is not proof of a successful remote run. CodeQL upload rights may be limited on untrusted fork pull requests.
