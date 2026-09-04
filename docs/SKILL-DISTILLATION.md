# Skill Distillation — success brain (Etap 6)

> Implementacja Etapu 6 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (§5, wzorzec Hermes Agent).
> Wdrożono: 2026-07-20, branch `feat/ideal-system-etap-6-skill-distillation`.
> Flaga: `FEATURE_SKILL_DISTILLATION` (default **ON**).

## Zasada

System ma już **failure brain** (`error-collector` / `auto_healing_tickets`) —
uczy się, czego **unikać**. To jego symetryczna połowa: po **udanym** zadaniu wartym
zapamiętania tani model destyluje przebieg w wielokrotnego użytku `SKILL.md` — w tym
samym formacie, który `skill-registry` + `skillSearchTool` już ładują (**zero zmian
w formacie/loaderze**, jedynie pomijanie katalogów lifecycle). Razem domykają pętlę:
*porażka uczy czego unikać; sukces uczy jak powtarzać taniej.*

## Pipeline (`services/skill-distiller.ts`)

```
1. TRIGGER   done z ≥5 tool calli / recovery / korekta usera → recordDistillationCandidate
             → Mongo distillation_candidates (lessons + goal, sekrety zredagowane)
2. EXTRACT   tani model (workerPresets.reasoning, lokalny) pisze DistilledSkill
             → wstrzykiwalny `SkillWriter` (test deterministyczny, runtime = model)
3. EVAL      miniEvalSkill: poprawny frontmatter (name kebab-case + description ≥20),
             body ≥120 zn. ze strukturą (kroki), BRAK sekretów, re-parse pliku
4. ACTIVATE  pass → src/mastra/_skills/auto/<name>.md (registry podnosi przy refresh)
             fail → src/mastra/_skills/quarantine/<name>.md (NIGDY nie szukane)
```

`shouldDistill()` — predykat triggera (Hermes): `user_correction` > `recovery` >
`tool_calls ≥5`. Sekrety redagowane przy zapisie kandydata i przy renderze SKILL.md
(`redactSecrets` + `containsSecrets` w mini-evalu — bramka przeciw wyciekowi).

### Jakość pisania — rubryk ze skill-creatora

Najsłabszym ogniwem autonomicznej destylacji jest surowa zdolność małego modelu do
napisania *dobrego* skilla. Dlatego prompt writera (`buildModelSkillWriter`) wstrzykuje
zwarty **rubryk** (`SKILL_WRITING_RUBRIC`) wydestylowany z repozytoryjnego skilla
`_skills/meta/skill-creator.md` (sekcja „Skill Writing Guide"): opis-jako-trigger z
frazami wyzwalającymi, forma rozkazująca, kroki + „## Pitfalls", generalizacja (bez
instance-id), zwięzłość, zakaz sekretów. Rubryk jest celowo krótki (lokalny model ma
mały kontekst) — pełny interaktywny loop skill-creatora (evale/benchmarki/człowiek)
NIE jest używany w nocnym cyklu; pożyczamy jego *wiedzę o pisaniu*, nie jego *proces*.

### Model destylacji — konfigurowalny w manifeście

Model nocnej destylacji to `infrastructure.skillDistiller` w
`config/model-manifest.ts` (domyślnie **`gemma4-12b`** — mocny w pracy agentowej,
lokalny → koszt ~0). Zmiana jednej linii w manifeście przełącza model na dowolny
dostępny `ModelKey`, gdyby gemma 12b nie radziła sobie z jakością skilli.

## Liczniki + Kurator (`services/skill-stats.ts`)

Mongo `skill_stats` (bogatsze niż rolling-average w froncie, który registry dalej
prowadzi): `views`, `uses`, `successes`, `successRate`, `lifecycle`, `lastUsedAt`.
Inkrementowane w `skill_load` (view) i `skill_report` (use).

