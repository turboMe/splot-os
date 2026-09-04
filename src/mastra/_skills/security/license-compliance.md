---
name: license-compliance
category: security
description: >-
  Checking npm dependency licenses before adding them to the project.
  Verifies whether a license is compatible with the project (allowlist/blocklist)
  and generates a compliance report.
keywords: [security, license, compliance, npm, legal, dependency, audit]
allowedTools: [shell_execute, fs_read_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 400
outputFormat: text
tags: [security, license, compliance]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# License Compliance Check

> Tool: [license-checker](https://github.com/davglass/license-checker)

## Trigger
- Before adding a new dependency
- Before a production release
- On a schedule (once a month)

## Licenses — Allowlist / Blocklist

### ✅ Allowed (Permissive)
- MIT
- Apache-2.0
- BSD-2-Clause, BSD-3-Clause
- ISC
- CC0-1.0
- Unlicense
- 0BSD

### ⚠️ Require review (Copyleft-weak)
- LGPL-2.1, LGPL-3.0 (OK if dynamically linked)
- MPL-2.0 (OK if changes to the source file are public)
- CC-BY-4.0

### 🔴 Blocked (Copyleft-strong / Restrictive)
- GPL-2.0, GPL-3.0 (forces open-sourcing the whole project)
- AGPL-3.0 (even SaaS requires open-source)
- SSPL (Server Side Public License)
- CC-BY-NC (no commercial use)
- Proprietary / Unknown

## Procedure

### Step 1: Scan
```bash
npx license-checker --summary 2>/dev/null
```

### Step 2: Find the problematic ones
```bash
npx license-checker --excludePackages '' --json 2>/dev/null | jq 'to_entries[] | select(.value.licenses | test("GPL|AGPL|SSPL|Proprietary|UNKNOWN"; "i")) | {package: .key, license: .value.licenses}'
```

### Step 3: Report
```markdown
## License Compliance Report
- **Packages scanned:** [count]
- **Permissive (OK):** [count]
- **Review needed:** [count]
- **Blocked:** [count]

### Action Items
| Package | License | Action |
|---------|---------|--------|
| ... | GPL-3.0 | Replace with alternative |
```

## Success Criteria
- 0 GPL/AGPL packages in the production bundle
- Scan run before every new `npm install`
