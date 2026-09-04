# Producer Hunt: drafty cold-mail per typ

Ten dokument opisuje fazę draftowania po PR E. Przed PR E workflow miał jeden inline prompt
mówiący "krótki, profesjonalny cold-email do producenta" + jeden szablon fallbacku zaczynający
się "Buduję GastroBridge – platformę, która pomaga lokalnym producentom". Niezależnie od
typu firmy mail brzmiał jak do producenta. Po PR E każdy typ ma własne instrukcje promptu,
własny temat fallbacku i własny opener fallbacku.

Plan: [ideas/producer-hunt-fix-v3.md §8](../ideas/producer-hunt-fix-v3.md).
Klasyfikacja: [producer-hunt-supplier-types.md](producer-hunt-supplier-types.md).
Enrichment: [producer-hunt-enrichment.md](producer-hunt-enrichment.md).

## Plik: [draft-prompts.ts](../src/mastra/workflows/producer-hunt/draft-prompts.ts)

| Funkcja                                       | Cel                                                    |
| ---                                           | ---                                                    |
| `draftPromptFor(supplierType, lead)`          | Pełny prompt LLM dla cold-emaila z instrukcjami per typ|
| `fallbackDraftFor(supplierType, lead)`        | Bezpieczny szablon `{ subject, body }` z RODO i GastroBridge |
| prywatny `bodyInstructionsFor(...)`           | Sekcja CEL MAILA + ZASADY PERSONALIZACJI per typ       |
| prywatny `subjectForType(...)`                | Wariant tematu fallbacku per typ                       |
| prywatny `openerForType(...)`                 | Otwierające zdanie fallbacku per typ                   |

Wspólne reguły są stałe (`SHARED_RULES`):

- 180 słów, zero emoji, hook na początku,
- nie obiecujemy oferty/cennika bez zgody,
- pełna stopka RODO,
- output: tylko JSON `{ subject, body }`.

## Treść per typ

### Producer / manufacturer

CEL: krótka rozmowa o dostawach bezpośrednich do restauracji.
ARGUMENT: skrócenie łańcucha, lepsze marże, dostęp do nowych restauracji. Darmowy pilotaż.
PERSONALIZACJA: konkretny produkt/kategoria, region, odniesienie do strony/sukcesu/certyfikatu.

### Wholesaler

CEL: wzmocnienie kanału HoReCa.
ARGUMENT: GastroBridge agreguje popyt z restauracji, hurtownia obsługuje więcej lokali bez kosztu pozyskania klienta.
PERSONALIZACJA: kategoria asortymentu lub konkretna marka z portfolio, region/zasięg, sposób obsługi HoReCa.
JAWNY ZAKAZ: nie nazywać "producentem", nie pisać "Wasze produkty wytwarzane".

### Distributor

CEL: ekspozycja marek z portfolio w restauracjach.
ARGUMENT: widoczność wśród restauracji szukających konkretnych marek bez kosztu sprzedażowego.
PERSONALIZACJA: konkretna marka z portfolio, specjalizacja kulinarna, region.

### Cooperative / producer_group / farm_aggregator

CEL: dostęp do popytu z restauracji w modelu zbiorczym.
ARGUMENT: zrzeszenie/grupa zyskuje dostęp do restauracji bez kosztu pozyskania per-członek.
PERSONALIZACJA: skala (liczba członków, jeśli wynika ze źródeł), kategorie, region.
JAWNY ZAKAZ: nie pisać jak do pojedynczego producenta — używać "Waszych członkach" / "gospodarstwach".

### Importer

CEL: promocja marek importowanych w kanale restauracyjnym (fine dining / bistro).
ARGUMENT: dostęp do restauracji ceniących konkretną kuchnię/markę bez kosztu sprzedażowego.
PERSONALIZACJA: konkretna marka, kraj pochodzenia / specjalizacja, target restauracji.

### Unknown

CEL: neutralna propozycja rozmowy o współpracy w GastroBridge.
JAWNY ZAKAZ: nie zakładać typu, używać neutralnego "Wasza firma".
PERSONALIZACJA: minimum jeden konkretny element z researchu.

## Fallback subject + opener per typ

| Typ              | Subject                                              | Opener (skrót)                                                 |
| ---              | ---                                                  | ---                                                            |
| `producer` / `manufacturer` | `Współpraca GastroBridge x ${company}`        | "...współpracy z Państwa firmą jako producentem żywności..."   |
| `wholesaler`     | `Wzmocnienie kanału HoReCa dla ${company} – GastroBridge` | "...wzmocnienia Państwa obecności w kanale restauracyjnym..." |
| `distributor`    | `${company} a restauracje – GastroBridge`            | "...ekspozycji marek z Państwa portfolio wśród restauracji..." |
| `importer`       | `Marki ${company} w restauracjach – GastroBridge`    | "...promocji marek importowanych w restauracjach..."           |
| `cooperative` / `producer_group` / `farm_aggregator` | `Współpraca GastroBridge x ${company} (zrzeszenie producentów)` | "...współpracy z Państwa zrzeszeniem producentów..." |
| `unknown`        | `Współpraca GastroBridge x ${company}`               | "...potencjalnej współpracy z Państwa firmą..."                |

Wszystkie warianty kończą się stopką RODO i nazwą GastroBridge — `validateDraft` zawsze
przejdzie.

