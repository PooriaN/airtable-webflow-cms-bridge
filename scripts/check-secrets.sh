#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "Scanning tracked files for likely secrets..."

matches=()
allowlist_substrings=(
  'postgresql://USERNAME:PASSWORD@HOST:5432/cms_bridge'
)

collect_matches() {
  local pattern="$1"
  shift
  local output
  if output=$(git grep -n -I -E "$pattern" -- "$@" 2>/dev/null); then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue

      local allowed=false
      for allowed_substring in "${allowlist_substrings[@]}"; do
        if [[ "$line" == *"$allowed_substring"* ]]; then
          allowed=true
          break
        fi
      done

      [[ "$allowed" == true ]] || matches+=("$line")
    done <<< "$output"
  fi
}

# High-signal token and private key patterns.
collect_matches 'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----' \
  . ':(exclude)package-lock.json'

# Connection strings with embedded credentials should never be committed outside the example env file.
collect_matches '(postgres(ql)?|mongodb(\+srv)?|mysql|redis)://[^[:space:]]+:[^[:space:]]+@' \
  . ':(exclude).env.example' ':(exclude)package-lock.json'

# App/provider env assignments should only exist in the example env file.
collect_matches '^(AIRTABLE_API_KEY|WEBFLOW_API_TOKEN|APP_PASSWORD|APP_SESSION_SECRET|APP_AUTOMATION_TOKEN|DATABASE_URL|POSTGRES_URL)=' \
  . ':(exclude).env.example' ':(exclude)package-lock.json'

if ((${#matches[@]} > 0)); then
  printf 'Potential secret leak(s) detected:\n'
  printf '%s\n' "${matches[@]}"
  exit 1
fi

echo "No likely secrets found in tracked files."
