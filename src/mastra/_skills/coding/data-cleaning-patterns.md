---
name: data-cleaning-patterns
category: coding
description: >-
  Patterns for data cleaning, deduplication, normalization and validation
  in MongoDB and JavaScript/TypeScript. Covers CRM data cleanup, CSV/JSON
  import normalization, and MongoDB aggregation patterns.
  Trigger: "clean data", "deduplication", "normalize", "fix data quality",
  "import CSV", "data validation", "sanitize records".
keywords: [data cleaning, deduplication, normalization, validation, mongodb, csv, sanitization, data quality]
allowedTools: [db_query, db_write, fs_read_file, fs_write_file, shell_execute]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 2300
outputFormat: markdown
tags: [coding, data, mongodb, cleaning]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Data Cleaning Patterns

> These patterns apply to CRM leads, supplier catalogs, CSV imports, and any
> collection with inconsistent or dirty data.
> Always run `db.query` to assess data quality BEFORE cleaning.

## Step 0: Data Quality Assessment

Before cleaning, profile the data:

```javascript
// Count nulls per field (MongoDB aggregation)
db.query({
  collection: "leads",
  operation: "aggregate",
  pipeline: [
    { $group: {
      _id: null,
      total: { $sum: 1 },
      hasEmail: { $sum: { $cond: [{ $gt: ["$email", null] }, 1, 0] } },
      hasPhone: { $sum: { $cond: [{ $gt: ["$phone", null] }, 1, 0] } },
      hasWebsite: { $sum: { $cond: [{ $gt: ["$website", null] }, 1, 0] } },
    }}
  ]
})
```

**Quality scorecard output:**
```
Total records: 1,247
Email coverage: 934/1,247 (74.9%)
Phone coverage: 612/1,247 (49.1%)
Website coverage: 1,102/1,247 (88.4%)
```

---

## Pattern 1: Deduplication

### Find duplicates by email
```javascript
// MongoDB: find duplicate emails
db.query({
  collection: "leads",
  operation: "aggregate",
  pipeline: [
    { $match: { email: { $ne: null } } },
    { $group: {
      _id: { $toLower: "$email" },
      count: { $sum: 1 },
      ids: { $push: "$id" },
      docs: { $push: { id: "$id", companyName: "$companyName", updatedAt: "$updatedAt" } }
    }},
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ],
  limit: 50
})
```

### TypeScript dedup helper
```typescript
// Dedup array by key — keep newest (highest updatedAt)
function dedupByKey<T extends Record<string, any>>(
  items: T[],
  key: keyof T,
  keepStrategy: 'newest' | 'oldest' | 'most_complete' = 'newest'
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = String(item[key]).toLowerCase().trim();
    const existing = map.get(k);
    if (!existing) { map.set(k, item); continue; }
    if (keepStrategy === 'newest' && item.updatedAt > existing.updatedAt) map.set(k, item);
    if (keepStrategy === 'most_complete') {
      const score = (a: T) => Object.values(a).filter(v => v != null && v !== '').length;
      if (score(item) > score(existing)) map.set(k, item);
    }
  }
  return Array.from(map.values());
}
```

### MongoDB: merge duplicates (keep newest, delete rest)
```javascript
// For each duplicate group: keep highest updatedAt, delete others
db.write({
  collection: "leads",
  operation: "deleteOne",
  filter: { id: { $in: ["id-to-delete-1", "id-to-delete-2"] } },
  confirm: true  // ALWAYS required
})
```

---

## Pattern 2: Normalization

### Phone number normalization
```typescript
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Remove everything except digits and +
  let cleaned = raw.replace(/[^\d+]/g, '');
  // Polish numbers: ensure +48 prefix
  if (cleaned.startsWith('48') && cleaned.length === 11) cleaned = '+' + cleaned;
  if (cleaned.length === 9) cleaned = '+48' + cleaned;
  // Invalid length → null
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}
```

### Email normalization
```typescript
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  // Basic format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}
```

### Company name normalization
```typescript
function normalizeCompanyName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')              // collapse whitespace
    .replace(/\bsp\.\s*z\s*o\.o\./gi, 'sp. z o.o.')  // Polish legal form
    .replace(/\bS\.A\./gi, 'S.A.')
    .replace(/\bsp\.\s*j\./gi, 'sp. j.')
    // Normalize quote styles
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"');
}
```

### URL normalization
```typescript
function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    // Remove trailing slash for homepage
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return null;
  }
}
```

