---
name: api-and-interface-design
description: "Use for contract-first API design, adhering to Hyrum's Law, robust error semantics, boundary validation, and idempotency guarantees."
category: coding
keywords:
  - api
  - interface
  - contract
  - restful
  - hyrum-law
  - design
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 329
outputFormat: markdown
tags:
  - api
  - architecture
  - reasoning-tier
version: 1
---

# Procedure: API & Interface Design

Use this procedure (from Addy Osmani's API and Interface Design principles) to design clean, robust, and future-proof HTTP/REST, gRPC, or TypeScript interfaces.

---

## 1. Core Principles

1. **Explicit Error Semantics:**
   - Define structured typed errors (`code`, `message`, `details`, `retryable`) rather than unstructured strings.
   - Use standard HTTP status codes (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Rate Limited, 500 Internal Error).

2. **Idempotency & Boundary Validation:**
   - Guarantee idempotency for mutative operations (e.g. `Idempotency-Key` headers on POST/PUT).
   - Validate and sanitize all inputs at system boundaries using Zod/JSONSchema before passing to internal services.

3. **Hyrum's Law Mindfulness:**
   - Assume every observable behavior (ordering, timing, extra fields) will eventually be depended upon by consumers. Lock down contracts strictly.

---

## 2. Output Contract

```markdown
### 🌐 API Contract Design

- **Endpoint:** `METHOD /api/v1/resource`
- **Idempotency:** [YES / NO - mechanism]

#### Request Schema:
```typescript
// Zod schema for request
```

#### Response & Error Payloads:
```typescript
// Success (200/201) and Typed Error schemas
```
```
