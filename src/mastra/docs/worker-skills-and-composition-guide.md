# Przewodnik Architektury: Multi-Skill Workers & Procedury SOP (SOTA 2026)

## 1. Wprowadzenie i Podział Architektoniczny

W środowisku Mastra OS porzucono koncepcję monolitycznego, uniwersalnego agenta wykonawczego. Zamiast tego system stosuje **dwupoziomowy model wykonawczy**:

```
                                ┌───────────────────────────────────────────────┐
                                │           META-AGENT (ORCHESTRATOR)           │
                                └───────────────────────┬───────────────────────┘
                                                        │
                    ┌───────────────────────────────────┴───────────────────────────────────┐
                    ▼ (Zadanie czysto kognitywne)                                           ▼ (Zadanie interaktywne / środowiskowe)
     ┌─────────────────────────────────────────────┐                         ┌─────────────────────────────────────────────┐
     │     A. COGNITIVE WORKER (`run_worker`)      │                         │     B. SCOPED SUBAGENT (`delegate_task`)    │
     ├─────────────────────────────────────────────┤                         ├─────────────────────────────────────────────┤
     │ • Narzędzia: BRAK (izolowany Text-in/Out)   │                         │ • Narzędzia: WĄSKA WIĄZKA (Scoped Bundle)   │
     │ • Skille: 1–3 procedury SOP (Multi-Skill)   │                         │ • Skille: 1–3 procedury SOP (Domenowe)      │
     │ • Pętla: 1 krok (Zero-shot / Direct Gen)    │                         │ • Pętla: ReAct (3–15 kroków z limitem)      │
     │ • Model: Ultra-tani / szybki (Flash / 8B)   │                         │ • Model: Średni / Mocny (Sonnet / Pro)      │
     │ • Ryzyko środowiskowe: 0% (Brak mutacji)    │                         │ • Ryzyko środowiskowe: Kontrolowane (Gates) │
     └─────────────────────────────────────────────┘                         └─────────────────────────────────────────────┘
```

---

## 2. Czy `metaAgent` ładuje Skille do Swojego Kontekstu?

**Nie.** Zgodnie z zasadą minimalnego narzutu na prompt główny (`.agents/AGENTS.md`):
- `metaAgent` odpowiada wyłącznie za:
  1. Rozumienie intencji użytkownika.
  2. Routing i delegację do wyspecjalizowanych agentów domenowych (`delegate_task`).
  3. Uruchamianie jednorazowych, szybkich zadań kognitywnych (`run_worker`).
  4. Bramkowanie operacji ryzykownych (`request_approval`).
- `metaAgent` **nie ładuje skilli domenowych bezpośrednio do własnego kontekstu**.
- Gdy zachodzi potrzeba analizy architektonicznej (np. audyt STRIDE, przygotowanie ADR czy dekompozycja specyfikacji):
  - `metaAgent` deleguje zadanie do agenta domenowego (`codingAgent`, `deliberationAgent`, `securityReviewAgent`) LUB
  - Wywołuje `run_worker` ze skillem Tier 4 (np. `skills: ['threat-model-stride']` lub `skills: ['adr-architecture-record']`).

---

## 3. Kompozycja Wielo-Skillowa i Attention Budget

Wstrzykiwanie więcej niż jednego skilla do workera (`skills: string[]`) jest w pełni wspierane pod dwoma twardymi warunkami:

### A. Reguła Ortogonalności Skilli (Zasada 3 Pytań)
Każdy wstrzyknięty skill musi odpowiadać na inne pytanie wykonawcze:
1. **Skill 1 (Metodologia / Badanie):** *Jak podejść do problemu?* (np. `ast-code-smell-detector`).
2. **Skill 2 (Standardy / Restrykcje):** *Jakie są twarde zasady kodu/treści?* (np. `ts-interface-contract-gen`).
3. **Skill 3 (Format Wyjścia):** *W jakiej strukturze zwrócić wynik?* (np. `markdown-table-normalizer` lub `json-schema-repair`).

> [!CAUTION]
> **Antywzorzec Kolizji Formatów:** Wstrzyknięcie dwóch skilli definiujących sprzeczne formaty wyjściowe (np. `raw-json` i `markdown-table`) wywołuje ostrzeżenie w telemetrii i wymusza stosowanie reguł najbardziej restrykcyjnych.

### B. Ogranicznik Budżetu Uwagi (`MAX_WORKER_SKILL_CHARS = 16000`)
- Silnik `run-worker.ts` automatycznie sumuje objętość wszystkich wstrzykiwanych procedur.
- Jeśli łączny rozmiar przekracza limit ~4 000 tokenów (16 000 znaków), procedura jest inteligentnie docinana z dopiskiem:
  `... [Skill procedure clamped due to attention budget limit]`.
- Zapobiega to degradacji uwagi małych i szybkich modeli (Flash / Groq / Llama 3 8B).

---

## 4. Matryca Wdrożonych Skilli (39 Nowych Procedur)

Wszystkie procedury zostały zintegrowane w `src/mastra/_skills/<kategoria>/` i są w 100% zredagowane po angielsku:

