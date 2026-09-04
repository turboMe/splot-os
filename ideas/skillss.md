# 🛠️ Plan Implementacji Nowych Skilli — Mastra SkillRegistry

> **Status:** ✅ DONE — Wszystkie 12 skilli zaimplementowane  
> **Data:** 2026-05-09  
> **Cel:** Rozszerzenie rejestru z ~32 → ~44 skilli  
> **Estymacja:** ~6-7h na wszystkie 12 skilli  
> **Postęp:**  
> - ✅ **TIER 1 (P0):** docker-helper, log-analyzer, api-tester, sql-optimizer — DONE  
> - ✅ **TIER 2 (P1):** test-generator, web-scraper, agentic-actions-auditor, prompt-tester — DONE  
> - ✅ **TIER 3 (P2):** bash-standards, cicd-pipeline, k8s-helper, otel-instrumentation — DONE

---

## 📐 Architektura — Jak SkillRegistry Odkrywa Skille

### Automatyczne skanowanie
Scanner w `src/mastra/services/skill-registry.ts` (linia 88+):
- Rekurencyjnie skanuje `src/mastra/_skills/` po `*.md` files
- Parsuje YAML frontmatter → wyciąga `name`, `description`, `keywords`, `category`
- **Kategoria = nazwa folderu** jeśli nie podana w frontmatter (linia 116):
  ```ts
  const category = rawMeta.category || relPath.split('/')[0] || 'general';
  ```
- Tworzy embeddingi z `name + description + keywords` via Ollama `nomic-embed-text`
- **Nowe foldery** (`devops/`, `security/`) zostaną automatycznie odkryte — nie trzeba zmieniać kodu!

### Wymagany Format SKILL.md

```yaml
---
name: skill-name-kebab-case
category: devops                  # musi matchować folder
description: >-
  Krótki opis (1-2 zdania) z "Use when" trigger clause.
  Np. "Use when agent needs to analyze Docker containers..."
keywords: [docker, container, compose, dockerfile, devops]
allowedTools: [shell.execute, fs.read_file]   # opcjonalne
minComplexity: simple                          # opcjonalne: trivial|simple|moderate|complex
estimatedTokens: 12000                        # opcjonalne
outputFormat: text                            # opcjonalne: text|patch|json
tags: [devops, docker]                        # opcjonalne
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# Nazwa Skilla

## Trigger
Kiedy ten skill powinien się aktywować.

## Procedure

### Step 1: ...
### Step 2: ...

## Success criteria
- Co oznacza sukces
```

---

## 📁 Struktura Po Implementacji

```
src/mastra/_skills/
├── coding/          (18 → 22 skille)
│   ├── ... (istniejące 18)
│   ├── api-tester.md          ← NOWY
│   ├── sql-optimizer.md       ← NOWY
│   ├── test-generator.md      ← NOWY
│   └── bash-standards.md      ← NOWY
│
├── devops/          ← NOWY FOLDER (5 skilli)
│   ├── docker-helper.md
│   ├── log-analyzer.md
│   ├── cicd-pipeline.md
│   ├── k8s-helper.md
│   └── otel-instrumentation.md
│
├── security/        ← NOWY FOLDER (1 skill)
│   └── agentic-actions-auditor.md
│
├── meta/            (1 → 2 skille)
│   ├── skill-creator.md (istniejący)
│   └── prompt-tester.md       ← NOWY
│
├── terminal/        (7 skilli — bez zmian)
├── n8n/
└── n8n-blocks/
```

---

## ✅ TIER 1 — Priorytet P0 (Natychmiast) — DONE

---

### 1. `devops/docker-helper.md`

**Źródła:**
- https://github.com/chaterm/terminal-skills → `docker/` (Dockerfile analysis, compose)
- https://github.com/wshobson/agents/blob/main/docs/agent-skills.md → brak bezpośrednio, ale wzorzec formatowania
- https://github.com/CodeAlive-AI/ai-driven-development → docker workflow patterns

**Co powinien umieć:**
- Analiza Dockerfile (multi-stage, layer optimization, security)
- Debugowanie `docker compose` (porty, volumes, networking)
- Inspektowanie running containers (`docker logs`, `docker inspect`, `docker stats`)
- Budowanie i tagowanie obrazów
- Diagnozowanie problemów z siecią Docker
- Clean-up (dangling images, stopped containers)

