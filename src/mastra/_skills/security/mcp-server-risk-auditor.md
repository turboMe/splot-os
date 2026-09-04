---
name: mcp-server-risk-auditor
category: security
description: >-
  Procedure for auditing new MCP servers before adding them to mcp.ts.
  The checklist covers: permissions, data-exfiltration risk,
  authorization model, code quality, dependencies.
keywords: [security, mcp, audit, risk, server, permissions, exfiltration]
allowedTools: [fs_read_file, shell_execute, search_web]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 600
outputFormat: text
tags: [security, mcp, audit]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# MCP Server Risk Auditor

## Trigger
Before adding a new MCP server to `mcp.ts` — MANDATORY audit.

## Audit Checklist

### 1. Server identification
- [ ] NPM package name / GitHub repo
- [ ] Author / organization
- [ ] License (MIT/Apache/GPL?)
- [ ] Last update (> 6 months = 🔴)
- [ ] Number of stars / downloads

### 2. Permission analysis
- [ ] Which tools does the server expose?
- [ ] Which tools read vs write data?
- [ ] Does the server require filesystem access?
- [ ] Does the server execute shell commands?
- [ ] Does the server talk to external APIs?

### 3. Data-exfiltration risk
| Category | Question | Risk |
|-----------|---------|--------|
| Network | Does the server send data to external endpoints? | 🔴 High |
| Filesystem | Does the server read files outside the workspace? | 🟡 Medium |
| Env | Does the server need API keys in env? | 🟡 Medium |
| Persistence | Does the server write data locally? | 🟢 Low |

### 4. Authorization model
- [ ] Does the server require authentication? (API key, OAuth?)
- [ ] Is the token scope-limited? (read-only vs full access?)
- [ ] Where are credentials stored? (.env vs hardcoded?)

### 5. Code quality
```bash
# Check dependencies
npm audit --json 2>/dev/null | jq '.vulnerabilities | length'

# Check dependency licenses
npx license-checker --summary 2>/dev/null
```

### 6. Configuration in mcp.ts
```typescript
// Reference configuration with restrictions
'new-server': {
  command: 'npx',
  args: ['@scope/server@latest'],
  env: {
    // Only the required variables — NEVER pass all env
    SERVER_API_KEY: process.env.SERVER_API_KEY,
  },
}
```

## Severity Matrix

| Combination | Rating | Decision |
|------------|-------|---------|
| Network write + no auth | 🔴 Critical | BLOCK |
| Filesystem write + outside workspace | 🔴 Critical | BLOCK |
| Network read + auth | 🟡 Medium | CONFIRM + restrict env |
| Filesystem read + workspace only | 🟢 Low | ALLOW |
| No network + no filesystem | 🟢 Safe | ALLOW |

## Final report
```markdown
### MCP Server Audit: [name]
- **Overall risk:** Low / Medium / High / Critical
- **Permissions:** [list of tools with rating]
- **Exfiltration:** [yes/no + details]
- **Auth model:** [description]
- **Recommendation:** ALLOW / ALLOW with restrictions / BLOCK
- **Conditions:** [if ALLOW with restrictions]
```

## Success Criteria
- A new MCP server has an audit report before merge to `mcp.ts`
- The report includes a severity assessment
- Env vars limited to the minimum