---

## Pattern 3: Validation

### Zod schema for CRM lead validation
```typescript
import { z } from 'zod';

const LeadSchema = z.object({
  companyName: z.string().min(2).max(200),
  email: z.string().email().optional().nullable(),
  phone: z.string().regex(/^\+?[\d\s-]{7,15}$/).optional().nullable(),
  website: z.string().url().optional().nullable(),
  status: z.enum(['research_needed', 'contact_ready', 'contacted', 'qualified', 'archived']),
  region: z.string().optional().nullable(),
  segment: z.enum(['producer', 'restaurant', 'distributor', 'other']).default('producer'),
});

type Lead = z.infer<typeof LeadSchema>;

function validateLead(raw: unknown): { valid: boolean; data?: Lead; errors?: string[] } {
  const result = LeadSchema.safeParse(raw);
  if (result.success) return { valid: true, data: result.data };
  return { valid: false, errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`) };
}
```

### Batch validation report
```typescript
function validateBatch(records: unknown[]): {
  valid: unknown[];
  invalid: Array<{ record: unknown; errors: string[] }>;
  stats: { total: number; valid: number; invalid: number };
} {
  const valid: unknown[] = [];
  const invalid: Array<{ record: unknown; errors: string[] }> = [];
  for (const record of records) {
    const result = validateLead(record);
    if (result.valid) valid.push(result.data);
    else invalid.push({ record, errors: result.errors ?? [] });
  }
  return { valid, invalid, stats: { total: records.length, valid: valid.length, invalid: invalid.length } };
}
```

---

## Pattern 4: Sanitization

### Strip HTML / XSS from text fields
```typescript
function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')           // remove tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
```

### Sanitize import record (CSV/JSON)
```typescript
function sanitizeImportRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      sanitized[key] = stripHtml(value).slice(0, 1000); // truncate extremes
    } else if (value === '' || value === 'NULL' || value === 'null') {
      sanitized[key] = null;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
```

---

## Pattern 5: MongoDB Aggregation Cleaning Queries

### Find records with invalid email format
```javascript
db.query({
  collection: "leads",
  operation: "find",
  filter: {
    email: { $ne: null },
    $expr: { $not: { $regexMatch: { input: "$email", regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ } } }
  },
  limit: 50
})
```

### Normalize empty strings to null (batch)
```javascript
// First: count how many need updating
db.query({ collection: "leads", operation: "count", filter: { phone: "" } })
// Then with confirmation:
db.write({
  collection: "leads",
  operation: "updateMany",
  filter: { phone: "" },
  update: { $set: { phone: null } },
  confirm: true
})
```

### Find records missing required fields
```javascript
db.query({
  collection: "leads",
  operation: "find",
  filter: {
    $or: [
      { companyName: { $exists: false } },
      { companyName: null },
      { companyName: "" }
    ]
  },
  limit: 20
})
```

---

## CSV Import Pipeline

```typescript
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';

async function importCsvLeads(filePath: string): Promise<void> {
  const raw = readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  // 1. Sanitize
  const sanitized = records.map(sanitizeImportRecord);

  // 2. Normalize key fields
  const normalized = sanitized.map(r => ({
    ...r,
    email: normalizeEmail(r.email),
    phone: normalizePhone(r.phone),
    website: normalizeUrl(r.website),
    companyName: normalizeCompanyName(r.companyName ?? r.company_name ?? ''),
  }));

  // 3. Validate
  const { valid, invalid, stats } = validateBatch(normalized);
  console.log(`Import stats: ${stats.valid} valid, ${stats.invalid} invalid`);

  // 4. Dedup within import
  const deduped = dedupByKey(valid as any[], 'email', 'most_complete');

  // 5. Insert (use CRM tool to handle upsert logic)
  for (const record of deduped) {
    // Use crm.create_lead tool for proper upsert handling
  }

  // 6. Report invalid records for manual review
  if (invalid.length > 0) {
    console.log('Invalid records:', JSON.stringify(invalid, null, 2));
  }
}
```

---

## Quality Gates (Definition of Clean)

A "clean" dataset meets these thresholds:

| Metric | Minimum | Target |
|--------|---------|--------|
| Duplicate rate | < 2% | < 0.5% |
| Email validity | > 90% | > 98% |
| Required field coverage | > 95% | 100% |
| Phone normalization | > 80% | > 95% |
| Empty string → null | 100% | 100% |

Run quality assessment before AND after cleaning to verify improvement.