**Kurator** (`runCurator`, deterministyczny przy wstrzykniętym `now`):
- nieużywany ≥30 dni → `stale`;
- ≥90 dni → `archived` (plik przeniesiony do `_skills/archive/`, pomijany przez loader);
- niski success (<0.5 przy ≥4 użyciach) → zadanie naprawy w `skill_repair_tasks`
  (konsument: reflektor/strateg w E10).

## Cykl nocny + tygodniowy (`scripts/skill-nightly-cycle.ts`, w cron-runner)

- **03:00 codziennie** — `runNightlySkillCycle`: destylacja zaległych kandydatów,
  refresh registry, raport poranny do Task Ledger (lane efemeryczny).
- **Niedziela 04:00** — `runWeeklyCurator`: stale/archive/repair + raport do Ledgera.
- Ręcznie: `npm run skill:nightly`, `npm run skill:curator`.

Model destylacji jest **wstrzykiwany** (`buildLocalGenerate` w cronie; deterministyczny
writer w testach) — ta sama dyscyplina co reszta etapu: zero palenia tokenów w CI.

### Status 2026-08-19 — cron uruchomiony na trwałe, kolejka wyczyszczona po refaktorze

Audyt wykazał, że `cron-runner.ts` (jedyne miejsce wywołujące `runNightlySkillCycle`/
`runWeeklyCurator`) nigdy nie był uruchomiony jako trwały proces — brak wpisu w
`docker-compose.yml`, brak pm2/systemd. Skutek: **destylacja nigdy realnie nie zaszła**.
215 kandydatów siedziało w `distillation_candidates` ze statusem `pending`, część
sprzed miesiąca — mimo że sam mechanizm zapisu kandydatów (`recordDistillationCandidate`)
działał poprawnie, także z ruchu V2 (`harness-agent-caller.ts`, potwierdzone bramą
`check:v2-learning-loop`).

