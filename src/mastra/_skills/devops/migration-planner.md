---
name: migration-planner
category: devops
description: >-
  MongoDB schema migration planning framework. Covers schema diff analysis,
  backward-compatible migration steps, rollback strategy, and migrate-mongo
  usage. Trigger: "migrate schema", "add field to collection", "rename field",
  "schema change", "database migration", "migrate-mongo".
keywords: [mongodb, migration, schema, migrate-mongo, backward-compat, rollback, database]
allowedTools: [db_query, shell_execute, fs_read_file, fs_write_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1750
outputFormat: markdown
tags: [devops, database, migration, mongodb]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Migration Planner — MongoDB

> Follow the Expand-Contract pattern for zero-downtime migrations.
> Never modify existing fields in production without a backward-compat window.
> Always have a tested rollback script before running `migrate-mongo up`.

## When to Use This Skill

- Adding/removing/renaming fields in existing collections
- Changing field types or adding indexes
- Restructuring embedded documents
- Splitting or merging collections
- Seeding initial data into a new collection

---

## Core Principle: Expand-Contract Pattern

```
Phase 1: EXPAND (add, keep old)
  Add new field alongside old field.
  App writes to BOTH, reads from new (with fallback to old).
  Deploy & verify.

Phase 2: MIGRATE (backfill)
  Run migrate-mongo script to populate new field for all existing docs.
  Verify 100% of docs have the new field.

Phase 3: CONTRACT (remove old)
  Remove old field reads from app code.
  Deploy, verify, then remove old field from schema.
  Only now can you drop the old field from DB.
```

**Why?** A direct rename in production breaks the running app before deployment completes.

---

## Step 1: Schema Diff Analysis

Before writing any migration, analyze the change:

```
db.query({ collection: "leads", operation: "findOne" })
```

Document the diff:

```markdown
## Schema Change: leads collection

| Field | Before | After | Impact |
|-------|--------|-------|--------|
| `status` | string (free-text) | enum (required) | HIGH — backfill needed |
| `region` | absent | string (optional) | LOW — new optional field |
| `contactName` | present | rename → `contact.name` | HIGH — nested restructure |

Estimated affected documents: [run db.query count]
Collections: leads (~1200 docs)
Dependencies: sales-agent reads `status`, marketing-agent reads `region`
```

**Questions to answer before proceeding:**
1. Is this a breaking change for any running agent?
2. Can the app run with both old and new schema simultaneously?
3. What is the rollback point if migration fails?

---

## Step 2: Migration Script (migrate-mongo format)

Create file: `src/mastra/scripts/migrations/YYYYMMDD-description.js`

```javascript
// migrations/20250315-add-region-to-leads.js
module.exports = {
  async up(db, client) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        // 1. Add new field with default value
        await db.collection('leads').updateMany(
          { region: { $exists: false } },
          { $set: { region: null } },
          { session }
        );

        // 2. Verify
        const missing = await db.collection('leads').countDocuments(
          { region: { $exists: false } },
          { session }
        );
        if (missing > 0) throw new Error(`${missing} docs still missing 'region' field`);
      });
    } finally {
      await session.endSession();
    }
  },

  async down(db) {
    // Rollback: remove the added field
    await db.collection('leads').updateMany(
      {},
      { $unset: { region: '' } }
    );
  }
};
```

**Script patterns by change type:**

### Add optional field
```javascript
await db.collection('collection').updateMany(
  { newField: { $exists: false } },
  { $set: { newField: null } }
);
```

### Rename field
```javascript
// Step 1: Copy to new name
await db.collection('collection').updateMany(
  { oldField: { $exists: true }, newField: { $exists: false } },
  [{ $set: { newField: '$oldField' } }]
);
// Step 2 (separate migration after deploy): Remove old
await db.collection('collection').updateMany({}, { $unset: { oldField: '' } });
```

### Change type (string → array)
```javascript
await db.collection('collection').updateMany(
  { field: { $type: 'string' } },
  [{ $set: { field: ['$field'] } }]
);
```

### Backfill computed field
```javascript
const cursor = db.collection('leads').find({});
const bulk = db.collection('leads').initializeUnorderedBulkOp();
let count = 0;
for await (const doc of cursor) {
  bulk.find({ _id: doc._id }).updateOne({
    $set: { computedField: computeValue(doc) }
  });
  count++;
  if (count % 500 === 0) await bulk.execute();
}
if (count % 500 !== 0) await bulk.execute();
```

---

## Step 3: Backward-Compat Checklist

Before running `migrate-mongo up`, verify:

- [ ] New field has a safe default (null, [], 0, '') for existing docs
- [ ] All app code reads the new field with fallback to old format
- [ ] No `$required` validators added before backfill is complete
- [ ] Indexes for new field are added AFTER backfill (avoid lock during build)
- [ ] The `down()` function is tested in staging

---

## Step 4: Running the Migration

```bash
# 1. Verify pending migrations
npx migrate-mongo status

# 2. Run in staging first
MONGODB_URI=mongodb://staging:27017/agentforge npx migrate-mongo up

# 3. Verify results
db.query({ collection: "leads", operation: "count", filter: { region: { $exists: false } } })
# → should return 0

# 4. Run in production
npx migrate-mongo up

# 5. Check migrate-mongo history
npx migrate-mongo status
```

**migrate-mongo config** (`migrate-mongo-config.js`):
```javascript
module.exports = {
  mongodb: { url: process.env.MONGODB_URI, options: {} },
  migrationsDir: 'src/mastra/scripts/migrations',
  changelogCollectionName: 'migrations_changelog',
  migrationFileExtension: '.js',
};
```

---

## Step 5: Rollback Strategy

### Automatic rollback (migration fails mid-way)
- Use MongoDB transactions in `up()` — transaction auto-rolls back on error
- Verify with `npx migrate-mongo status` — failed migration stays pending

### Manual rollback
```bash
# Roll back last migration
npx migrate-mongo down

# Verify
npx migrate-mongo status
```

### Emergency rollback (production incident)
```
1. Restore from pre-migration snapshot (if available)
   OR
2. Run down() manually via migrate-mongo down
3. Redeploy previous app version
4. Verify agent functionality
5. Post-incident: analyze why migration failed before retry
```

---

## Safety Rules

1. **Always test in staging first** with a production-size dataset
2. **Never run migrations during peak traffic** — schedule for low-traffic windows
3. **Large collections (>100k docs):** use batched updates with `_id` cursor pagination
4. **Index creation on large collections:** use `{ background: true }` (MongoDB 4.x) or build during off-hours
5. **No transactions for updateMany on sharded collections** — use ordered bulk instead
6. **Keep migration scripts idempotent** — safe to run twice (`{ $exists: false }` guards)

---

## Migration Log Template

After every migration, add to `docs/MIGRATIONS.md`:

```markdown
## 2025-03-15 — Add region field to leads

**Why:** New CRM feature requires geographic filtering
**Collections:** leads
**Type:** Additive (backward-compatible)
**Affected docs:** ~1,200
**Duration:** 2.3s (staging), 4.1s (production)
**Rollback tested:** ✅ Yes
**Deployed:** 2025-03-15 02:00 UTC (low-traffic window)
```