**Kluczowe komendy do inclusion:**
```bash
docker build -t <tag> .
docker compose up -d / down / logs
docker inspect <container>
docker stats --no-stream
docker system prune -f
docker network ls / inspect
```

**Frontmatter:**
```yaml
---
name: docker-helper
category: devops
description: >-
  Analyze, debug, and manage Docker containers and images. Use when agent
  needs to work with Dockerfiles, docker-compose, inspect running containers,
  debug networking issues, or optimize image builds.
keywords: [docker, container, dockerfile, compose, image, devops, debugging]
allowedTools: [shell.execute, fs.read_file, fs.write_file]
minComplexity: simple
estimatedTokens: 14000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

**Sekcje do napisania:**
1. Trigger (kiedy aktywować)
2. Dockerfile Analysis (anti-patterns, multi-stage, .dockerignore)
3. Compose Debugging (port conflicts, volume mounts, depends_on vs healthcheck)
4. Container Diagnostics (logs, exec, inspect, stats)
5. Network Troubleshooting (bridge vs host, DNS resolution)
6. Image Management (build cache, layer optimization, security scan)
7. Success Criteria

---

### 2. `devops/log-analyzer.md`

**Źródła:**
- https://github.com/chaterm/terminal-skills → log analysis patterns
- https://github.com/dash0hq/agent-skills → OTel-aware telemetry patterns
  - Konkretnie: https://github.com/dash0hq/agent-skills/tree/main/skills
- https://github.com/wshobson/agents → observability patterns (Prometheus, distributed tracing)

**Co powinien umieć:**
- Parsowanie structured logs (JSON, logfmt)
- Analiza `journalctl` (systemd services)
- Docker container logs analysis
- Error/warning pattern detection z `grep`, `awk`, `jq`
- Timeline correlation (kiedy zaczął się problem)
- Log rotation awareness

**Kluczowe komendy:**
```bash
journalctl -u <service> --since "1 hour ago" --no-pager
journalctl -b -1 -p err       # errory z poprzedniego boota
docker logs --tail 200 <container>
cat /var/log/syslog | grep -i error
jq '.level == "error"' app.log
tail -f /var/log/app.log | grep --line-buffered "FATAL\|ERROR"
```

**Frontmatter:**
```yaml
---
name: log-analyzer
category: devops
description: >-
  Parse and analyze application logs, system journals, and container output
  to identify error patterns, correlate events, and perform root cause analysis.
  Use when agent needs to diagnose failures, find error patterns, or triage
  system issues from log data.
keywords: [logs, journalctl, syslog, error, debugging, grep, jq, analysis, observability]
allowedTools: [shell.execute, fs.read_file]
minComplexity: simple
estimatedTokens: 12000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 3. `coding/api-tester.md`

**Źródła:**
- https://github.com/chaterm/terminal-skills → `api-testing/`, `network/curl`
- https://github.com/wshobson/agents → `api-design-principles`, `e2e-testing-patterns`
- https://github.com/alirezarezvani/claude-skills → API testing persona patterns

**Co powinien umieć:**
- Testowanie REST endpoints z `curl` / `httpie`
- Walidacja response codes, headers, body (JSON schema)
- GraphQL query testing
- Authentication flows (Bearer, API key, OAuth2 basic)
- Performance baseline (response time, Content-Length)
- Error scenario testing (4xx, 5xx, timeout)

**Kluczowe komendy:**
```bash
# Basic GET
curl -s -w "\nHTTP %{http_code} | Time: %{time_total}s" https://api.example.com/health

# POST z JSON body
curl -s -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "test"}' | jq .

# GraphQL
curl -s -X POST https://api.example.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ users { id name } }"}'

# Verbose (debug headers)
curl -v https://api.example.com/endpoint 2>&1

# Batch test multiple endpoints
for endpoint in /health /api/v1/users /api/v1/status; do
  echo "Testing $endpoint: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$endpoint)"
done
```

