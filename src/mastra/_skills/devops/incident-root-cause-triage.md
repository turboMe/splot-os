---
name: incident-root-cause-triage
description: Production incident triage methodology, log correlation, dependency failure isolation, and post-mortem report generation.
category: devops
keywords:
  - incident
  - triage
  - post-mortem
  - debugging
  - logs
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - search_content
  - execute_command
estimatedTokens: 235
outputFormat: markdown
tags:
  - devops
  - diagnostic
  - subagent-tier
version: 1
---

# Procedure: Production Incident Root-Cause Triage & Post-Mortem

Use this procedure when responding to production incidents (crash loops, runtime slot failures, API integration errors, memory exhaustion).

---

## 1. 4 Triage Phases

1. **Phase 1: Containment & Blast-Radius Mitigation:**
   - Determine if immediate rollback to a previous stable slot/commit is required.
   - Isolate failing endpoints or disable unstable background workers.

2. **Phase 2: Timeline & Log Correlation:**
   - Correlate incident timestamps with recent code deployments, configuration `.env` changes, and database metrics.

3. **Phase 3: 5-Whys Root-Cause Analysis:**
   - Distinguish symptoms (e.g., `504 Gateway Timeout`) from underlying causes (e.g., `unindexed table scan locking database pool`).

4. **Phase 4: Post-Mortem & Preventative Action Items:**
   - Propose an immediate hotfix followed by automated regression tests to prevent recurrence.