### Tier 1: Ultra-Fast Cognitive Workers (Model: `fast`)
- `json-schema-repair.md` (`coding`) – naprawa i walidacja uszkodzonego JSON.
- `markdown-table-normalizer.md` (`general`) – formatowanie i czyszczenie niespójnych tabel.
- `error-log-compressor.md` (`devops`) – kompresja stack-trace i kodów błędów (kompresja ~85%).
- `regex-optimizer.md` (`coding`) – bezpieczne wyrażenia regularne Re2/JS bez podatności ReDoS.
- `data-entity-extractor.md` (`analytics`) – ekstrakcja encji (NIP, email, kwoty) bez halucynacji.
- `code-simplification-reviewer.md` (`coding`) – eliminacja over-engineeringu i martwego kodu.
- `semantic-diff-synthesizer.md` (`coding`) – synteza zmian w kodzie.
- `ts-interface-contract-gen.md` (`coding`) – generowanie interfejsów TypeScript z surowego JSON.
- `anti-slop-content-sanitizer.md` (`marketing`) – usuwanie frazesów AI-slop z tekstów.
- `prompt-injection-canary.md` (`security`) – wykrywanie tokenów sterujących i wstrzyknięć.
- `css-3d-parallax-transforms.md` (`design`) – 60fps parallax bez WebGL.
- `cold-email-deliverability-sanitizer.md` (`marketing`) – 0 triggerów spamowych i reguła 3 zdań.

### Tier 2: Reasoning & Logic Workers (Model: `reasoning` / `pro`)
- `ast-code-smell-detector.md` (`coding`) – detekcja wycieków pamięci i nieobsłużonych obietnic.
- `eval-judge-rubric.md` (`meta`) – obiektywna ocena artefaktów (PASS/FAIL).
- `doubt-driven-reviewer.md` (`meta`) – krytyczny przegląd założeń i edge-cases.
- `source-driven-verifier.md` (`research`) – weryfikacja faktów na podstawie źródeł.
- `api-and-interface-design.md` (`coding`) – projektowanie spójnych kontraktów REST/RPC.
- `sql-query-optimizer.md` (`analytics`) – optymalizacja zapytań SQL, indeksów i planów EXPLAIN.
- `viral-hook-storytelling.md` (`marketing`) – formaty narracyjne o wysokiej retencji.
- `b2b-meddpicc-deal-qualifier.md` (`sales`) – scoring transkrypcji handlowych 0-80.
- `kpi-anomaly-triage.md` (`analytics`) – analiza odchyleń wieloczynnikowych.
- `menu-engineering-cogs-matrix.md` (`consulting`) – matryca Kasavana-Smith i Food Cost.

### Tier 3: Scoped Domain Subagents (Model: `balanced` / `pro` + Scoped Tools)
- `threejs-r3f-scene-architect.md` (`coding`) – architektura 3D w React Three Fiber (zakaz `setState` w pętli).
- `spline-3d-interactive-embed.md` (`coding`) – lazy loading i integracja modeli Spline.
- `glsl-webgl-shader-effects.md` (`coding`) – shadery WebGL (ripple, noise, glass dispersion).
- `modern-react-perf-audit.md` (`coding`) – audyt Server/Client components i renderowania.
- `wcag-accessibility-audit.md` (`design`) – audyt kontrastu i nawigacji klawiaturą (WCAG 2.2 AA).
- `frontend-ui-styling.md` (`design`) – Tailwind CSS i spójność design tokenów.
- `document-docx-xlsx-pdf.md` (`coding`) – generowanie arkuszy i raportów PDF.
- `mcp-server-builder.md` (`coding`) – tworzenie serwerów MCP w standardzie JSON-RPC.
- `tdd-isolate-runner.md` (`coding`) – cykl Red-Green-Refactor.
- `incident-root-cause-triage.md` (`devops`) – korelacja logów i diagnoza incydentów.
- `n8n-workflow-error-resilience.md` (`devops`) – Dead-Letter Queue i idempotencja SHA256 w n8n.
- `openapi-to-mcp-converter.md` (`coding`) – konwersja OpenAPI 3.0 do narzędzi MCP.
- `proposal-value-pricing-generator.md` (`sales`) – 3-poziomowe oferty wartościowe (Good-Better-Best).
- `sentiment-review-intelligence.md` (`research`) – ekstrakcja tematów i sentymentu z recenzji.

### Tier 4: Meta & System Architecture (Model: `pro`)
- `spec-driven-feature-builder.md` (`meta`) – Spec-First: specyfikacja wymagań przed kodowaniem.
- `adr-architecture-record.md` (`meta`) – standaryzacja rekordów Architecture Decision Records.
- `threat-model-stride.md` (`meta`) – modelowanie zagrożeń STRIDE.

---

## 5. Jak Uruchomić Weryfikację

Weryfikacja całego ekosystemu skilli i budżetu uwagi:
```bash
npm run check:worker-multi-skill
npm run check:capability-shelf
npm run check:specialist-builder
npm run typecheck
```
