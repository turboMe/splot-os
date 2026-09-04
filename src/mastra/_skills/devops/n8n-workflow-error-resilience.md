---
name: n8n-workflow-error-resilience
description: Architect production-grade n8n workflows with exponential backoff retries, dead-letter queues, idempotent execution keys, and error trigger routing.
category: devops
keywords:
  - n8n
  - workflow
  - automation
  - resilience
  - retry
  - error-handling
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - search_content
estimatedTokens: 345
outputFormat: markdown
tags:
  - automation
  - n8n
  - subagent-tier
version: 1
---

# Procedure: n8n Workflow Resilience & Error Engineering

Use this procedure when designing or reviewing n8n automation workflows to guarantee zero silent failures, idempotent execution, and resilient API integration.

---

## 1. Resilience Standards for n8n Workflows

1. **Idempotency & Deduplication:**
   - Always derive an `idempotency_key` (e.g. `SHA256(webhook_id + timestamp + payload_hash)`) before triggering downstream side effects.
   - Store processed keys in Redis / SQLite with a 24h TTL; discard duplicate executions immediately.

2. **Retry Policies with Exponential Backoff:**
   - Configure HTTP Request nodes with **Max Tries = 3** and **Wait Between Tries = 2000ms** (exponential backoff).
   - Never retry on 4xx Client Errors (400, 401, 403, 404, 422); retry only on 429 (Rate Limit) and 5xx (Server Errors).

3. **Global Error Trigger & Dead-Letter Queue (DLQ):**
   - Connect every workflow to an **Error Trigger** node that logs failed execution details to a dedicated DLQ channel (Telegram / Sentry) with the payload snapshot and error message.

4. **Rate Limit Throttling:**
   - Insert a **Wait / Split In Batches** node when calling external APIs with strict RPM limits (e.g., Google Places, OpenAI, Stripe).

---

## 2. Output Contract
Return the JSON workflow node configuration pattern or structured n8n step-by-step implementation blueprint.
