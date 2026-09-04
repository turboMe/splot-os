# Analiza: planista rozbija zadania agentów, które mają własny pipeline

**Dla kogo:** nowa instancja, zadanie **wyłącznie analityczne**.
**Data zebrania faktów:** 2026-08-19. Wszystko poniżej zmierzone w źródle i na żywych jobach — nie z pamięci, nie z dokumentacji.
**Gałąź:** `refactor/meta-front-durable-orchestration`, HEAD `76bf144`.

> **NIE NAPRAWIAJ NICZEGO W TEJ SESJI.** Zadaniem jest zrozumieć mechanizm i wrócić z opisem przyczyn. Powód jest empiryczny: w poprzedniej sesji trzy „małe, oczywiste" poprawki wyszły na jaw jako niewystarczające, a jedna zamieniła słaby wynik w brak wyniku (patrz §6). Właściciel decyduje, co się zmienia.

---

## 1. Objaw

Użytkownik pisze do `metaFrontAgent`: *„potrzebuje nowe menu dla restauracji <URL>"*.

Planista (Lane Orchestrator) rozbija to na sekwencję:

```
researcherAgent → chefAgent
```

Wygląda rozsądnie i **jest błędne**. `chefAgent` ma własny 12-fazowy pipeline, w którym faza `recon` sama deleguje do `researcherAgent` — dwiema precyzyjnymi misjami, z twardym kontraktem wyjścia JSON. Planista odbiera chefowi ten krok i zastępuje go własnym, generycznym zleceniem.

**Skutek nie jest „zdublowaniem kroku", tylko wyprodukowaniem materiału, którego chef nie potrafi wczytać.**

---

## 2. Twarde dowody (zmierzone, nie wywnioskowane)

### 2.1 Chef ma deterministyczny odbiornik na odpowiedź researchera

`src/mastra/tools/chef/chef-tools.ts:1159`

```ts
inputSchema: z.object({
  projectId: z.string(),
  currentMenuAnalysis: CurrentMenuAnalysisSchema.describe("Researcher Mission A output contract (menu recon)"),
  reputation: ReputationSchema.describe("Researcher Mission B output contract (reputation recon) — optional"),
})
```

To nie jest narzędzie „na tekst". To mapper oczekujący konkretnego JSON-a.

### 2.2 Chef zamawia ten JSON własnym briefem

