---
name: wireframe-before-delegation
category: meta
description: >-
  Fast text wireframe to lock information architecture and screen zoning with the user before a
  visual task is delegated. Produces a block sketch and an annotated interaction list, never a
  styled artifact. Trigger when a UI/visual request is underspecified in its structure.
keywords: [wireframe, information-architecture, layout-sketch, pre-delegation, scoping, ui-structure, brief]
allowedTools: [artifact_put, system_delegate_task]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 900
outputFormat: markdown
tags: [meta, wireframe, scoping, delegation, ui]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Wireframe Before Delegation

## 1. What this is for — and the line it must not cross

A visual request arrives with the structure unstated: *"zrób nam panel zamówień"*. Delegating that
verbatim means `designAgent` spends its budget guessing the information architecture, and the first
review is about layout, not craft.

This skill produces a **60-second block sketch** whose only job is to make the structure agreeable so
the delegated brief carries it. It is a scoping instrument.

**Hard boundary:** the sketch is never the deliverable and never becomes one. Do not style it, do not
turn it into HTML, do not "just polish it a bit". The moment the artifact is meant to be *seen* by
anyone outside this conversation, it is a design deliverable and belongs to `designAgent`
(`meta/base.md §6`). If you find yourself choosing a colour, you have crossed the line.

## 2. The sketch

Blocks, labels, and placeholders. No colour, no type choices, no spacing decisions.

```
+---------------------------------------------------------------+
| [Logo]  GastroBridge     Zamówienia  Dostawcy  Analityka  [PK] |
+---------------------------------------------------------------+
| ZAMÓWIENIA                          [ + Nowe zamówienie ]      |
|                                                                |
| +----------------+ +----------------+ +----------------+       |
| | Oczekujące     | | W drodze       | | Rozliczone dziś|       |
| | [ 14 ]         | | [ 6 ]          | | [ 42 850 PLN ] |       |
| +----------------+ +----------------+ +----------------+       |
|                                                                |
| OSTATNIE ZAMÓWIENIA                        [filtr: status v]   |
| +------+-------------+---------------+----------+---------+    |
| | ID   | Restauracja | Pozycje       | Status   | Akcja   |    |
| +------+-------------+---------------+----------+---------+    |
| |#1042 | Trattoria   | 240 kg warzyw | Oczekuje | [Podgl.]|    |
| +------+-------------+---------------+----------+---------+    |
+---------------------------------------------------------------+
```

Then the part that actually carries information — **annotate the behaviour**:

- `[+ Nowe zamówienie]` → otwiera drawer, nie nową stronę
- `[Podgląd]` → rozwija wiersz w miejscu; szczegóły dostawcy + historia cen
- Kafle KPI → klikalne, filtrują tabelę poniżej
- Stan pusty: brak zamówień → CTA „Dodaj pierwsze", nie pusta tabela
- Nieznane: czy status ma 3 czy 5 wartości? → **do potwierdzenia przed delegacją**

## 3. Three checks before you hand it over

1. **Is the most important thing first?** Reading order is top-left first. If the primary decision
   the user makes on this screen is not there, the structure is wrong regardless of styling.
2. **Does every interactive element say what it does?** An unannotated button is a decision passed
   downstream.
3. **Are the empty, loading, and error states named?** They are half of a real interface and the
   first thing a rushed brief omits.

## 4. Handing off

The sketch plus its annotations go into the `system_delegate_task` brief for `designAgent` —
structure agreed, style deliberately unspecified. State it explicitly:

> Struktura i zachowania jak w szkicu poniżej. Kierunek wizualny, typografia, kolor i kompozycja —
> Twoja decyzja; szkic nie jest propozycją stylu.

Anything genuinely undecided goes to the user as **2-4 concrete options with a recommendation**,
not as an open question — and only if it is not discoverable from the repo or existing product.
