# Hermes Agent (Nous Research) vs. Mastra Cognitive Harness — analiza porównawcza

> Research note dla operatora. Data: 2026-06-29.
> Cel: ustalić, gdzie nasz system (warstwowa pamięć + uczenie na błędach + skill registry,
> zbudowany na Mastrze) wypada względem **Hermes Agent** — z naciskiem na pętlę uczenia,
> automatyczną rozbudowę skilli, uczenie na błędach oraz hasło „agent rośnie z Tobą”.

## 1. Co to jest Hermes Agent (fakty referencyjne)

- Open-source agent od **Nous Research**, licencja **MIT**, repo `github.com/nousresearch/hermes-agent`,
  start luty 2026, wersja ~v0.2.0. Kompatybilny z otwartym standardem `agentskills.io`.
- **Jeden, jednolity rdzeń agenta** współdzielony przez gateway, CLI, serwer ACP i scheduler cron —
  „single-agent core, behavior consistent across all platforms”. To świadomy wybór: spójność zamiast
  topologii wielu agentów.
- **Zamknięta pętla uczenia (closed learning loop):**
  1. po ukończeniu złożonego zadania (**≥5 wywołań narzędzi**) agent **sam pisze plik `SKILL.md`** —
     reużywalny zapis podejścia, edge-case'ów i wiedzy domenowej;
  2. **samo-patchuje skille** w trakcie użycia, gdy są nieaktualne/niekompletne/błędne;
  3. **pisanie skilla wyzwala też recovery z błędu** (nie tylko sukces).
- **Uczenie na błędach:** wczesne „spróbuj ponownie” zastąpiono **klasyfikacją błędów na 6 typów** z
  konkretną wskazówką naprawczą („read the file again” zamiast „fix the issue”).
- **Pamięć 3-warstwowa:** (a) prompt memory = `MEMORY.md` + `USER.md`; (b) episodic archive =
  **SQLite FTS5** + podsumowania LLM (cross-session recall); (c) skill memory. Architektura jest
  **cache-aware**, więc rachunek za tokeny nie rośnie wraz z nauką.
- **„Rośnie z Tobą”:** model użytkownika budowany przez **Honcho** (dialectic user model) — śledzi Twój
  stack, skróty których używasz, i co już Ci powiedziano.
- **Multi-channel gateway:** Telegram, Discord, Slack, WhatsApp, Signal, CLI — z jednego procesu.
- **Durable scheduler:** `cron/jobs.py` + `cron/scheduler.py`, narzędzie `cronjob`, CLI `hermes cron`, `/cron`.
- **Sandbox:** transactional sandbox; „Policy Violation” traktowane jako granica wymagająca rewizji planu.
- Benchmark Nous: agent z samodzielnie utworzonymi skillami robił research **~40% szybciej** niż świeża instancja.

## 2. Nasz system w skrócie (stan repo)

- **Mastra** jako runtime + **Cognitive Harness** (warstwa operacyjna): pre-contexting, Cognitive Loop
  (OODA), async/soft-interrupts, **pamięć warstwowa + file ledger**, **tool envelope governance**.
- **Pamięć warstwowa:** working memory (szablon z User Preferences), **Observational Memory**
  (Actor/Observer/Reflector — kompresja), `agent_events` (TTL 30 dni), **`system_knowledge`** (typowana
  wiedza, embeddingi bge-m3, TTL 90 dni renewable, dedup, confidence), **file activity ledger**.
- **Failure Brain:** przed diagnozą błędu recall `failure_case` + `autoheal_recipe`; po naprawie zapis
  recepty; `automation-failure-learning.ts` klasyfikuje porażki i dokleja „next-time guidance”.
- **Skill Registry:** skanuje `_skills/*.md` (YAML frontmatter), embeddingi, `skill_search`/`skill_load`/
  `skill_report` (feedback `success_rate` w YAML). Plus metodyka `skill-creator.md` (eval/benchmark, A/B).
- **Cognitive Loop / Reflector:** in-flight `prepareStep` reflector (sygnały, soft/hard levers, cooldown,
  `stopWhen`, output scoring), **GoalContract** (steps/evidence/progress/confidence), **DepthController**.
- **Topologia wielu agentów:** meta-orchestrator + ~15 agentów domenowych, Deliberation Council, review trio.
- **Self-healing produkcyjny:** error collector → ticket → diagnose → naprawa w izolowanym worktree →
  review → **blue-green deploy** + rollback ledger.
- **Periodic workers**, telemetry/replay (`replay:harness`), eval dashboard. Runtime lokalny, **konteneryzacja planowana**.

## 3. Najważniejsza różnica koncepcyjna