**Frontmatter:**
```yaml
---
name: api-tester
category: coding
description: >-
  Test REST and GraphQL API endpoints using curl/httpie. Validate response
  codes, headers, JSON bodies, authentication flows, and performance baselines.
  Use when agent needs to verify API behavior, debug HTTP requests, or validate
  endpoint contracts.
keywords: [api, rest, graphql, curl, http, testing, endpoint, json, authentication]
allowedTools: [shell.execute, fs.read_file]
minComplexity: simple
estimatedTokens: 10000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 4. `coding/sql-optimizer.md`

**Źródła:**
- https://github.com/wshobson/agents → `sql-optimization-patterns` (★ główne źródło)
  - EXPLAIN analysis, indexing strategies, query rewriting
- https://github.com/chaterm/terminal-skills → `database/` (basic SQL operations)
- https://github.com/alirezarezvani/claude-skills → database optimization patterns

**Co powinien umieć:**
- Analiza `EXPLAIN` / `EXPLAIN ANALYZE` output
- Identyfikacja brakujących indeksów
- Rewriting slow queries (subquery → JOIN, N+1 detection)
- Index advisory (B-tree vs GIN vs GiST)
- Query plan interpretation (Seq Scan, Index Scan, Hash Join, Nested Loop)
- PostgreSQL-specific: `pg_stat_statements`, `auto_explain`
- SQLite/DuckDB basic optimization

**Frontmatter:**
```yaml
---
name: sql-optimizer
category: coding
description: >-
  Analyze and optimize SQL queries using EXPLAIN plans, indexing strategies,
  and query rewriting patterns. Use when agent needs to diagnose slow queries,
  suggest missing indexes, or rewrite inefficient SQL for PostgreSQL, SQLite,
  or DuckDB databases.
keywords: [sql, database, query, explain, index, optimization, postgresql, performance]
allowedTools: [shell.execute, fs.read_file, coding.write_file_tracked]
minComplexity: moderate
estimatedTokens: 15000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

## ✅ TIER 2 — Priorytet P1 (Silne Value-Add) — DONE

---

### 5. `coding/test-generator.md`

**Źródła:**
- https://github.com/wshobson/agents → `javascript-testing-patterns`, `python-testing-patterns`, `e2e-testing-patterns`
- https://github.com/alirezarezvani/claude-skills → test automation personas
- https://github.com/CodeAlive-AI/ai-driven-development → TDD workflows

**Co powinien umieć:**
- Scaffold unit tests z istniejącego kodu (Vitest, Jest, Pytest)
- Generowanie integration test cases
- Edge case detection (null, empty, boundary values)
- Mock/stub generation for dependencies
- Test file placement conventions (`__tests__/`, `*.test.ts`, `*.spec.ts`)
- Coverage gap analysis

**Frontmatter:**
```yaml
---
name: test-generator
category: coding
description: >-
  Generate unit and integration tests from existing source code. Scaffolds
  test files with edge cases, mocks, and assertions for Vitest, Jest, or Pytest.
  Use when agent needs to add test coverage to untested code or create test
  suites for new functionality.
keywords: [test, unit-test, vitest, jest, pytest, testing, mock, coverage, tdd]
allowedTools: [fs.read_file, coding.write_file_tracked, shell.execute]
minComplexity: moderate
estimatedTokens: 14000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 6. `coding/web-scraper.md`

**Źródła:**
- https://github.com/chaterm/terminal-skills → `web-scraping/` (curl + parsing)
- Wcześniejszy audyt: validated web-scraper skill z anti-bot patterns
  - Sprawdź step 695 w logach konwersacji po pełną treść

**Co powinien umieć:**
- URL → structured data extraction (curl + cheerio-like parsing)
- HTML → JSON/CSV pipeline
- Anti-bot awareness (User-Agent, rate limiting, robots.txt check)
- Headless browser fallback (Playwright hint)
- Pagination handling
- Data cleaning and normalization

**Frontmatter:**
```yaml
---
name: web-scraper
category: coding
description: >-
  Extract structured data from web pages using curl, wget, and text processing.
  Handles pagination, anti-bot headers, and data normalization into JSON/CSV.
  Use when agent needs to scrape web content, extract data from HTML pages,
  or build ETL pipelines from web sources.
keywords: [scraping, web, curl, html, extraction, parsing, etl, data]
allowedTools: [shell.execute, fs.write_file, fs.read_file]
minComplexity: moderate
estimatedTokens: 12000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 7. `security/agentic-actions-auditor.md`

**Źródła:**
- https://github.com/trailofbits/skills/blob/main/plugins/agentic-actions-auditor/skills/agentic-actions-auditor/SKILL.md
  - ★ **Near-complete source** — można prawie 1:1 zaadaptować
- Sprawdź step 718 w logach konwersacji po pełną analizę

