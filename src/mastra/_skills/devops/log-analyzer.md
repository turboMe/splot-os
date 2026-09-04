---
name: log-analyzer
category: devops
description: >-
  Parse and analyze application logs, system journals, and container output
  to identify error patterns, correlate events, and perform root cause analysis.
  Use when agent needs to diagnose failures, find error patterns, or triage
  system issues from log data.
keywords: [logs, journalctl, syslog, error, debugging, grep, jq, analysis, observability]
allowedTools: [shell_execute, fs_read_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1000
outputFormat: text
tags: [devops, logs, diagnostics, observability]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Log Analyzer

## Trigger
Agent needs to diagnose failures, find error patterns, correlate timeline
events, or triage system issues by analyzing log output.

## Procedure

### Step 1: Determine log source
Identify where logs live:
- **Systemd service** → `journalctl`
- **Docker container** → `docker logs`
- **Application file** → `cat` / `tail` / `less`
- **Syslog** → `/var/log/syslog` or `/var/log/messages`

### Step 2: Extract relevant log data

**Systemd journals:**
```bash
# Recent errors from a specific service
journalctl -u <service> --since "1 hour ago" --no-pager -p err

# All logs from previous boot (useful after crash)
journalctl -b -1 -p err --no-pager

# Follow live logs
journalctl -u <service> -f --no-pager

# Logs around a specific timestamp
journalctl -u <service> --since "2026-05-09 14:00" --until "2026-05-09 14:30" --no-pager
```

**Docker container logs:**
```bash
# Recent logs with timestamps
docker logs --tail 200 --timestamps <container>

# Logs within time window
docker logs --since "2h" --until "1h" <container>

# Follow with grep
docker logs -f <container> 2>&1 | grep --line-buffered "ERROR\|FATAL\|WARN"
```

**Application log files:**
```bash
# Last N lines
tail -n 200 /path/to/app.log

# Search for errors
grep -n -i "error\|fatal\|exception\|panic\|traceback" /path/to/app.log

# Context around errors (3 lines before, 5 after)
grep -B 3 -A 5 -n "ERROR" /path/to/app.log
```

### Step 3: Parse structured logs

**JSON logs with jq:**
```bash
# Filter by severity
cat app.log | jq -r 'select(.level == "error") | "\(.timestamp) \(.message)"'

# Count errors by type
cat app.log | jq -r 'select(.level == "error") | .error_type' | sort | uniq -c | sort -rn

# Extract specific fields
cat app.log | jq '{time: .timestamp, msg: .message, err: .error}'

# Filter by time range (ISO timestamps)
cat app.log | jq -r 'select(.timestamp >= "2026-05-09T14:00:00")'
```

**Logfmt / key=value parsing:**
```bash
# Extract specific keys from logfmt
grep "level=error" app.log | sed 's/.*msg="\([^"]*\)".*/\1/'

# Use awk for structured extraction
awk -F'[ =]' '/level=error/{for(i=1;i<=NF;i++) if($i=="msg") print $(i+1)}' app.log
```

### Step 4: Identify error patterns

**Pattern detection strategy:**
1. **Count by severity:** How many ERRORs vs WARNs in the time window?
2. **Cluster by message:** Group identical/similar error messages
3. **Timeline correlation:** When did errors start? Was there a deploy or config change?
4. **Stack traces:** Find complete stack traces (multi-line grep)
5. **Cascading failures:** Does error A always precede error B?

```bash
# Error frequency timeline (per minute)
grep "ERROR" app.log | awk '{print substr($1,1,16)}' | uniq -c

# Top 10 most frequent error messages
grep "ERROR" app.log | awk -F'ERROR' '{print $2}' | sort | uniq -c | sort -rn | head -10

# Find first occurrence of an error
grep -m 1 "specific error message" app.log
```

### Step 5: Correlate across sources

When diagnosing system-wide issues:
1. **Establish timeline:** Find exact time of first anomaly
2. **Check dependent services:** Query logs of upstream/downstream services at the same time
3. **Check system resources:** Was there OOM, CPU spike, or disk full?
4. **Check deployment events:** Was anything deployed or restarted recently?

```bash
# System resource events
journalctl -k --since "1 hour ago" | grep -i "oom\|killed\|memory"

# Recent systemd restarts
journalctl --since "1 hour ago" | grep -i "started\|stopped\|failed"

# Disk space issues
df -h | awk '$5+0 > 80 {print "WARNING: " $0}'
```

### Step 6: Report findings

Structure the analysis as:
1. **Summary:** What happened (1-2 sentences)
2. **Timeline:** When it started, key events in order
3. **Root cause:** Most likely explanation with evidence
4. **Impact:** What was affected
5. **Recommendation:** How to fix or prevent recurrence

## Success criteria
- Root cause identified with log evidence
- Timeline of events established
- Actionable recommendation provided
- No false correlations (verify cause precedes effect)