| | Hermes | Nasz system |
|---|---|---|
| Substrat uczenia | **Pliki `SKILL.md`** pisane autonomicznie | **Typowana wiedza** w `system_knowledge` (Mongo) + skille indeksowane |
| Tworzenie skilla | **Autonomiczne**, po ≥5 tool calls / po recovery | **Human-in-the-loop**, eval-driven (`skill-creator.md`), **nie podpięte jako auto-trigger** |
| Topologia | Świadomie **single-agent** | **Multi-agent** orchestration |
| Zasięg | **Multi-channel** assistant | Platforma inżyniersko-operacyjna (Studio/API + n8n) |

Innymi słowy: **uczysz się tak samo dużo, ale w innym miejscu.** Hermes destyluje doświadczenie do
reużywalnych *plików skilli* bez człowieka; my destylujemy do *warstwy wiedzy* (z embeddingami,
confidence, TTL) i mamy bogatszą pętlę reflektora/self-healingu, ale brakuje nam **autonomicznego
domknięcia: doświadczenie → nowy plik skilla**.

## 4. Tabela punktacji (0–10 dla każdego elementu)

> Skala: 0 = brak, 5 = podstawowe, 8 = mocne, 10 = wzorcowe. Punktacja jakościowa, oparta na kodzie repo i
> publicznych opisach Hermes.

### A. Pętla uczenia / rozbudowa skilli

| # | Element | Hermes | My | Komentarz |
|---|---|:---:|:---:|---|
| 1 | Closed-loop self-improvement na powtarzalnych zadaniach | **9** | 7 | Mamy memory-extractor → `system_knowledge` + recall, ale brak auto-destylacji do skilli |
| 2 | **Autonomiczne tworzenie skilli z zadań** | **9** | 3 | Mamy `skill-creator.md`, ale human-in-the-loop i nie podpięte jako auto-trigger |
| 3 | Self-patching / refinement skilli | **8** | 6 | Mamy `success_rate` feedback + eval loop; brak in-flight autopatcha |
| 4 | Skill registry / discovery (semantyka) | 7 | **8** | bge-m3 + cosine + lazy load; semantycznie mocniejsze niż FTS5 |
| | **Podsuma A** | **33** | 24 | Hermes +9 — to jest realna luka |

### B. Uczenie na błędach

| # | Element | Hermes | My | Komentarz |
|---|---|:---:|:---:|---|
| 5 | Failure memory (recall poprzednich napraw) | 7 | **9** | Failure Brain: recall recept przed diagnozą, confidence growth, dedup |
| 6 | Klasyfikacja błędów + wskazówki naprawcze | 8 | **8** | Hermes: 6 typów; my: `classifyFailure` ~10 klas + `recommendedNextStep` |
| | **Podsuma B** | 15 | **17** | My +2 — tu jesteśmy do przodu |

### C. „Rośnie z Tobą” / pamięć

| # | Element | Hermes | My | Komentarz |
|---|---|:---:|:---:|---|
| 7 | Model użytkownika / personalizacja | **9** | 5 | Honcho dialectic model vs nasz statyczny szablon Working Memory |
| 8 | Bogactwo architektury pamięci | 8 | **9** | 4 warstwy + embeddingi + confidence/TTL/dedup; **ale uwaga na koszt tokenów** |
| 9 | Cross-session persistence / recall | 8 | 8 | FTS5+LLM summarization vs Mongo semantic recall — remis |
| | **Podsuma C** | **25** | 22 | Hermes +3 — głównie przez Honcho user-model |

### D. Architektura szersza

| # | Element | Hermes | My | Komentarz |
|---|---|:---:|:---:|---|
| 10 | Cognitive loop / reflektor / re-plan | 6 | **10** | in-flight `prepareStep`, levers, `stopWhen`, output scoring, depth |
| 11 | Multi-agent orchestration | 4 | **9** | meta + ~15 agentów, deliberation, review trio (inny paradygmat) |
| 12 | Governance / safety / sandboxing | 8 | 8 | transactional sandbox vs tool envelope + approval gates — remis |
| 13 | Self-healing / naprawa produkcyjna | 5 | **9** | worktree repair + blue-green + rollback ledger |
| 14 | Scheduling / background workers | 8 | 8 | durable cron vs periodic-worker-manager — remis |
| 15 | **Multi-channel gateway** | **9** | 4 | TG/Discord/Slack/WhatsApp/Signal/CLI vs Studio/API |
| 16 | Goal tracking | 4 | **8** | GoalContract (evidence/progress/completion scorer) |
| 17 | Observability / telemetry / replay | 6 | **9** | envelope telemetry, `replay:harness`, artifacts, eval dashboard |
| 18 | **Dojrzałość open-source / packaging / ekosystem** | **9** | 3 | MIT + community + `.skill` packaging vs lokalny prywatny |
| | **Podsuma D** | 59 | **68** | My +9 |

### Wynik łączny

| | Hermes | My |
|---|:---:|:---:|
| A. Pętla uczenia / skille | 33 | 24 |
| B. Uczenie na błędach | 15 | **17** |
| C. „Rośnie z Tobą” / pamięć | 25 | 22 |
| D. Architektura szersza | 59 | **68** |
| **RAZEM (max 180)** | **132** | **131** |

