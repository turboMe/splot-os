# Skill Registry — Ulepszenia Architektoniczne

> Status: 📋 Backlog | Data: 2026-05-09 | Powiązane: `src/mastra/services/skill-registry.ts`

## Kontekst

Registry aktualnie ma 32 skille. System działa poprawnie, ale przy planowanym
wzroście do 50-100+ skilli pojawią się bottlenecki. Poniżej lista ulepszeń
uporządkowana wg priorytetów.

## 1. Embedding Cache (JSON file) — 🟡 Medium Priority

**Problem**: Embeddingi generowane od zera przy każdym restarcie Mastra.
- 32 skille × ~200ms = ~6s startup
- Jeśli Ollama offline → 32 × 30s timeout = katastrofalne opóźnienie

**Rozwiązanie**: Cache embeddings do `.skill-embeddings.json`:
```typescript
// Schemat cache:
{
  "model": "bge-m3",
  "version": 1,
  "embeddings": {
    "fix-typescript-error": {
      "hash": "sha256-of-search-text",
      "vector": [0.123, ...],
      "generated": "2026-05-09"
    }
  }
}
```

**Logika**:
1. Przy starcie: wczytaj cache → porównaj hash metadata z każdego skilla
2. Jeśli hash się zgadza → użyj cached embedding (0ms zamiast 200ms)
3. Jeśli hash się zmienił lub brak → wygeneruj nowy, zapisz do cache
4. Jeśli Ollama offline → użyj stale cache (lepsze niż keyword fallback)

**Efekt**: Restart Mastra <1s zamiast 6s+. Odporność na Ollama offline.

**Effort**: ~20 min implementacji

**Kiedy**: Przy 50+ skillach lub gdy startup time stanie się odczuwalny.

## 2. Szybszy Timeout na Embedding — 🟢 Quick Win

**Problem**: Domyślny `AbortSignal.timeout(30_000)` w embedder.ts.
Jeśli Ollama nie odpowiada, każdy skill czeka 30s → 32 × 30s = 16 minut.

**Rozwiązanie**: Dodać skill-specific timeout (3-5s zamiast 30s):
```typescript
// W _generateSkillEmbedding:
signal: AbortSignal.timeout(5_000), // 5s max per skill
```

**Effort**: 5 min (jedna linia)

**Kiedy**: Można zrobić natychmiast, ale Promise.allSettled() łapie błędy,
więc nie blokuje — pytanie tylko o czas oczekiwania.

## 3. Embedding z Body — ⚪ Nie robić

**Dlaczego**: Body to 100-300 linii Markdown — za dużo na jeden embedding.
Chunking body → wiele embeddingów per skill = overengineering dla <100 skilli.
Obecny model (description + keywords + tags) daje wystarczającą precyzję.

**Kiedy**: Dopiero przy 200+ skilli z overlapping keywords.

## 4. Lepsze opisy starszych skilli — ⚪ Niepotrzebne

Stare skille (fix-typescript-error, safe-file-edit, run-verification)
mają krótkie ale **precyzyjne** opisy. Krótki opis ≠ zły opis.
Agent szukający "fix typescript compilation error" trafia poprawnie
dzięki keywords [typescript, tsc, compilation, type-error].

**Kiedy**: Dopiero jeśli pojawią się collisions (dwa skille o zbliżonych keywords
i agent wybiera złego).

## 5. Persistence Backend (DuckDB/SQLite) — ⚪ Odroczone

Przy 200+ skillach JSON cache nie wystarczy — wtedy warto
przenieść embeddings do DuckDB (który już mamy) jako tabela vectorowa.
To daje ANN search zamiast brute-force cosine similarity.

**Kiedy**: 200+ skilli. Prawdopodobnie nigdy w obecnej skali.

## Podsumowanie priorytetów

| # | Zmiana | Effort | Impact | Trigger |
|---|--------|:------:|:------:|---------|
| 1 | Embedding JSON cache | 20 min | ⭐⭐⭐ | 50+ skilli lub startup > 10s |
| 2 | Timeout 30s → 5s | 5 min | ⭐⭐ | Natychmiast (quick win) |
| 3 | Body w embeddingu | — | — | Nigdy (overengineering) |
| 4 | Lepsze opisy starych | — | — | Collision detection |
| 5 | DuckDB vector store | 2h | ⭐ | 200+ skilli |

## Metryki do śledzenia

Przy dodawaniu nowych skilli monitorować:
- `[SkillRegistry] Initialized: X skills, Y with embeddings` → Y powinno = X
- Startup time (czas od uruchomienia do "Initialized")
- Czy `skill.search` zwraca sensowne wyniki (testować manualnie co ~10 nowych skilli)
