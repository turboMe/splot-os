# Orkiestracja V2 — praca ODŁOŻONA (handoff do wznowienia)

**Data zamrożenia:** 2026-07-29
**Branch:** `refactor/meta-front-durable-orchestration` @ `517673a` **w momencie zamrożenia**
(dalsza praca nad warstwą legacy szła na tym samym branchu — patrz dziennik §6 planu-dziecka
po aktualny HEAD; ten dokument opisuje stan **substratu V2**, który od zamrożenia się nie zmienił)
**Stan:** 92 commity przed `master` w momencie zamrożenia, zero rozjazdu (`master` jest przodkiem HEAD)
**Powód odłożenia:** fundament gotowy; dalsze domykanie (~17–30 sesji) nie daje widocznej
wartości, dopóki agenci nie zostaną przełączeni na nowy substrat. Priorytet przeniesiony
na warstwę agentów.

**Co robimy zamiast tego:** [`ideas/plan-dziecko-po-odlozeniu-g0.md`](../ideas/plan-dziecko-po-odlozeniu-g0.md)
— formalne dziecko planu nadrzędnego. **Uwaga: plan został po napisaniu tego handoffu
przepisany** z etapów „E0–E5" na **F1–F9** (pełna ścieżka Fal 1–10 minus G0); aktualny stan
i dziennik postępu są w §4 i §6 tamtego dokumentu.
**Warunki powrotu tutaj:** §5 planu-dziecka („czego świadomie NIE robimy") + §8
(dług i dokumenty towarzyszące) — pierwotne odesłanie do „§10" pochodzi z nieistniejącej
już wersji planu.

---

## 1. Co jest ZROBIONE i udowodnione

**Substrat (PR-1..41):** pełny pion durable orchestration na warstwie store —
komendy §8 (10/10), granice A/B/C, lease/fence/heartbeat, recovery po crashu,
timery, HTTP Meta Front, flagowe wpięcie w produkcyjny serwer.

**Test-owned runtime §19 (PR-42..51) — WSZYSTKIE owned komponenty §19.1 gotowe:**

| Komponent | PR | Dowód |
|---|---|---|
| exact Mongo DB + fail-closed lifecycle | 42 | contract check |
| raw evidence sink (5 artefaktów) | 43 | parent read-back |
| process/port/workspace/egress ownership | 44 | gate PASSED 3/3 |
| content-attestation bajtów buildu | 45 | tamper → `BUILD_ATTESTATION_MISMATCH` |
| side-effect ledger | 46 | escaped → `resourceValidationStatus FAILED` |
| crash-safe reclaim Mongo DB | 47 | live double-`SIGKILL` |
| crash-safe reclaim gate workspace | 48 | live triple-`SIGKILL` |
| fault injector (seed→schedule + ledger) | 49 | live `MONGO_DROP_CRASH_BEFORE_VERIFY` |
| fake child/grandchild proces | 50 | live TERM-ignored → KILL → tree-empty |
| provider stubs (8 providerów, 7 trybów) | 51 | 512-exchange corpus, ledger STUBBED |

**Ostatnia zielona bramka:** `gate:orchestration-test-runtime` na czystym `4073249` →
`gateStatus=PASSED`, 3/3 suite'y, build attestation 50 plików.
`check:all` exit 0, `npm run build` exit 0.

---

## 2. Co ZOSTAŁO (mapa wznowienia)

`qualificationStatus` = **NOT_QUALIFIED** i to jest poprawne — bramka pokrywa 3 z 31 suite'ów.

### Krok A — konsumpcja fixtur + iniekcja faultów (4–7 sesji)
Fixtury z PR-49/50/51 istnieją, ale **nie są wpięte** w żywe suite'y
(`e2e:orchestration-autonomous|http|service`). Do zrobienia:
- suite'y używają `provider-stubs` zamiast realnych ścieżek,
- fault injector faktycznie odpala w **26 crash-window §20.3** podczas prawdziwego przebiegu,
- każdy punkt kończy się dokładnie jednym z 4 dozwolonych wyników §20.3.

⚠️ To grzebanie w rdzeniu, nie w harnessie — **spodziewaj się realnych bugów**
(wzorzec PR-44/48/50: defekt ujawnia się dopiero, gdy ścieżka staje się osiągalna).

### Krok B — migracja 28 pozostałych suite'ów (10–18 sesji)
31 skryptów `e2e:orchestration-*`; 3 są w laboratorium, 28 działa "na wolnym powietrzu".
Każdy trzeba opakować w owned runtime, uszczelnić stubami i doprowadzić do evidence.
Praca mechaniczna × 28, ale co kilka suite'ów wyjdzie ukryty problem.

### Krok C — G8 partition/stepdown (3–5 sesji)
Wymaga **prawdziwego wielowęzłowego replica setu** (obecny to single-node udający klaster).
Dowieść: brak split-brain, brak lost outbox, brak duplicate effect przy podziale sieci
i przełączeniu primary.

**Razem do `QUALIFIED`: ~17–30 sesji (~4–7 tygodni).**

---

## 3. Jak wznowić (procedura startowa)

```bash
git checkout refactor/meta-front-durable-orchestration
npm run spike:mongo-rs:up        # efemeryczny rs0 na 27018 — ZRYWANY między sesjami
npm run check:all                # oczekiwane: exit 0
npm run gate:orchestration-test-runtime   # oczekiwane: gateStatus=PASSED, 3/3
```

**Pułapki, które kosztowały czas (nie powtarzaj):**
1. **Bramka wymaga CZYSTEGO drzewa** — `foundationValidation` sprawdza
   `worktreeState==='CLEAN'` ([test-runtime.ts:2224](../src/mastra/orchestration/testing/test-runtime.ts)).
   Commituj PR **przed** uruchomieniem gate; niepowiązane WIP odłóż `git stash push -- <ścieżki>`.
2. **Fixtury procesowe forkuj loader-free `.mjs` z `execArgv:[]`** — child pod `--import tsx`
   powoduje, że esbuild spawnuje serwis do grupy procesów (3 członków → 4, niezmiennik pada).
3. **Zawieszanie procesu w proofie** wymaga ref'owanego handle (`setInterval`) — samo
   `await new Promise<never>` pozwala Node wyjść z kodem 13.
4. **RS na 27018 jest efemeryczny** — bez `spike:mongo-rs:up` suite'y padają
   `REPLICA_SET_UNAVAILABLE` / foundation FAIL.
5. **Rozwijanie `net.Socket.connect`** musi zachować tożsamość tablicy `Symbol(normalizedArgs)`.

**Pełny dziennik postępu:** [§33 planu nadrzędnego](../ideas/meta-front-durable-orchestration-and-execution-plan.md)
— każdy PR ma wiersz z SHA, zakresem i tym, co jawnie zostało deferred.

---

## 4. Stan brancha — decyzja do podjęcia przy wznowieniu

Branch **nie jest czysto additive**. Poza `src/mastra/orchestration/` dotyka
**9 plików produkcyjnych (~620 linii)**, głównie PR-41 (SEC-001 — fail-closed
scope dla pending-message claim):

```
processors/pending-updates.ts          108 zmian
services/pending-message-queue.ts      220 zmian
tools/system/check-pending-updates.ts  135 zmian
tools/system/mongo-tools.ts             90 zmian
services/automation-precontext.ts       24 zmiany
index.ts / agent-ids.ts / mongo.ts / file-activity.ts
```

Te zmiany są **zweryfikowane** (`check:pending-message-scope` 11/11, `check:all` zielony),
ale **nigdy nie działały na produkcji**. Sama orkiestracja jest za flagą
`FEATURE_ORCHESTRATION_V2` (domyślnie OFF), więc merge nie włączy jej automatycznie —
ale wprowadzi hardening SEC-001 do produkcyjnej ścieżki pending-messages.

**Trzy opcje (do decyzji, NIE wykonane):**
- **A. Zostaw branch zamrożony** (obecny stan) — zero ryzyka, ale branch dryfuje wraz z
  rozwojem `master`; im dłużej, tym trudniejszy przyszły merge.
- **B. Zmerguj do `master`** — jedna linia rozwoju, orkiestracja uśpiona flagą; wymaga
  świadomej akceptacji hardeningu SEC-001 na produkcji + jednej sesji weryfikacji live.
- **C. Wydziel sam PR-41 (SEC-001)** do `master`, resztę zostaw na branchu — najbezpieczniejszy
  kompromis, ale wymaga cherry-picka i osobnej weryfikacji.

**Rekomendacja:** przy pracy nad agentami krócej niż ~2 miesiące → **A**.
Przy dłuższej przerwie → **C** (unikasz gnicia najważniejszej części).