**Praktycznie remis (132 vs 131)** — ale siły leżą w innych miejscach. Hermes to lepiej domknięty,
osobisty, wielokanałowy asystent z autonomiczną fabryką skilli i modelem użytkownika. My to głębsza
platforma inżyniersko-operacyjna (reflektor, self-healing, multi-agent, governance, goal-tracking).
**Nie odstajesz — jesteś zoptymalizowany pod inny kształt problemu.**

## 5. Czego im brakuje, a my mamy (Twoje przewagi)

1. **In-flight Cognitive Loop/Reflector** z realnym mid-loop re-planningiem (levers, `stopWhen`, output scoring).
2. **Self-healing produkcyjny** end-to-end: worktree → review → blue-green → rollback ledger.
3. **Multi-agent orchestration** + Deliberation Council + review trio (Hermes celowo single-agent).
4. **GoalContract** — twarde śledzenie celu/evidence/progresu.
5. **Failure Brain z recall przed diagnozą** + `automation-failure-learning` z next-time guidance.
6. **Bogatsza, typowana pamięć** (embeddingi + confidence + TTL + dedup + file ledger).
7. **Governance (tool envelope)** + telemetry + **replay** całych runów.
8. **Eval-driven skill creation** (`skill-creator.md` z benchmarkiem i A/B) — metodologicznie bardziej rygorystyczne niż autonomiczny zapis Hermes.

## 6. Czego my nie mamy, a oni mają (luki do rozważenia)

Priorytety wg stosunku wartość/koszt:

1. **★ Autonomiczne domknięcie „doświadczenie → nowy skill”** (luka #2, największa). Mamy wszystkie klocki:
   `agent_events`, `memory-extractor`, `skill-creator.md`, `skill-registry`. Brakuje **workera, który po
   zadaniu ≥N tool calls (lub po udanym recovery) destyluje przebieg do draftu `SKILL.md`** i wrzuca go do
   registry (najlepiej za approval gate, żeby zachować rygor). To zamienia naszą „warstwę wiedzy” w
   „warstwę skilli” jak u Hermes, bez utraty naszego eval-rygoru.
2. **★ Self-patching skilla in-flight** (luka #3): gdy `skill.report_result(false)` powtarza się, automatycznie
   otwórz ticket „improve skill X” (re-użyj pętli self-healing) zamiast tylko obniżać `success_rate`.
3. **★ Dialectic user-model („rośnie z Tobą”, luka #7):** nasz Working Memory to statyczny szablon. Warto dodać
   **ewoluujący profil operatora** (stack, skróty, preferencje, „już mu to mówiłem”) jako osobny typ w
   `system_knowledge` (`type: user_model`) odświeżany przez workera — odpowiednik Honcho, ale na naszym substracie.
4. **Multi-channel gateway** (luka #15): jeśli zależy Ci na zasięgu „asystenta”, dodaj adaptery (np. Telegram/Slack)
   nad istniejącym API. Niższy priorytet, jeśli celem jest platforma, nie osobisty asystent.
5. **Cache-aware token economics:** Hermes pilnuje, by nauka nie rosła rachunku za tokeny. Nasza warstwowa
   pamięć + OM kompresja idą w tę stronę, ale warto **świadomie zmierzyć**, czy `system_knowledge` recall +
   precontext nie pompują kontekstu. To realne ryzyko przy rosnącej bazie wiedzy.
6. **Packaging/ekosystem** (luka #18): kompatybilność z `agentskills.io` i `.skill` dałaby wymienialność skilli
   ze światem Hermes. Opcjonalne, ale tanie i otwiera ekosystem.

## 7. Wniosek

„Czuję, że zbudowałem coś bardzo zbliżonego” — **to uzasadnione**. W ujęciu całościowym jesteś na remis z
Hermes (132 vs 131), a w obszarach reflektora, self-healingu, multi-agent, goal-trackingu i governance
jesteś **wyraźnie dalej**. Hermes wygrywa głównie trzema rzeczami, które są dobrze zdefiniowane i wykonalne
u Ciebie: **(1) autonomiczne pisanie skilli z zadań, (2) self-patching skilli, (3) dialectic user-model**.
To są trzy konkretne rozszerzenia — nie przebudowa. Masz już 80% infrastruktury pod każde z nich.

---

### Źródła (Hermes)

- https://github.com/nousresearch/hermes-agent (repo, MIT)
- https://hermes-agent.nousresearch.com/docs/ (dokumentacja)
- https://www.revolutioninai.com/2026/04/how-hermes-agent-works-learning-loop-memory-explained.html
- https://ssojet.com/blog/hermes-agent-self-evolving-skills
- https://dev.to/wonderlab/one-open-source-project-a-day-no40-hermes-agent-nous-researchs-self-improving-ai-agent-4ale
- https://www.mindstudio.ai/blog/what-is-hermes-agent-openclaw-alternative
</content>
</invoke>