**Co powinien umieć:**
- Audyt CI/CD pipeline configurations pod kątem agentic attacks
- Wykrywanie prompt injection vectors w workflow YAML
- Sprawdzanie permission escalation w GitHub Actions / GitLab CI
- Secrets exposure detection
- Supply chain attack vectors (untrusted actions, malicious dependencies)

**UWAGA:** Ten skill jest prawie gotowy ze źródła TrailOfBits. Główna adaptacja to:
1. Zmienić frontmatter na nasz format (dodać `category: security`, `keywords`)
2. Dodać `success_rate`, `total_uses`, `last_used` fields
3. Sprawdzić czy `allowedTools` matchują nasze nazwy narzędzi

**Frontmatter:**
```yaml
---
name: agentic-actions-auditor
category: security
description: >-
  Audit CI/CD pipelines and agentic workflows for security vulnerabilities
  including prompt injection vectors, permission escalation, secrets exposure,
  and supply chain attack patterns. Use when reviewing GitHub Actions, GitLab CI,
  or any AI-driven automation pipeline for security risks.
keywords: [security, audit, cicd, github-actions, prompt-injection, supply-chain, pipeline]
allowedTools: [fs.read_file, shell.execute, search_content]
minComplexity: moderate
estimatedTokens: 16000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 8. `meta/prompt-tester.md`

**Źródła:**
- https://github.com/alirezarezvani/claude-skills → prompt engineering & evaluation patterns
- https://github.com/wshobson/agents → `prompt-engineering-patterns`, `llm-evaluation`
- Sprawdź step 696 w logach konwersacji po validated content

**Co powinien umieć:**
- Systematic LLM output evaluation (consistency, accuracy, format compliance)
- A/B prompt comparison methodology
- Scoring rubric generation
- Edge case prompt testing (adversarial, ambiguous, multilingual)
- Regression detection (output drift over prompt changes)
- Token efficiency analysis

**Frontmatter:**
```yaml
---
name: prompt-tester
category: meta
description: >-
  Systematically evaluate LLM prompt quality through structured testing.
  Compare prompt variations, score outputs on consistency/accuracy/format,
  detect regressions, and optimize token efficiency. Use when developing,
  refining, or auditing prompts for agentic workflows.
keywords: [prompt, testing, evaluation, llm, quality, regression, scoring, optimization]
allowedTools: [shell.execute, fs.read_file, fs.write_file]
minComplexity: moderate
estimatedTokens: 13000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

## ✅ TIER 3 — Priorytet P2 (Strategiczne Rozszerzenie) — DONE

---

### 9. `coding/bash-standards.md`

**Źródła:**
- https://github.com/bentsolheim/claude-skill-bash ← ★ **Główne źródło (1000+ linii)**
  - `SKILL.md` — pełne best practices
  - `templates/script-template.sh` — reusable template
  - `scripts/scaffold.sh` — generator utility
- Google Shell Style Guide (referenced in repo)

**Co powinien umieć:**
- Main function pattern z guard clause
- Comprehensive usage documentation generation
- Argument parsing (getopts pattern)
- Dependency validation
- Error handling (explicit, no `set -e`)
- Colored output utilities
- Simple vs Ordinary script discrimination (<30 lines)

**UWAGA:** Bentsolheim dostarcza prawie kompletny SKILL.md. Adaptacja:
1. Zmienić frontmatter na nasz format
2. Skrócić do ~200 linii (z 1000+) — zachować wzorce, usunąć verbose examples
3. Dodać nasze `keywords`, `category: coding`

**Frontmatter:**
```yaml
---
name: bash-standards
category: coding
description: >-
  Enforce enterprise-grade bash scripting best practices including main function
  patterns, argument parsing, error handling, dependency validation, and colored
  output. Use when creating or reviewing bash/shell scripts for production use.
keywords: [bash, shell, script, best-practices, error-handling, getopts, template]
allowedTools: [fs.read_file, coding.write_file_tracked, shell.execute]
minComplexity: simple
estimatedTokens: 18000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 10. `devops/cicd-pipeline.md`

**Źródła:**
- https://github.com/wshobson/agents → `github-actions-templates`, `gitlab-ci-patterns`, `deployment-pipeline-design`
- https://github.com/chaterm/terminal-skills → CI/CD debugging patterns
- Sprawdź step 694 w logach konwersacji po validated cicd-pipeline content

**Co powinien umieć:**
- GitHub Actions workflow generation (build, test, deploy)
- GitLab CI pipeline templates
- Multi-stage pipeline design (lint → test → build → deploy)
- Secrets management patterns
- Cache optimization (node_modules, pip cache, Docker layers)
- Matrix testing strategies
- Conditional deployment (staging vs production)

**Frontmatter:**
```yaml
---
name: cicd-pipeline
category: devops
description: >-
  Generate and optimize CI/CD pipeline configurations for GitHub Actions,
  GitLab CI, and similar platforms. Includes multi-stage workflows, caching,
  matrix testing, and deployment strategies. Use when setting up, debugging,
  or optimizing continuous integration and deployment pipelines.
