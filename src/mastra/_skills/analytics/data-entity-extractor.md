---
name: data-entity-extractor
description: Use for rapidly extract structured business entities (Company, Tax IDs, Polish NIP/REGON/KRS, emails, phones, amounts, dates) into clean JSON.
category: analytics
keywords: ["entity", "extraction", "nip", "email", "crm", "regex"]
minComplexity: trivial
recommendedTier: fast
preferLocal: true
estimatedTokens: 318
outputFormat: raw-json
tags: ["extraction", "crm", "fast-tier"]
version: 1
success_rate: 1
total_uses: 2
last_used: 2026-09-04
---

# Procedure: Data Entity Extractor

Use this procedure for rapid, deterministic extraction of contact, tax, and financial entities from CRM notes, raw emails, web footers, and inquiries.

---

## 1. Execution Rules

1. **Output Contract:**
   - Return ONLY a raw JSON object matching the schema below.
   - Set missing fields to `null` or empty arrays `[]`.
   - Do NOT include markdown wrappers (` ```json `) or preamble text.

2. **Output JSON Schema:**
   ```json
   {
     "company_name": string | null,
     "tax_id": string | null,
     "registration_id": string | null,
     "emails": string[],
     "phones": string[],
     "addresses": [
       {
         "street": string | null,
         "city": string | null,
         "postal_code": string | null,
         "country": string | null
       }
     ],
     "financials": [
       {
         "amount": number,
         "currency": string,
         "context": string
       }
     ],
     "dates": string[],
     "persons": string[]
   }
   ```

3. **Normalization Rules:**
   - Polish NIP: Normalize to 10 consecutive digits (e.g., `PL5252627888` -> `5252627888` or preserve country prefix).
   - Phone numbers: Format as E.164 standard (e.g., `+48123456789`).
   - Dates: Normalize to ISO 8601 (`YYYY-MM-DD`).
