# Liveness zamiast deadline — plan przebudowy budżetów czasu

**Data:** 2026-07-29
**Kontekst:** [audyt timeoutów](./timeouts-audit.md) · [kierunek meta-front](../docs/KIERUNEK-META-FRONT.md)
**Decyzja:** rozwiązujemy przyczynę (arbitralne sufity czasu), nie objaw (za niskie liczby).

---

## STATUS (2026-07-29) — L1–L5 ZAIMPLEMENTOWANE, flaga nadal OFF

| Etap | Stan | Commit |
|---|---|---|
| L1 rejestr liveness | ✅ | `40e1ef5` |
| L2 guard + zdarzenia | ✅ | `79c960c` |
| L3 szczelny AbortSignal | ✅ | `0dfb218` |
| L4 K8 + kalibracja | ✅ (częściowo — patrz niżej) | `8b45add` |
| L5 dowód E2E + override | ✅ | `48e0ea0` |

**Dowód E2E** (`npm run e2e:liveness-budget`, ~4,6 s, w `check:all`):
ten sam wolno-pracujący agent pod DEADLINE ginie po 700 ms
(`Harness LLM call timed out after 0.7s`), a pod LIVENESS **kończy się sukcesem w ~1,36 s** —
przeżywa zegar, który go zabił. Milczący run nadal jest cięty (`went idle`).

**Świadomie NIE zrobione w L4:** progi `unrecoverable*` **nie zostały przywrócone**
do wartości sprzed „loop_fix.P2c". Powód: obniżone progi tną pętle *wcześniej*, co jest
bezpiecznym kierunkiem, a podniesienie kosztuje realne tokeny bez dowodu, że jest potrzebne.
Komentarze w kodzie odnotowują, że przesłanka (zegar wyprzedzał detektory) **wygasła**,
a kalibracja należy do obserwacji realnego ruchu.

**Pozostało:** włączenie `FEATURE_LIVENESS_BUDGET=true` na realnym ruchu i kalibracja
`idleTimeoutMs`/`hardCapMs` przez `LIVENESS_IDLE_TIMEOUT_MS` / `LIVENESS_HARD_CAP_MS`
(override działa bez rebuildu — dowiedzione w E2E).

---

## 0. Teza

**Czas trwania jest złym miernikiem tego, czy agent błądzi.**
Agent może pracować poprawnie 10 minut (render filmu) albo błądzić w 30 sekund
(5× to samo narzędzie). Wall-clock nie odróżnia tych przypadków — detektory zdarzeń tak.

Dowód z kodu, że dzisiejszy zegar **aktywnie przeszkadza** ([strategy-reflector.ts:280](../src/mastra/services/strategy-reflector.ts)):

> „lowered 3→2 (raw loop ceiling 12→8). **The 300s wall-clock was beating the old ceiling**"
> „stop instead of **letting the model churn to the 300s timeout**"

Progi detektorów były obniżane, bo zegar je wyprzedzał. Czyli zegar psuł tuning tego,
co faktycznie wykrywa błądzenie.

**Zamiana:** `deadline` (czy zdążył) → `liveness` (czy żyje i robi postęp).

---

## 1. Co zostaje, co znika

| Warstwa | Dziś | Po zmianie |
|---|---|---|
| HTTP (CF 100 s / Hono 180 s / Node 300 s) | ściana, nieświadoma | **zostaje** — świadoma granica „to idzie w tło" |
| **Wall-clock agenta 60/180/300 s** | tnie pracującego agenta | **→ watchdog bezczynności** (brak zdarzenia przez N s) |
| Hard cap absolutny | brak | **nowy** — ostatnia deska ratunku (nie codzienny limit) |
| Detektory zdarzeń (10 sygnałów) | zdławione pod zegar | **główny hamulec**, progi przywrócone |
| `AbortSignal` w narzędziach | dziurawy (K11/K17/K18) | **szczelny** — warunek konieczny |

**Niezmiennik docelowy:**
> Run jest przerywany, gdy (a) nie robi **żadnego zdarzenia** przez `idleTimeoutMs`,
> (b) detektor uzna błądzenie za nieodwracalne, albo (c) przekroczy `hardCapMs`.
> **Nigdy** dlatego, że „pracuje za długo".

---

## 2. Stan zastany (zweryfikowany w kodzie)

### Architektura egzekwowania
```
callAgentGenerate  (generate-with-harness.ts:1345)
 ├─ AbortController harnessAbort                      ← WS-A, działa
 ├─ agent.generate(prompt, generateOptions)
 │    ├─ prepareStep   (:947)   ← PUNKT ZDARZENIA (przed krokiem)
 │    └─ onStepFinish  (:839)   ← PUNKT ZDARZENIA (po kroku)
 └─ withTimeout(call, input.timeoutMs)   (:1360 → def :2606)
      └─ onTimeout → harnessAbort.abort()
```

