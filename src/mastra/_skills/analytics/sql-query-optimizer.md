---
name: sql-query-optimizer
description: "Use for optimize SQL queries, analyze EXPLAIN ANALYZE execution plans, design composite indexes, and eliminate N+1 bottlenecks."
category: analytics
keywords:
  - sql
  - postgresql
  - optimization
  - index
  - database
  - explain
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 287
outputFormat: markdown
tags:
  - database
  - sql
  - reasoning-tier
version: 1
---

# Procedure: SQL Query & Index Optimizer

Use this procedure to analyze slow database queries, evaluate execution plans, and formulate high-efficiency indexing strategies.

---

## 1. Optimization Checklist

1. **Table Scan Elimination:**
   - Detect sequential scans on large tables and recommend B-Tree / GIN indexes.
   - For multi-column filtering/sorting, propose composite indexes following the Equality-Range-Sort (ESR) rule.

2. **Subquery & Join Optimization:**
   - Convert correlated subqueries to explicit `JOIN`s or CTEs (`WITH` clauses).
   - Eliminate `SELECT *` in favor of targeted column selection to enable Index-Only Scans.

3. **Pagination Bottlenecks:**
   - Replace high-offset pagination (`LIMIT 50 OFFSET 10000`) with cursor-based keyset pagination (`WHERE id > last_seen_id LIMIT 50`).

---

## 2. Output Contract

```markdown
### 🗄️ SQL Optimization Report

- **Estimated Cost Reduction:** X%
- **Scan Type:** [Seq Scan -> Index Scan]

#### Recommended SQL & Index:
```sql
-- Optimized Query
...
-- Recommended DDL Index
CREATE INDEX CONCURRENTLY idx_users_status_created ON users (status, created_at DESC);
```
```
