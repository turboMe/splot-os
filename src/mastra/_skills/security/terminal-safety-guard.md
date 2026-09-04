---
name: terminal-safety-guard
category: security
description: >-
  Terminal Safety Guard — a three-layer shell-command safety system.
  Intercepts bash commands before execution and classifies them as:
  BLOCK (immediate rejection), CONFIRM (requires approval),
  or ALLOW (safe to run). Protects against rm -rf /, fork bombs,
  DROP DATABASE, SSH-key exfiltration and other dangerous operations.
keywords: [security, terminal, safety, guard, bash, shell, destructive, command, blocker]
allowedTools: [shell_execute, fs_read_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 700
outputFormat: text
tags: [security, terminal, safety, critical]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Terminal Safety Guard

> Modeled on: [dcg](https://github.com/topics/destructive-command-guard),
> [sh-guard](https://github.com/topics/shell-safety),
> [AgentGuard](https://github.com/topics/agent-security).

## Trigger
Active AUTOMATICALLY — every `shell.execute` command passes through the guard.
You don't need to invoke this skill manually.

## Architecture

```
Agent → shell.execute(cmd) → checkCommand(cmd) → Verdict
                                   │
                              ┌────┼────────┐
                              ▼    ▼         ▼
                           BLOCK  CONFIRM   ALLOW
                             │      │         │
                             │      ▼         ▼
                             │   logWarning  execute
                             ▼
                          REJECT + logEvent
```

## Rule Categories

### 🔴 BLOCK (22 rules) — immediate rejection
| Category | Examples |
|-----------|-----------|
| Filesystem | `rm -rf /`, `dd of=/dev/sda`, `mkfs`, `shred` |
| System | fork bomb `:(){ :|:& };:`, `shutdown`, `kill 1` |
| Database | `DROP DATABASE`, `TRUNCATE TABLE`, `db.dropDatabase()` |
| Network | `curl ... | bash`, `wget ... | sh`, env exfiltration |
| Crypto/Secrets | `cat ~/.ssh/id_rsa`, `cat .env` |
| Permissions | `chmod 777 /`, `chown root /` |

### 🟡 CONFIRM (12 rules) — requires approval
| Category | Examples |
|-----------|-----------|
| Filesystem | `rm -r`, `chmod`, `git push --force`, `git reset --hard` |
| System | `sudo`, `systemctl stop`, `docker rm`, `npm install -g` |
| Database | `deleteMany({})`, `updateMany({}, ...)` |
| Network | `curl -X POST`, `iptables` |

### ✅ ALLOW — default
Anything that matches neither BLOCK nor CONFIRM.

## Workspace Safe Paths
Operations on these paths have relaxed rules (e.g. `rm -rf node_modules/` is OK):
- `/projekty/`
- `/tmp/sandbox*`
- `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`

## Implementation files
- `lib/terminal-safety-guard.ts` — main logic
- `tools/terminal/terminal-tools.ts` — integration with `shell.execute`

## Diagnostics
```typescript
import { getRuleStats } from './terminal-safety-guard.js';
console.log(getRuleStats());
// { blockRules: 22, confirmRules: 12, total: 34 }
```

## Extending the rules
To add a new BLOCK rule:
```typescript
{
  id: 'my-new-rule',
  pattern: /\bnew-dangerous-command\b/,
  action: 'BLOCK',
  reason: 'Description of why this is dangerous',
  category: 'system',  // filesystem | database | network | system | crypto
}
```

## Success Criteria
- Every `shell.execute` command passes through the guard
- 22+ BLOCK patterns active
- Blocked commands logged in `agent_events`
- False positive rate < 5% (workspace paths allowed)
