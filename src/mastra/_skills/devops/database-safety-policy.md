---
name: database-safety-policy
category: devops
description: >-
  MongoDB readonly-first safety policy for agents. Defines when db.query is
  sufficient vs when db.write requires explicit user confirmation.
  Covers query patterns, write escalation flow, and audit trail usage.
  Trigger: any MongoDB access, data inspection, "check the database",
  "update record", "delete", "fix data", "query collection".
keywords: [mongodb, database, readonly, safety, query, write, confirm, audit]
allowedTools: [db_query, db_write]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1200
outputFormat: text
tags: [devops, database, safety, mongodb]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Database Safety Policy

> **Default: read-only.** Any write operation requires explicit user confirmation.
> Every write is permanently logged to `agent_events` collection.

## Core Rules

1. **Always explore first with `db.query`** — understand the data before touching it
2. **Never write without user confirmation** — `db.write` requires `confirm: true`
3. **Show the user what will change** — present the filter + impact count before asking
4. **Log all writes** — automatically done by `db.write`, but note it in your response
5. **Prefer targeted operations** — never `deleteMany({})` on an entire collection

---

## Tool Selection Guide

| Intent | Tool | confirm needed? |
|--------|------|----------------|
| Inspect data | `db.query` | no |
| Count documents | `db.query` (count) | no |
| Search / filter | `db.query` (find) | no |
| Aggregation report | `db.query` (aggregate) | no |
| Add new document | `db.write` (insertOne) | ✅ YES |
| Update a field | `db.write` (updateOne) | ✅ YES |
| Bulk update | `db.write` (updateMany) | ✅ YES |
| Delete document | `db.write` (deleteOne) | ✅ YES |
| Bulk delete | `db.write` (deleteMany) | ✅ YES + extra caution |

---

## Safe Query Patterns

### 1 — Inspect before you act

Always run `db.query` (find/count) first to understand scope:

```
// Step 1: How many would be affected?
db.query({
  collection: "leads",
  operation: "count",
  filter: { status: "inactive", updatedAt: { $lt: new Date("2024-01-01") } }
})
// → e.g. returns count: 47

// Step 2: Preview sample
db.query({
  collection: "leads",
  operation: "find",
  filter: { status: "inactive", updatedAt: { $lt: new Date("2024-01-01") } },
  limit: 3
})
```

### 2 — Always use precise filters

```
// ✅ Good — targeted filter
db.write({
  collection: "leads",
  operation: "updateOne",
  filter: { id: "abc-123" },    // unique ID
  update: { $set: { status: "archived" } },
  confirm: true
})

// ❌ Bad — would match everything
db.write({
  collection: "leads",
  operation: "updateMany",
  filter: {},                    // empty filter = ALL documents
  update: { $set: { status: "archived" } },
  confirm: true
})
```

### 3 — Use $set not document replacement for partial updates

```
// ✅ Good — only changes the specified field
update: { $set: { status: "contacted", updatedAt: new Date() } }

// ❌ Risky — replaces entire document (use replaceOne carefully)
update: { status: "contacted" }   // loses all other fields
```

---

## Write Escalation Flow

When a user asks to modify data, follow this sequence:

```
1. INSPECT
   db.query(find/count) → show user what matches

2. REPORT IMPACT
   "I found 12 leads matching your criteria. This will update their status to 'archived'."

3. GET CONFIRMATION
   "Shall I proceed? Reply 'yes' to confirm."

4. EXECUTE WITH confirm: true
   db.write({ ..., confirm: true })

5. REPORT RESULT
   "Done — 12 leads updated. Logged to agent_events."
```

**For bulk deletes (deleteMany > 10 docs), add extra confirmation:**
> "⚠️ This will permanently delete 47 records. This action cannot be undone. Please confirm."

---

## Prohibited Patterns

These patterns require immediate BLOCK + escalation to user:

```
// 🚫 Full collection wipe
db.write({ operation: "deleteMany", filter: {} })

// 🚫 Dropping system collections
db.write({ collection: "agent_events", operation: "deleteMany", filter: {} })

// 🚫 Modifying auth/credentials collections
db.write({ collection: "users", operation: "updateMany", filter: {} })
```

If asked to perform any of these, respond:
> "I cannot perform this operation without explicit written authorization. 
> Please describe exactly what you need and confirm you understand the risk."

---

## Reading the Audit Log

Every write is logged in `agent_events`:

```
db.query({
  collection: "agent_events",
  operation: "find",
  filter: { type: "db_write" },
  sort: { timestamp: -1 },
  limit: 20
})
```

Log fields: `timestamp`, `collection`, `operation`, `filter`, `update`, `result`, `source`

---

## Common Use Cases

### Fix a CRM lead field
```
// 1. Find it
db.query({ collection: "leads", operation: "findOne", filter: { email: "jan@example.pl" } })
// 2. Update
db.write({ collection: "leads", operation: "updateOne",
  filter: { email: "jan@example.pl" },
  update: { $set: { status: "qualified", region: "Mazowieckie" } },
  confirm: true })
```

### Archive old records
```
// 1. Count
db.query({ collection: "leads", operation: "count", filter: { status: "research_needed", updatedAt: { $lt: "2023-12-31" } } })
// → 23 records
// 2. Show sample (3 docs)
// 3. Ask user to confirm
// 4. Update
db.write({ collection: "leads", operation: "updateMany",
  filter: { status: "research_needed", updatedAt: { $lt: "2023-12-31" } },
  update: { $set: { status: "archived" } },
  confirm: true })
```
