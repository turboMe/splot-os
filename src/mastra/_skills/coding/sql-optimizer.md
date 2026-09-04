---
name: sql-optimizer
category: coding
description: >-
  Analyze and optimize SQL queries using EXPLAIN plans, indexing strategies,
  and query rewriting patterns. Use when agent needs to diagnose slow queries,
  suggest missing indexes, or rewrite inefficient SQL for PostgreSQL, SQLite,
  or DuckDB databases.
keywords: [sql, database, query, explain, index, optimization, postgresql, performance]
allowedTools: [shell_execute, fs_read_file, coding_write_file_tracked]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1300
outputFormat: text
tags: [coding, sql, database, performance]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# SQL Optimizer

## Trigger
Agent encounters slow database queries, needs to analyze query plans,
suggest indexes, or rewrite inefficient SQL.

## Procedure

### Step 1: Capture the query plan

**PostgreSQL:**
```sql
-- Basic plan (estimated costs)
EXPLAIN SELECT * FROM orders WHERE customer_id = 42;

-- Full execution plan with timing (run the query)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT * FROM orders WHERE customer_id = 42;

-- JSON format for programmatic analysis
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE customer_id = 42;
```

**SQLite:**
```sql
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer_id = 42;
```

**DuckDB:**
```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 42;
```

### Step 2: Interpret the query plan

**Red flags in PostgreSQL plans:**
| Pattern | Problem | Fix |
|---------|---------|-----|
| `Seq Scan` on large table | Full table scan | Add index on filter/join columns |
| `Nested Loop` with large outer | O(n²) join | Use Hash Join or Merge Join |
| `Sort` with high cost | Expensive sort | Add index matching ORDER BY |
| `Hash Join (Batches: N)` where N>1 | Insufficient `work_mem` | Increase `work_mem` or optimize query |
| `Rows Removed by Filter: high` | Scanning too many rows | Narrow filter, add partial index |
| `actual rows` ≫ `estimated rows` | Bad statistics | Run `ANALYZE table_name` |

**Good patterns:**
- `Index Scan` / `Index Only Scan` → Using index efficiently
- `Bitmap Index Scan` → Good for medium selectivity
- `Hash Join` → Efficient for large joins with good memory

### Step 3: Identify missing indexes

**Rules for when to add indexes:**
1. **WHERE clause columns** used in frequent queries
2. **JOIN columns** (foreign keys especially)
3. **ORDER BY / GROUP BY** columns in frequent sorts
4. **Unique constraints** already create indexes (don't duplicate)

**Index types (PostgreSQL):**
```sql
-- B-tree (default, most common)
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- Composite index (column order matters: most selective first)
CREATE INDEX idx_orders_cust_date ON orders (customer_id, created_at DESC);

-- Partial index (filter to reduce size)
CREATE INDEX idx_orders_active ON orders (status) WHERE status = 'active';

-- GIN (for JSONB, arrays, full-text)
CREATE INDEX idx_data_gin ON items USING gin (metadata);

-- Expression index
CREATE INDEX idx_lower_email ON users (lower(email));

-- Covering index (Index Only Scan)
CREATE INDEX idx_orders_cover ON orders (customer_id) INCLUDE (total, status);
```

### Step 4: Rewrite slow queries

**Common rewrites:**

**Subquery → JOIN:**
```sql
-- Slow: correlated subquery
SELECT * FROM orders o
WHERE o.total > (SELECT AVG(total) FROM orders WHERE customer_id = o.customer_id);

-- Fast: JOIN with aggregate CTE
WITH avg_by_customer AS (
  SELECT customer_id, AVG(total) as avg_total
  FROM orders GROUP BY customer_id
)
SELECT o.* FROM orders o
JOIN avg_by_customer a ON o.customer_id = a.customer_id
WHERE o.total > a.avg_total;
```

**N+1 detection and fix:**
```sql
-- Bad: N+1 (one query per order in app code)
SELECT * FROM orders WHERE customer_id = ?;  -- repeated N times

-- Good: single batch query
SELECT * FROM orders WHERE customer_id = ANY($1::int[]);
-- Or with JOIN
SELECT o.* FROM orders o JOIN customers c ON o.customer_id = c.id
WHERE c.region = 'EU';
```

**DISTINCT → EXISTS:**
```sql
-- Slow: DISTINCT on large result
SELECT DISTINCT c.* FROM customers c JOIN orders o ON c.id = o.customer_id;

-- Fast: EXISTS (stops at first match)
SELECT c.* FROM customers c WHERE EXISTS (
  SELECT 1 FROM orders o WHERE o.customer_id = c.id
);
```

**Pagination optimization:**
```sql
-- Slow: OFFSET on large tables
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 10000;

-- Fast: keyset pagination
SELECT * FROM orders WHERE created_at < $last_seen_timestamp
ORDER BY created_at DESC LIMIT 20;
```

### Step 5: Monitor and validate

**PostgreSQL monitoring queries:**
```sql
-- Top slow queries (requires pg_stat_statements)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;

-- Table bloat check
SELECT schemaname, relname, n_live_tup, n_dead_tup,
  round(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 2) as dead_pct
FROM pg_stat_user_tables WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;

-- Index usage stats
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes ORDER BY idx_scan DESC;

-- Unused indexes (candidates for removal)
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

**After optimization:** Re-run `EXPLAIN ANALYZE` and compare:
- Execution time (should decrease)
- Rows scanned (should decrease)
- Plan type (Seq Scan → Index Scan)

## Success criteria
- Query execution time reduced measurably
- EXPLAIN shows Index Scan instead of Seq Scan where appropriate
- No unnecessary indexes added (each index has a clear justification)
- No N+1 query patterns remain
- Statistics are up-to-date (`ANALYZE` run if needed)