keywords: [cicd, github-actions, gitlab-ci, pipeline, deployment, workflow, automation]
allowedTools: [fs.read_file, coding.write_file_tracked, shell.execute]
minComplexity: moderate
estimatedTokens: 16000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 11. `devops/k8s-helper.md`

**Źródła:**
- https://github.com/chaterm/terminal-skills → `kubernetes/` (kubectl, pods, services)
- https://github.com/wshobson/agents → `k8s-manifest-generator`, `helm-chart-scaffolding`, `k8s-security-policies`

**Co powinien umieć:**
- Manifest generation (Deployment, Service, ConfigMap, Secret)
- Helm chart scaffolding basics
- `kubectl` diagnostics (describe, logs, exec, port-forward)
- Pod troubleshooting (CrashLoopBackOff, ImagePullBackOff, OOMKilled)
- Resource limits/requests sizing
- Namespace management

**Frontmatter:**
```yaml
---
name: k8s-helper
category: devops
description: >-
  Generate Kubernetes manifests, debug pod issues, and manage cluster resources
  using kubectl. Covers Deployments, Services, ConfigMaps, Helm basics, and
  common troubleshooting patterns. Use when working with Kubernetes clusters,
  creating manifests, or diagnosing pod/service issues.
keywords: [kubernetes, k8s, kubectl, helm, manifest, pod, deployment, container-orchestration]
allowedTools: [shell.execute, fs.read_file, coding.write_file_tracked]
minComplexity: moderate
estimatedTokens: 16000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

### 12. `devops/otel-instrumentation.md`

**Źródła:**
- https://github.com/dash0hq/agent-skills ← ★ **Główne źródło**
  - Skills: `otel-collector-config`, `instrument-nodejs`, `instrument-python`, `instrument-java`, `instrument-go`
  - Wszystkie pod Apache 2.0 license
- https://github.com/wshobson/agents → `distributed-tracing`, `prometheus-configuration`, `slo-implementation`

**Co powinien umieć:**
- OpenTelemetry SDK setup (Node.js, Python)
- Collector configuration (receivers, processors, exporters)
- Auto-instrumentation patterns
- Custom span creation
- Metric collection (counter, histogram, gauge)
- Trace context propagation
- Integration z Grafana/Jaeger/Prometheus

**UWAGA:** Dash0 dostarcza wysoce jakościowe SKILL.md per language. Zsyntetyzować w 1 unified skill z sekcjami per-runtime.

**Frontmatter:**
```yaml
---
name: otel-instrumentation
category: devops
description: >-
  Set up OpenTelemetry instrumentation for applications including SDK
  initialization, auto-instrumentation, custom spans/metrics, and Collector
  configuration. Use when adding observability to Node.js, Python, Go, or
  Java applications, or configuring telemetry pipelines.
keywords: [opentelemetry, otel, tracing, metrics, observability, instrumentation, grafana, jaeger]
allowedTools: [fs.read_file, coding.write_file_tracked, shell.execute]
minComplexity: moderate
estimatedTokens: 18000
version: 1
success_rate: null
total_uses: 0
last_used: null
---
```

---

## ⚙️ Instrukcje Implementacji (Step-by-Step)

### Krok 1: Utwórz nowe foldery
```bash
mkdir -p src/mastra/_skills/devops
mkdir -p src/mastra/_skills/security
```

### Krok 2: Twórz skille w kolejności P0 → P1 → P2
Dla każdego skilla:
1. Utwórz plik `.md` w odpowiednim folderze
2. Wstaw frontmatter (kopiuj z tego planu)
3. Napisz pełną procedurę (Trigger → Steps → Success Criteria)
4. Wzoruj się na istniejących skillach:
   - Prosty wzorzec: `coding/fix-typescript-error.md` (64 linie)
   - Złożony wzorzec: `terminal/agentic-terminal-problem-solving.md` (55 linii)
   - Pełny wzorzec: `coding/security-best-practices.md` (duży, z referencjami)

### Krok 3: Zweryfikuj parsowanie
```bash
# Po dodaniu skilli, sprawdź czy registry je widzi
cd /projekty/mastra-agentic-environment/agentic-agents
npx tsx -e "
  const { getSkillRegistry } = await import('./src/mastra/services/skill-registry.js');
  const reg = getSkillRegistry();
  await reg.initialize('./src/mastra/_skills');
  console.log('Categories:', reg.categories());
  console.log('Total skills:', reg.list().length);
