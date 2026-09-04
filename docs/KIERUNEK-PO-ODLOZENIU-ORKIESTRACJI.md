# Kierunek po odłożeniu orkiestracji

> **Ten dokument został zastąpiony.**
> Aktualny, szczegółowy plan pracy to
> [`ideas/plan-dziecko-po-odlozeniu-g0.md`](../ideas/plan-dziecko-po-odlozeniu-g0.md) —
> formalne dziecko [planu nadrzędnego](../ideas/meta-front-durable-orchestration-and-execution-plan.md).

---

## Dlaczego ten plik jeszcze istnieje

Powstał 2026-07-29 pod nazwą `KIERUNEK-META-FRONT.md` i **nazwa była myląca**:
sugerowała kontynuację „Meta Frontu" z planu nadrzędnego, podczas gdy dotyczyła
dzisiejszego `metaAgenta` — czegoś zupełnie innego.

| | „Meta Front" (plan nadrzędny §4.1) | „metaAgent" (dziś) |
|---|---|---|
| Czym jest | **nowa warstwa V2** do zbudowania | istniejący agent |
| Co robi | tworzy durable joby, pokazuje status | **sam wykonuje** przez `delegate-task` |
| Stan | część **odłożonej** orkiestracji | działa produkcyjnie |

Zweryfikowane w kodzie: `metaAgent` używa komend V2 (`start_job`, `get_job_status`, …)
**zero razy**. Plik zachowany jako ślad decyzji, nie jako źródło prawdy.

## Co z niego zostało w mocy

- **Decyzja:** orkiestracja odłożona, pracujemy nad warstwą, która realnie działa.
- **Etap 1 (fundament czasu) — ZREALIZOWANY**, choć inaczej niż pierwotnie zapisano:
  zamiast podnosić arbitralne sufity (objaw), przebudowano mechanizm na **liveness**
  (przyczyna). Plan: [`ideas/liveness-budget-plan.md`](../ideas/liveness-budget-plan.md),
  commity `40e1ef5`…`48e0ea0`. W planie-dziecku figuruje jako **E0**.
- **Zasady „nie popsuć"** — przeniesione do §2 planu-dziecka i tam rozwinięte.

## Co się zmieniło względem pierwotnego zapisu

Pierwotne „Etap 2 (delegacja) → Etap 3 (reflektor)" było **propozycją powstałą w trakcie
sesji**, nie kontynuacją ustalonego planu. W planie-dziecku zostało to osadzone w strukturze
rodzica:

- dawny Etap 2 → **E3** (weryfikacja live P1–P5 + P7), poprzedzony **E2** (sieroty
  delegacji — bo rodzic wymienia to wprost jako patologię Fali 5),
- doszły **E1** (włączenie liveness + pętla zwrotna), **E4** (pipeline pod ochroną),
  **E5** (dług punktowy),
- reflektor (dawny Etap 3) **nie jest** dziś priorytetem — wraca, gdy jakość biegów zacznie
  boleć bardziej niż ich niezawodność.