Głębszy skan kolejki przed odpaleniem pokazał, że **184 z 215 rekordów to jeden
zdublowany fixture testowy** (`automationArchitect`: "Deploy a webhook→validate→respond
workflow…", powtórzony identycznie ~14× w ciągu miesiąca przy każdym uruchomieniu
gate'a) + 2 sondy `capabilitySmith` z build-pipeline. Realnych kandydatów było 29.
Ponieważ kolejka jest FIFO (`sort({createdAt:1})`, limit 30/noc), pierwszy nocny
przebieg spaliłby cały budżet na powielony fixture, nie dotykając realnej treści.

Decyzja (post-refaktor, żeby nie mieszać kandydatów V1/V2): **cała kolejka
wyczyszczona do zera** (`distillation_candidates.deleteMany({})`), zamiast selektywnego
czyszczenia. Od teraz kolejka rośnie wyłącznie z ruchu na aktualnym silniku.

Zmiany wdrożone tego dnia (stan nadzoru zaktualizowany 2026-08-24):
- `cron-runner.ts` działa pod usługą użytkownika `mastra-cron-runner.service`
  (szablon: `scripts/systemd/mastra-cron-runner.service`, `Restart=always`, start
  z `default.target`). Log trafia do
  `.deploy/logs/cron-runner-systemd.log`. Runner tyka co minutę; uruchamia
  retencję observability o 02:10, destylację o 03:00 i kurację w niedzielę o 04:00.
- `infrastructure.skillDistiller` w `config/model-manifest.ts` przepięty z lokalnego
  `gemma4-12b-official` na chmurowy `groq-gpt-oss-120b` (ten sam alias co
  `workerPresets.reasoning`) — start na czystej kolejce ma pełną moc modelu chmurowego
  zamiast lokalnego.
- `distillation_candidates`: 215 → 0.

Do zweryfikowania po pierwszym nocnym przebiegu: `skill_stats`, zawartość
`_skills/auto/` (dziś tylko `.gitkeep`), wpis w Task Ledger (`source: "cron"`).

## Loader — jedyna zmiana

`skill-registry._findMarkdownFiles` pomija katalogi `quarantine` i `archive`
(2 linie) — skille odrzucone/wycofane nigdy nie trafiają do puli wyszukiwania.
Format SKILL.md i reszta loadera bez zmian.

## Wpięcie triggera

`delegate-task` (`wrapWithResultEnvelope`): udana delegacja z niepustym
`envelope.lessons` (E3) → `recordDistillationCandidate` (fire-and-forget, nigdy nie
blokuje odpowiedzi). Predykat triggera re-sprawdzany w środku.

## Testy (w `check:all`)

- `check:skill-distill-roundtrip` — predykat triggera, zapis kandydata, GOOD skill →
  aktywacja → świeży registry go ładuje (pula wyszukiwania), GARBAGE → kwarantanna,
  mini-eval łapie sekret (6 grup asercji, writer deterministyczny — zero tokenów).
- `check:curator-lifecycle` — liczniki + successRate, active/stale(30d)/archived(90d),
  niski success → repair queued, archived nie re-procesowane (4 grupy, `now` wstrzyknięty).

## Ograniczenia E6 (świadome)

- Trigger wpięty na `envelope.lessons`; pełne liczenie tool-calli per task z
  `agent_events` w nocnym skanie Ledgera → do rozbudowy (dziś recovery-grade sygnał
  wystarcza do kandydata).
- Runtime distillation działa na lokalnym modelu — jakość skilla zależy od modelu;
  mini-eval + Kurator + kwarantanna to bramka jakości, ale nie gwarancja.
- Auto-skille są gitignorowane (`_skills/{auto,quarantine,archive}/*.md`) jako
  artefakty runtime — nie źródło; registry ładuje je z dysku niezależnie.

## Wierność wzorcowi Hermes (zweryfikowane u źródła 2026-07-20)

Zweryfikowane względem praktycznego przewodnika Hermes Agent (nie tylko blueprintu):

| Mechanizm Hermes | Nasze E6 |
|---|---|
| Trigger: „complex task (5+ tool calls) successfully" / „hit errors and found the working path" / „user corrected its approach" | ✅ **1:1** — `shouldDistill`: user_correction > recovery > tool_calls ≥5 |
| Autorstwo: agent zarządza skillami przez `skill_manage` (create/patch/edit/delete) = „procedural memory" | ⚠️ mamy **create** (distiller). **Brak patch/edit/delete jako akcji agenta** — patrz luka niżej |
| Eval przed aktywacją | ✅ **bogatsze** — Hermes tego nie dokumentuje; my mamy mini-eval + kwarantannę |
| Liczniki użycia / success | ✅ **bogatsze** — Hermes tego nie dokumentuje; my mamy `skill_stats` |
| Kurator/pruning | ✅ **konkretniejsze** — my mamy progi stale 30d/archive 90d/repair; Hermes v0.14 „consolidation opt-in", bez progów |
| Cykl nocny | ✅ mamy scheduled 03:00 (lokalny, ~$0); Hermes zrobił consolidation **opt-in/on-demand** (u nas flaga `FEATURE_SKILL_DISTILLATION` pełni tę rolę) |

**Wniosek:** odwzorowaliśmy pętlę Hermesa wiernie na triggerach i jesteśmy *bardziej
kompletni* tam, gdzie Hermes zostawia rzeczy nieudokumentowane (eval, liczniki, kurator).

**Jedyna realna luka:** Hermes daje agentowi **inline `skill_manage` z patch/edit**
(agent poprawia własny skill w trakcie użycia; patch = najtańszy tokenowo). Nasz
distiller robi tylko *background create*. To kandydat na rozszerzenie (E6.1): tool
`skill_manage(patch|edit)` dla agentów + „promocja zwycięzców" przez skill-creator na
mocnym modelu (Kurator już wskazuje kandydatów: wysokie użycie / niski success →
`skill_repair_tasks`).

## Exit criteria (plan)

- ✅ mechanizm: powtórzone zadanie może użyć auto-skilla (roundtrip zielony);
  „≥25% taniej/szybciej" i „≥10 auto-skilli po 2 tyg." to metryki **live** — do
  potwierdzenia po działaniu nocnego cyklu na realnym ruchu.