"
```

### Krok 4: Test semantic search
```bash
npx tsx -e "
  const { getSkillRegistry } = await import('./src/mastra/services/skill-registry.js');
  const reg = getSkillRegistry();
  await reg.initialize('./src/mastra/_skills');
  const results = await reg.search('docker container debugging');
  console.log(results.map(r => r.metadata.name));
"
```

### Krok 5: Sprawdź subtask-executor mapping
W `src/mastra/services/subtask-executor.ts` (linia 524):
```ts
category: role.roleId === 'file-editor' ? 'coding' : undefined,
```
→ Upewnij się, że nowe role (jeśli dodane) mapują na odpowiednie kategorie.

---

## 📚 Pełna Lista Źródeł z Linkami

### Główne repozytoria
| Repo | Link | Licencja | Użyte do |
|------|------|----------|----------|
| chaterm/terminal-skills | https://github.com/chaterm/terminal-skills | MIT | docker, log-analyzer, api-tester, k8s, web-scraper |
| wshobson/agents | https://github.com/wshobson/agents/blob/main/docs/agent-skills.md | MIT | sql-optimizer, test-generator, cicd-pipeline, k8s |
| alirezarezvani/claude-skills | https://github.com/alirezarezvani/claude-skills | MIT | prompt-tester, test patterns |
| dash0hq/agent-skills | https://github.com/dash0hq/agent-skills | Apache-2.0 | otel-instrumentation, log patterns |
| trailofbits/skills | https://github.com/trailofbits/skills | Apache-2.0 | agentic-actions-auditor |
| bentsolheim/claude-skill-bash | https://github.com/bentsolheim/claude-skill-bash | MIT | bash-standards |
| CodeAlive-AI/ai-driven-development | https://github.com/CodeAlive-AI/ai-driven-development | MIT | docker patterns, meta workflows |

### Repozytoria referencyjne (nie importujemy, ale warte studiowania)
| Repo | Link | Wartość |
|------|------|---------|
| joshrotenberg/skillet | https://github.com/joshrotenberg/skillet | MCP skill discovery, persistent cache pattern |
| iamfakeguru/agent-md | https://github.com/iamfakeguru/agent-md | Agent directive contracts, memory/ system |
| VoltAgent/awesome-agent-skills | https://github.com/VoltAgent/awesome-agent-skills | Awesome-list, indeks ekosystemu |
| TerminalSkills/skills | https://github.com/TerminalSkills/skills | Bazowe terminale (pokryte przez nasze) |
| claude-office-skills/skills | https://github.com/claude-office-skills/skills | Google Docs/Sheets (osobna integracja) |

---

## 🔮 Przyszłe Rozszerzenia (backlog)

Po implementacji 12 skilli, rozważ:

1. **Embedding Cache** — persist embeddings to disk (see `ideas/skill-registry-improvements.md`)
2. **`agents-consilium`** pattern z CodeAlive-AI — multi-agent debate for code review
3. **`mcp-management`** skill — dynamiczne zarządzanie MCP connections
4. **Skillet integration** — ewentualnie podpiąć jako fallback discovery
5. **Agent-MD memory/** pattern — formalizacja progress tracking w naszym systemie

---

## ⚠️ Znane Ryzyka

1. **Embedding space pollution** — 44 skilli to wciąż bezpiecznie pod progiem ~100 (patrz `skill-registry-improvements.md`)
2. **Ollama timeout** — przy starcie z 44 skillami, generowanie embeddingów może trwać ~15s (vs ~8s dla 32). Monitor.
3. **Keyword overlap** — `docker` i `container` mogą matchować zarówno `docker-helper` jak i `k8s-helper`. Rozwiązanie: precyzyjne description z "Use when" clauses.
4. **Brak testów** — każdy nowy skill powinien mieć minimalny smoke test (search query → correct match).
