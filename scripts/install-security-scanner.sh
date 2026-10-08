#!/usr/bin/env bash
set -euo pipefail
# Vendor release + hardcoded SHA-256 verified against official release metadata.
scanner_dir="${1:?Pass a temporary tool directory}"
mkdir -p "$scanner_dir"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$scanner_dir/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$scanner_dir/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$scanner_dir/gitleaks.tar.gz" -C "$scanner_dir" gitleaks
"$scanner_dir/gitleaks" version
