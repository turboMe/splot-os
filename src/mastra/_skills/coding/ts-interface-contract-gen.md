---
name: ts-interface-contract-gen
description: "Use for generate strict TypeScript interfaces and matching Zod validation schemas from raw JSON sample payloads or API responses."
category: coding
keywords:
  - typescript
  - interface
  - zod
  - schema
  - contract
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 202
outputFormat: typescript
tags:
  - typescript
  - types
  - fast-tier
version: 1
---

# Procedure: TypeScript & Zod Contract Generator

Use this procedure to derive strict TypeScript interfaces and production-ready Zod schemas from raw JSON payloads or API responses.

---

## 1. Generation Rules

1. **Type Safety & Strictness:**
   - Avoid `any`. Prefer `unknown`, literal unions, or generic parameters.
   - Properly mark optional fields (`field?: type` & `.optional()`) and nullable fields (`type | null` & `.nullable()`).
   - Use PascalCase for type and schema names (e.g., `UserProfileSchema`, `UserProfile`).

2. **Output Contract:**
   Return a single TypeScript code block with:
   - Zod schema definition (`export const XSchema = z.object({ ... });`).
   - Inferred TypeScript type (`export type X = z.infer<typeof XSchema>;`).
   - Concise JSDoc comments for ambiguous fields.