**Kluczowe:** `timeoutMs` (60/180/300 s) obejmuje **całe** wywołanie `generate`
(wszystkie kroki razem), a zdarzenia kroków są widoczne wewnątrz. To dokładnie ta
struktura, której potrzebuje liveness — nie trzeba przebudowywać przepływu.

**Ułatwienie:** `withTimeout` już ma ścieżkę wyłączenia — `if (!timeoutMs || timeoutMs <= 0) return promise`.

### Rejestr budżetu
[`run-budget.ts`](../src/mastra/services/run-budget.ts) (74 linie) — `setRunDeadline` /
`getRemainingRunBudgetMs` / `getCurrentRunRemainingBudgetMs`.
Konsument produkcyjny: **tylko** `delegate-task.ts:1422`. To znaczy, że zmiana
semantyki rejestru automatycznie naprawia delegację, bez dotykania `delegate-task`.

### Dwa reżimy agentów
| Reżim | Agenci | Kroki | Zegar |
|---|---|---|---|
| harness | meta, coding, automation, knowledge, deliberation, review | 10/25/40 | 60/180/300 s |
| pipeline | chef, content, hunt, writer, filmmaker, musician | 150 | **brak** |

---

## 3. Projekt docelowy

### 3.1. Rejestr: `deadline` → `liveness`

`run-budget.ts` zyskuje drugi tryb (stary zostaje dla kompatybilności):

```ts
interface RunLiveness {
  mode: 'DEADLINE' | 'LIVENESS';
  startedAt: number;
  lastActivityAt: number;   // przesuwane przez touch()
  idleTimeoutMs: number;    // ile bez zdarzenia = martwy
  hardCapMs: number;        // absolutny sufit (ostatnia deska)
}
```

Nowe API:
- `startRunLiveness(runId, {idleTimeoutMs, hardCapMs})`
- `touchRunLiveness(runId)` — wołane przy każdym zdarzeniu
- `getRunLivenessState(runId)` → `{ alive, idleForMs, elapsedMs, reason? }`

**`getCurrentRunRemainingBudgetMs` w trybie LIVENESS** zwraca
`min(idleTimeoutMs − idleFor, hardCapMs − elapsed)` — czyli „ile mam pewnego czasu,
zanim ktoś mnie uzna za martwego". Delegacja dostaje uczciwą liczbę bez zmian u siebie.

### 3.2. Egzekwowanie: `withTimeout` → `withLivenessGuard`

Zamiast jednego `setTimeout(timeoutMs)`:
- timer `idleTimeoutMs`, **resetowany** przy każdym `touch()`,
- osobny timer `hardCapMs` (nieresetowalny),
- oba wołają istniejące `onTimeout → harnessAbort.abort()` (mechanizm WS-A zostaje).

Powód odrzucenia: `idle_timeout` vs `hard_cap` — rozróżnialne w logach i evidence.

### 3.3. Zdarzenia odświeżające liveness

| Źródło | Miejsce | Uzasadnienie |
|---|---|---|
| koniec kroku | `onStepFinish` :839 | agent wykonał krok — żyje |
| przed krokiem | `prepareStep` :947 | agent planuje kolejny krok — żyje |
| wynik narzędzia | w `onStepFinish` (toolResults) | długie narzędzie zwróciło — żyje |

⚠️ **Świadomie NIE odświeżamy** na samym „model coś napisał" bez postępu —
inaczej pętla replanowania w nieskończoność wyglądałaby jak życie. Od tego są detektory.

### 3.4. Detektory jako główny hamulec