`src/mastra/prompts/research/menu-recon.md` (2 414 zn.) — twarda kolejność odczytu (`tavily_extract` → `firecrawl_scrape` → Playwright → PDF), **zakaz** („Do not invent prices or dishes that aren't in the source. Missing data → `gaps[]`"), ścisły kontrakt wyjścia (`sections[].dishes[]` z `price`, `inferredTechniques`, `inferredAllergens`).
Druga misja: `src/mastra/prompts/research/reputation-recon.md` (2 238 zn.) — `reviews_google_place` + TripAdvisor.

### 2.3 Planista zamawia jedno zdanie

Zmierzone na żywym jobie `job_a625e520` (Fjallkonan):

```
zadanie researchera: "Przeanalizuj ofertę i profil restauracji Fjallkona w oparciu o ich stronę internetową."
zadanie chefa:       "Na podstawie zebranych danych zaprojektuj nowe menu…"
```

Brak metody, brak zakazów, brak kontraktu wyjścia, **brak Misji B** (reputacja nigdy nie jest zamawiana).

### 2.4 Efekt końcowy — trzy żywe joby

| job | co się stało |
|---|---|
| `job_c9e5e61c` (Grillmarkaðurinn) | researcher pobrał prawdziwą kartę (`tavily_extract` ×2), po czym oddał **własne nowe menu**; ceny +100 ISK wobec prawdziwych (4.290 vs **4.190**, 5.590 vs **5.490**) |
| `job_a625e520` (Fjallkonan) | po naprawie W3 researcher oddał **poprawny raport** (fakty zweryfikowane wobec strony: adres, happy hour, brunch — zgodne). **Chef i tak padł**: `llm_call_failed err=deadline dur=1 796 093 ms`, 97 zdarzeń, 3 wywołania narzędzi, **0 znaków wyniku**, job `FAILED` |
| `job_d9841a71` (Apotek) | po naprawie menu planisty (§6, `76bf144`) plan **nadal** `researcher → chef` |

---

## 3. ⭐ Zasięg — to nie jest problem chefa

Sześciu agentów pipeline deleguje wewnętrznie. **Pięciu nie ma w karcie żadnej ochrony przed dekompozycją:**

| agent | deleguje w fazach | karta chroni |
|---|---|---|
| `chefAgent` | recon, profile_synthesis, recipes | ✅ TAK — i mimo to został rozbity |
| `contentAgent` | research | ❌ NIE |
| `huntAgent` | discover, enrich | ❌ NIE |
| `writerAgent` | research | ❌ NIE |
| `filmmakerAgent` | source_gate, reference_map | ❌ NIE |
| `musicianAgent` | source_gate | ❌ NIE |

Chef jest jedynym przypadkiem, który w ogóle wykryliśmy, bo jako jedyny ma regułę — i ta reguła nie zadziałała. **U pozostałych pięciu ten sam defekt jest dziś niewidoczny.**

---

## 4. Co konkretnie prześledzić

Nie zakładaj, że poniższa lista jest kompletna ani że moje wnioski są trafne. **Sprawdź każde ogniwo osobno.**

### 4.1 Planista
- `src/mastra/orchestration/execution/lane-decider.ts` — `buildDecisionPrompt` (ok. 130-200): jak zbudowane jest menu, jak sformułowany wybór `dispatch` vs `plan_steps`, czy „normalny wybór" jest realnie uprzywilejowany
- `src/mastra/config/capability-routing.ts` — `forDecider()`: co trafia do menu, a co jest odrzucane
- Czy istnieje **walidacja decyzji** po stronie kodu i czy mogłaby odrzucić zły podział (nagłówek pliku deklaruje zasadę: *„A model proposes… this registry decides"* — sprawdź, jak daleko ta zasada realnie sięga)

### 4.2 Pipeline chefa
- `src/mastra/prompts/chef/pipeline.md` (17 094 zn.) + `chef/domain.md` (9 416 zn.)
- `src/mastra/config/pipeline-phase-tools.ts` — mapa faz, `alwaysAvailable`, `resolvePhaseTools`
- **Kluczowe pytanie:** faza `recon` jest warunkowa („when we have a URL/name"), a `intake` rozgałęzia się na „Conversation" (kwestionariusz, **pytania do użytkownika**) i „URL/nazwa" (recon). Jak to się ma do trybu bezobsługowego?

### 4.3 Kontrakt bezobsługowy
- `src/mastra/orchestration/execution/headless-contract.ts` — mówi m.in. *„Missing detail is normal and is NOT a reason to stop. Choose sensible defaults, DO THE WORK"*
- **Pytanie:** czy to nie stoi w sprzeczności z pipelinem, który każe pytać i badać, zanim się wyprodukuje?

### 4.4 Reguła dispatchu i sekwencji
- `src/mastra/orchestration/store/activations.ts` — materializacja planu
- `src/mastra/orchestration/execution/registry-worker.ts` — `semanticPromptFor`, `upstreamBlock`, `promptFor`
- `src/mastra/orchestration/store/final-decision.ts` — sędzia; dlaczego job z poprawną pracą kończy `FAILED`

### 4.5 Meta Front
- `src/mastra/agents/meta-front-agent.ts` + `src/mastra/prompts/meta-front/base.md`
- Zamienia jedno zdanie użytkownika w wielopunktową specyfikację (zmierzone). **Czy ta ekspansja nie jest pierwszym miejscem, gdzie ginie informacja „to jest zadanie dla jednego specjalisty"?**

---

## 5. Hipotezy do sfalsyfikowania (NIE są ustaleniami)

1. **Granica planowania jest źle postawiona.** Planista dekomponuje *wewnątrz* domeny, którą agent ma na własność. Może powinien planować wyłącznie *między* domenami.
2. **Tekst doradczy nie wystarcza.** Reguła jest w prompcie i model ją ignoruje (zmierzone, §6). Może potrzebna jest walidacja strukturalna zamiast perswazji.
3. **Kontrakt bezobsługowy walczy z pipelinem.** Jeden mówi „nie zatrzymuj się, produkuj", drugi „najpierw zbadaj i zapytaj".
4. **Sam pipeline chefa zakłada interaktywność**, której w durable jobie nie ma (kwestionariusz, checkpointy).
5. **Ekspansja promptu przez Meta Front** gubi informację o właścicielu zadania.

---

## 6. Co już próbowano — nie powtarzaj

| commit | co | wynik |
|---|---|---|
| `79d6d94` | Meta Front mógł rozmawiać, ale nie umiał zakolejkować pracy ze Studio (tożsamość runu czytana z `runtime.agentId`, a Mastra podaje `runtime.agent.agentId`) | ✅ działa live |
| `5a0e93a` | W1 — faza pipeline wyprowadzana z przebiegu zamiast ze stałej `phase:'chat'` | ✅ poprawne, ❌ **bez efektu** — chef nie ogłasza faz (zmierzone: 0 zgłoszeń w 3 przebiegach) |
| `6f89ac7` → `f586cbb` | W1b — start w fazie `intake` żeby wymusić przejścia | ❌ **REGRESJA, cofnięte.** `intake` nie zawiera `chef_generate_menu` ani `system_delegate_task`, więc chef został zatrzaśnięty przy bramie: `COMPLETED` → `FAILED`. Lekcja: dostępność narzędzia ≠ jego użycie |
| `bb8c712` | W3 — w planie zadanie jest wiążące, cel joba tylko tłem | ✅ **działa live** — researcher przestał oddawać cudzy produkt |
| `76bf144` | menu planisty przestało obcinać `inputContract` i `hardRules` | ✅ fakt dociera (zweryfikowane w runtime), ❌ **planista i tak dzieli** |

**Dwa ustalenia negatywne, oszczędzą czas:**
- **Legacy zachowuje się tak samo.** Zmierzone na kopii sprzed refaktora (`/vm/mastra_v1_before_v2_is_done/AI-Agentic-System-master`, port 5111, zero flag V2): chef, zadanie „Fjord Table", **0 zgłoszeń faz, 0 delegacji**. To nie jest regresja V2.
- **Maszyna faz nigdy nie prowadziła chefa** — ani teraz, ani przed refaktorem. Zawsze była biernym obserwatorem czekającym na sygnał, którego agent zwykle nie wysyła.

---

## 7. Zasady pracy

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, nie nasłuchuje i nie loguje błędu.
- **Nie ufaj testom jako dowodowi zachowania.** W tej sesji cztery razy brama była zielona dla mechanizmu, który w produkcji nie działał: raz bo owijała każde wywołanie w kontekst harnessu i nie dotykała drugich drzwi, raz bo atrapa nie miała narzędzia wstrzymywanego i szła nieprodukcyjną gałęzią, dwa razy bo fixture był pisany z wyobrażenia o kształcie danych.
- **Granica nazewnicza Mastry:** historia kroków i `activeTools` operują na **KLUCZU** obiektu `tools`, mapa faz jest pisana w `id`. Fixture mówiący `id` nie wykryje niczego.
- **Telemetria potrafi kłamać:** odrzucone wywołanie narzędzia (`success:false` bez wyjątku) jest logowane jako `status:'success'`. Nie oceniaj po dzienniku zdarzeń, tylko po stanie w `orch_jobs` / `orch_execution_results`.
- **Zanim uznasz pustkę za defekt** — policz wiersze bez filtra i przeczytaj sygnaturę w źródle. Treść wyniku joba siedzi w `producer.data.text`, nie w polu `content`; `orch_jobs` nie ma pola `status` (jest `phase` + `terminalOutcome`).
- **Do porównań live zmieniaj restaurację przy każdym teście** — inaczej meta podbierze gotowy wynik z bazy i uzna zadanie za wykonane (zdarzyło się).
- Baza jest **współdzielona** przez drzewo produkcyjne i kopię legacy — rozróżniaj przebiegi po czasie.
- **Nie dotykaj** `docs/PROMPT-INSTANCJA-SILNIK-V2.md`, `docs/STATUS-AGENTOW-SILNIK-V2.md`, `src/mastra/scripts/f8-*` — należą do innej instancji.

---

## 8. Czego oczekujemy na wyjściu

Nie łatki. **Opisu mechanizmu**, który odpowiada na:

1. Gdzie dokładnie zapada decyzja o rozbiciu zadania i na podstawie jakich danych?
2. Dlaczego jawna reguła w prompcie nie zmienia tej decyzji?
3. Czy granica „planista dekomponuje / agent wykonuje swój pipeline" jest w tym systemie w ogóle zdefiniowana, czy tylko dorozumiana?
4. Co się stanie z pozostałą piątką agentów delegujących wewnętrznie, gdy trafią na analogiczne zadanie?
5. Które z hipotez §5 dają się sfalsyfikować pomiarem, a które są nierozstrzygalne bez zmiany kodu?

Dla każdego wniosku podaj **dowód**: plik i linię, albo pomiar z żywego joba. Jeśli czegoś nie da się rozstrzygnąć bez zmiany kodu — powiedz to wprost, zamiast zgadywać.
