---
name: api-tester
category: coding
description: >-
  Test REST and GraphQL API endpoints using curl/httpie. Validate response
  codes, headers, JSON bodies, authentication flows, and performance baselines.
  Use when agent needs to verify API behavior, debug HTTP requests, or validate
  endpoint contracts.
keywords: [api, rest, graphql, curl, http, testing, endpoint, json, authentication]
allowedTools: [shell_execute, fs_read_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 900
outputFormat: text
tags: [coding, api, testing, http]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# API Tester

## Trigger
Agent needs to test API endpoints, verify HTTP responses, debug request
failures, or validate endpoint contracts.

## Procedure

### Step 1: Identify the endpoint
Gather:
- **Method:** GET, POST, PUT, PATCH, DELETE
- **URL:** Full endpoint URL including path and query params
- **Auth:** Bearer token, API key, Basic auth, or none
- **Body:** JSON payload for POST/PUT/PATCH
- **Expected:** Status code, response shape, headers

### Step 2: Construct and execute the request

**Basic GET with diagnostics:**
```bash
curl -s -w "\n--- Diagnostics ---\nHTTP %{http_code} | Time: %{time_total}s | Size: %{size_download} bytes\n" \
  -H "Accept: application/json" \
  "https://api.example.com/health"
```

**POST with JSON body:**
```bash
curl -s -X POST "https://api.example.com/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "test", "email": "test@example.com"}' | jq .
```

**PUT/PATCH:**
```bash
curl -s -X PATCH "https://api.example.com/users/123" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "updated"}' | jq .
```

**DELETE:**
```bash
curl -s -X DELETE "https://api.example.com/users/123" \
  -H "Authorization: Bearer $TOKEN" \
  -w "\nHTTP %{http_code}\n"
```

**GraphQL:**
```bash
curl -s -X POST "https://api.example.com/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "{ users { id name email } }"}' | jq .
```

### Step 3: Debug failing requests

**Verbose mode (see headers, TLS, redirects):**
```bash
curl -v "https://api.example.com/endpoint" 2>&1
```

**Include response headers:**
```bash
curl -s -i "https://api.example.com/endpoint"
```

**Follow redirects:**
```bash
curl -s -L -w "\nFinal URL: %{url_effective}\nRedirects: %{num_redirects}\n" \
  "https://api.example.com/old-endpoint"
```

**Common failure patterns:**
| Code | Meaning | Check |
|------|---------|-------|
| 401 | Unauthorized | Token expired or missing? |
| 403 | Forbidden | Correct permissions/role? |
| 404 | Not Found | URL path correct? API version? |
| 422 | Validation Error | Check request body schema |
| 429 | Rate Limited | Check `Retry-After` header |
| 500 | Server Error | Check server logs |
| 502/503 | Gateway Error | Service down or starting? |

### Step 4: Validate response

**Check JSON structure with jq:**
```bash
# Verify required fields exist
curl -s "https://api.example.com/users/1" | jq '{
  has_id: has("id"),
  has_name: has("name"),
  has_email: has("email"),
  type_check: (.id | type == "number")
}'

# Validate array response
curl -s "https://api.example.com/users" | jq '{
  count: length,
  first: .[0],
  all_have_id: (map(has("id")) | all)
}'
```

### Step 5: Batch test multiple endpoints

```bash
# Health check sweep
for endpoint in /health /api/v1/status /api/v1/users; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$endpoint")
  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
    echo "✅ $endpoint → $status"
  else
    echo "❌ $endpoint → $status"
  fi
done
```

### Step 6: Performance baseline

```bash
# Measure response time (repeat 5 times)
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "%{time_total}\n" "https://api.example.com/endpoint"
done | awk '{sum+=$1; n++} END {printf "Avg: %.3fs (n=%d)\n", sum/n, n}'
```

## Success criteria
- All tested endpoints return expected status codes
- Response JSON matches expected schema
- Authentication flows work correctly
- Response times are within acceptable bounds
- Error scenarios (4xx, 5xx) are properly handled by the API