Po zdjęciu presji zegara — przywrócić progi zaniżone pod wall-clock:
- `unrecoverableLoopMultiplier` 2 → 3 (raw ceiling 8 → 12, wartość sprzed „loop_fix.P2c")
- `maxUnproductiveLoopRepetitions` 6 → 8
- `maxStepsWithoutProgress` — naprawić **K8** (dla `standard` = 25 = `maxSteps` → nigdy nie działa)

⚠️ Progi podnosimy **dopiero** gdy watchdog bezczynności działa i jest przetestowany.
Kolejność odwrotna = okno, w którym nic nie hamuje.

### 3.5. Profile głębokości po zmianie

`timeoutMs` w profilach przestaje być wall-clockiem, staje się `idleTimeoutMs` + `hardCapMs`:

| profil | idleTimeout | hardCap | maxSteps |
|---|---|---|---|
| fast | 45 s | 5 min | 10 |
| standard | 60 s | 15 min | 25 |
| deep | 90 s | 30 min | 40 |
| critical | 120 s | 60 min | 40 |

Liczby wstępne — do kalibracji na realnych biegach (Etap 5).
**Uzasadnienie hardCap:** ma być tak wysoki, żeby normalna praca go nie dotykała;
jego rola to złapanie patologii, której nie złapał ani watchdog, ani detektory.

---

## 4. Etapy realizacji

Każdy etap: **osobny commit, `check:all` zielony, flaga domyślnie OFF do etapu 5.**

### Etap L1 — rejestr liveness (fundament)
- `run-budget.ts`: tryb LIVENESS obok DEADLINE, `touch`, `getRunLivenessState`
- `getCurrentRunRemainingBudgetMs` uczciwe w obu trybach
- **Test:** rozszerzyć `check:delegation-budget` — idle reset, hard cap, degradacja do DEADLINE
- **Ryzyko:** niskie (nowy kod obok starego)

### Etap L2 — `withLivenessGuard` + wpięcie zdarzeń
- nowy guard w `generate-with-harness.ts` (obok `withTimeout`, nie zamiast)
- `touch()` w `onStepFinish` i `prepareStep`
- flaga `FEATURE_LIVENESS_BUDGET` (**OFF**) przełącza `withTimeout` ↔ `withLivenessGuard`
- **Test:** nowy `check:liveness-budget` — krok odświeża, brak kroku ubija, hardCap ubija
- **Ryzyko:** średnie (dotyka ścieżki wykonania — dlatego za flagą)

### Etap L3 — szczelny AbortSignal (warunek konieczny)
Bez tego watchdog bezczynności ma dziurę: zawieszony `fetch` = zero zdarzeń, ale też
zero szans na abort.
- K11: `film-generate.ts` / `music-generate.ts` — polling i pobranie pliku bez sygnału
- K17: `ollama-gateway.ts` (health probe!), `reviews-google-place.ts`, `weather-*`
- K18: 8× git w `code-worktree.ts`
- **Test:** rozszerzyć istniejące checki domenowe
- **Ryzyko:** niskie (dodanie sygnału, nie zmiana logiki)

### Etap L4 — kalibracja detektorów
- przywrócić progi (3.4), naprawić K8
- **Test:** `check:strategy-reflector` + `e2e:reflector-*`
- **Ryzyko:** średnie (za wysoko = churn, za nisko = fałszywe cięcia)

### Etap L5 — włączenie + kalibracja live
- flaga **ON**, obserwacja realnych biegów
- kalibracja `idleTimeout`/`hardCap` na danych, nie na przeczuciu
- **Definicja sukcesu:** długie zadanie (film/menu) kończy się wynikiem;
  pętla narzędziowa jest ucinana przez detektor, **nie** przez zegar

### Etap L6 (opcjonalny) — pipeline pod liveness
Dziś chef/content/hunt/writer/film/musician mają **zero** zegara (K2: 150 kroków,
okno tylko z delegacji). Liveness daje im pierwszą sensowną ochronę bez arbitralnego sufitu.

---

## 5. Szacunek

| Etap | Sesje |
|---|---|
| L1 rejestr | 0,5 |
| L2 guard + zdarzenia | 1 |
| L3 AbortSignal | 1 |
| L4 detektory | 0,5–1 |
| L5 włączenie + kalibracja | 1 |
| **Razem** | **4–4,5** |
| L6 pipeline (opcjonalny) | +1 |

---

## 6. Ryzyka i zabezpieczenia

| Ryzyko | Zabezpieczenie |
|---|---|
| Zdjęcie zegara → spalanie tokenów w niewykrytej pętli | `hardCapMs` + detektory **przed** włączeniem flagi (L4 przed L5) |
| Zawieszony I/O → brak zdarzeń, ale i brak aborta | L3 **przed** L5; watchdog i tak ubije po `idleTimeout` |
| Detektory dostrojone pod stary zegar tną za wcześnie/późno | L4 osobno, z testami; kalibracja live w L5 |
| Regresja w delegacji | `getCurrentRunRemainingBudgetMs` uczciwe w obu trybach; `check:delegation-budget` |
| Zmiana zachowania bez ostrzeżenia | wszystko za `FEATURE_LIVENESS_BUDGET`, OFF do L5 |

---

## 7. Czego ten plan świadomie NIE robi

- **Nie buduje job/lease/fencing** — to odłożona orkiestracja
  ([handoff](../docs/ORCHESTRATION-PAUSED-HANDOFF.md)). Liveness działa w obecnym procesie.
- **Nie rusza ściany HTTP** — zostaje jako granica sync/async.
- **Nie naprawia K3/K4** (automation 1200 s, coding/knowledge 300 s zaszyte) — osobna
  praca po L5, bo dotyczy koordynacji budżetu, nie mechanizmu czasu.
- **Nie rusza K9/K10/K12–K16** (długi ogon narzędzi) — poza L3, który jest warunkiem koniecznym.