## Zmiany w `validateDraft`

Plik: [quality.ts](../src/mastra/workflows/producer-hunt/quality.ts).

Hard rules bez zmian:
- `subject.length >= 5`,
- brak placeholderów (`[Twoje Imię i Nazwisko]`, `[imię]`, `[nazwa firmy]`, `{{`, `}}`, `[...]`, `XYZ`),
- musi być `GastroBridge`,
- brak wymyślonych nazw (`Gastro-Supply`, `Gastro Market`),
- pełna stopka RODO (`Administratorem danych jest GastroBridge` + `Odpisz "NIE"`).

Soft warnings:
- body < 200 znaków → `Draft może być za krótki`.
- brak słów z `rawAnalysis` → `Draft może nie używać konkretów z researchu`.
- **NEW (PR E)**: brak żadnego z keywordów `[produkt, asortyment, portfolio, marki, oferta, dostarcza, dystrybu, importu, członkow, zrzesz, wytwarza, horeca, gastronom]` → `Draft nie odwołuje się do oferty/asortymentu/portfolio firmy`.

Soft check jest neutralny — pasuje do producenta (`produkt`, `wytwarza`), hurtowni
(`asortyment`, `oferta`, `horeca`, `gastronom`), dystrybutora (`portfolio`, `marki`,
`dystrybu`), importera (`importu`, `marki`), kooperatywy (`członkow`, `zrzesz`).

Soft warning nie blokuje draftu — tylko trafia do logów. Hard fail nadal próbuje repair → cloud → fallback.

## CRM segment

Z PR A: `update-crm` i `save-drafts-fs` używają `mapToCrmSegment(inferredSupplierType)`.
Po PR E `inferredSupplierType` na `EnrichedLead` jest spójnie ustawione od enrichmentu (PR D),
więc finalny segment CRM jest dokładny.

W `db.leads` po wysłaniu draftu:

```js
db.leads.findOne({ email: "kontakt@hurtownia-x.pl" })
// {
//   segment: "wholesaler",
//   metadata: {
//     supplierType: "wholesaler",
//     enrichment: { ..., inferredSupplierType: "wholesaler" },
//     draft: { subject: "Wzmocnienie kanału HoReCa dla Hurtownia X – GastroBridge", body: "..." }
//   }
// }
```

W filesystemie ([drafts-store.ts](../src/mastra/lib/drafts-store.ts)) draft.meta.json zawiera:

```json
{
  "segment": "wholesaler",
  "supplierType": "wholesaler",
  "type": "cold-email",
  "language": "pl",
  ...
}
```

## Diagnostyka

Konsola draftowania:

```
[producer-hunt:<taskId>] drafting email for Hurtownia X (kontakt@hurtownia-x.pl) type=wholesaler...
[producer-hunt:<taskId>] generated 6 drafts.
```

Podgląd draftu w `db.approvals`:

```js
db.approvals.findOne({ taskId: "<taskId>" })
// {
//   drafts: [
//     { draftId, email, company: "Hurtownia X", subject: "Wzmocnienie kanału HoReCa..." }
//   ]
// }
```

## Test regresji producencki

PR E nie powinien zmieniać draftów dla typów `producer` / `manufacturer`. Treść `bodyInstructionsFor('producer', ...)` zawiera te same elementy co prompt sprzed PR E:

- "krótki, profesjonalny cold-email do firmy ${company}" (było: "do producenta"),
- CEL: dostawy bezpośrednie + skrócenie łańcucha + lepsze marże + darmowy pilotaż,
- PERSONALIZACJA: konkretny produkt, region, certyfikat/sukces firmy,
- 180 słów, zero emoji, RODO, JSON output.

Jedyna realna zmiana dla producenta to subject fallbacku — dalej `Współpraca GastroBridge x ${company}` (bez zmian) — i opener fallbacku, który wcześniej zaczynał się od "Buduję GastroBridge", teraz od "Kontaktuję się w sprawie potencjalnej współpracy z Państwa firmą jako producentem żywności z regionu ${region}." Pisany jest dłuższy, bardziej konwencjonalny — ale wciąż w 180 słów i wciąż z RODO.

## Co PR E zamyka

PR E to ostatni krok rozszerzenia z producer-only na multi-type. Po PR E:

1. Discovery (PR B+C) wraca z bogatym basenem typów.
2. Klasyfikacja (PR A) ustawia typ na lead.
3. Filtr `acceptableSupplierTypes` (PR A) odrzuca typy poza listą.
4. Scoring (PR A) per typ.
5. Enrichment (PR D) z multi-source, per-typ pytaniami i prompt finalnym per typ.
6. Identity guardrail (PR A) z tolerancją hurtowni i drift-checkiem.
7. **Drafty (PR E) per typ** + segment CRM per typ.

Ścieżka producent zostaje wstecznie kompatybilna. Hurtownia, dystrybutor, importer, kooperatywa
trafiają teraz do draftu z mailem dopasowanym do typu.

## Zakres poza PR E

Świadomie poza zakresem v3 (zostaje na osobne PR-y):

- Per-type approval flow w UI dashboardu,
- REGON/KRS confirmation,
- Specjalizowana baza domen HoReCa (Selgros/Eurocash/Bidfood) jako "graf klientów".
