/**
 * Discovery prompts — used by Blok 1 (gather-sources + discover-via-nlm).
 *
 * Wynesione z inline prompt w producer-hunt.ts (discoverLeadsStep) aby:
 *   - mieć jedno miejsce konfiguracji "co pytać NotebookLM" przy discovery,
 *   - łatwo wstrzykiwać `userContext` z UI,
 *   - być spójnym z enrichment-prompts.ts (researchQuestionFor per typ).
 */
import type { SupplierType } from './quality.js';

export type DiscoveryContext = {
  region: string;
  productType?: string | null;
  acceptableSupplierTypes: SupplierType[];
  count: number;
  userContext?: string | null;
};

/**
 * Task brief dla Researcher Agent (PSEV) — szuka URL stron firm-kandydatów.
 *
 * Researcher z natury weryfikuje fakty i triangulującе źródła. My chcemy
 * skłonić go do trybu "URL hunting": dla każdej kandydującej firmy zwraca
 * findings.claim = "Firma X to dostawca żywności w ${region}" + sources = jej URL(e).
 */
export function researcherTaskFor(opts: DiscoveryContext): string {
  const { region, productType, acceptableSupplierTypes, count, userContext } = opts;
  const acceptableTypesText = acceptableSupplierTypes.join(', ');
  const targetCount = Math.max(count * 3, 12); // szeroka pula kandydatów — filter w NLM
  const productLine = productType
    ? `Specjalizacja produktowa: ${productType}.`
    : 'Specjalizacja: ogólna (nabiał, mięso, warzywa, sery, przetwory, mrożonki, suchy magazyn).';
  const contextLine = userContext
    ? `\n\nDODATKOWY KONTEKST OD UŻYTKOWNIKA:\n${userContext}\n`
    : '';

  return `Twoje zadanie: znajdź ${targetCount} kandydatów (URL stron firm) z regionu ${region},
które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge).

${productLine}
Akceptowane typy dostawcy: ${acceptableTypesText}.
${contextLine}
ZASADY POSZUKIWANIA:
1. Użyj search_web z różnymi zapytaniami (PSEV — Plan: rozbij na 4-6 sub-pytań per typ dostawcy).
2. Dla każdej kandydującej firmy preferuj jej oficjalną stronę WWW; dopiero jako fallback strony katalogowe / branżowe wspominające o firmie.
3. POMIŃ: panoramafirm, gowork, pkt.pl, oferteo, aleo (katalogi ogólne); Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour (B2C); restauracje, hotele, pizzerie (klienci, nie dostawcy).
4. AKCEPTUJ hurtownie HoReCa, dystrybutorów foodservice, importerów specjalistycznych, kooperatywy — to wartościowi partnerzy.
5. Nie wystarczy 1 źródło na firmę — jeśli źródło wygląda "katalogowo" (bez własnej strony), oznacz confidence=low.

FORMAT ODPOWIEDZI (ścisły JSON, zgodny z Twoim system promptem):
{
  "status": "completed|partial|failed",
  "summary": "...",
  "confidence": "high|medium|low",
  "findings": [
    {
      "claim": "Firma <NAZWA> jest <typ> żywności w ${region}",
      "sources": ["https://oficjalna-strona-firmy.pl", "https://branzowy-katalog/strona-firmy"],
      "verificationLevel": "high|medium|low"
    }
  ],
  "contradictions": [],
  "notes": "opcjonalne uwagi"
}

WAŻNE: w "sources" zwracaj URL stron, które prowadzą bezpośrednio DO INFORMACJI o danej firmie
(strona firmy lub jej karta w branżowym katalogu) — będą wczytywane do NotebookLM w kolejnym kroku.`;
}

/**
 * Pytanie do NotebookLM dla Bloku 1 (discover-via-nlm).
 *
 * Przeniesione 1:1 z dotychczasowego inline prompt w producer-hunt.ts —
 * aby nie tracić sprawdzonej w boju jakości zapytania.
 */
export function discoveryQuestionFor(opts: DiscoveryContext): string {
  const { region, productType, acceptableSupplierTypes, count, userContext } = opts;
  const acceptableTypesText = acceptableSupplierTypes.join(', ');
  const productLine = productType
    ? `Specjalizacja: ${productType}.`
    : 'Specjalizacja: ogólna (nabiał, mięso, warzywa, sery, przetwory, mrożonki, suchy magazyn).';
  const contextLine = userContext
    ? `\n\nDODATKOWY KONTEKST OD UŻYTKOWNIKA (uwzględnij przy doborze firm):\n${userContext}\n`
    : '';

  return `Na podstawie załadowanych źródeł, sporządź listę do ${count} firm z województwa ${region},
które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge).
${productLine}

Akceptowane typy dostawcy: ${acceptableTypesText}.
Definicje:
- producer        – producent / wytwórca, gospodarstwo, manufaktura, RHD
- manufacturer    – większy zakład przetwórstwa
- cooperative     – kooperatywa / spółdzielnia
- producer_group  – grupa producencka, zrzeszenie hodowców
- wholesaler      – hurtownia spożywcza, hurtownia HoReCa, cash & carry
- distributor     – dystrybutor regionalny / krajowy do gastronomii (foodservice)
- importer        – importer specjalistyczny (np. produkty włoskie, hiszpańskie, azjatyckie)
- farm_aggregator – platforma agregująca rolników / marketplace producentów
- unknown         – jeśli nie potrafisz dopasować — to też zwróć, oznacz "unknown"

Pomiń:
- portale ogłoszeniowe, katalogi firm (panoramafirm, gowork, pkt.pl, oferteo, aleo);
- duże sieci handlowe B2C (Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour);
- restauracje, hotele, pizzerie, bary jako podmiot docelowy (to są nasi klienci, nie dostawcy);
- gigantyczne sieci hurtowe (Selgros, Makro) — można je zostawić dla kontekstu, ale ICP to
  ich potencjalni dostawcy/poddostawcy.
${contextLine}
Dla każdej firmy zwróć:
1.  company: Pełna nazwa firmy
2.  supplierType: jeden z typów wyżej
3.  directToHoreca: "yes" | "limited" | "no" | "unknown" — czy sprzedają bezpośrednio do restauracji/hoteli/cateringu
4.  brandsOrPortfolio: lista 2-5 marek lub kategorii w portfolio, jeśli wynika ze źródeł
5.  servesRegions: lista województw / miast zasięgu dostaw, jeśli widać; w razie wątpliwości jedno województwo: ["${region}"]
6.  email: adres e-mail lub null (szukaj w stopkach i podstronach kontaktu)
7.  website: oficjalna strona WWW lub null
8.  city: miasto / miejscowość siedziby
9.  productCategory: konkretna kategoria (np. nabiał, mięso, warzywa, mrożonki, oliwa)
10. sourceUrls: 1-3 źródła potwierdzające typ i ofertę
11. emailSource: skąd pochodzi e-mail, jeśli jest
12. isProducer: true tylko gdy źródło wskazuje realne wytwarzanie. Dla hurtowni/dystrybutorów/importerów — false.
13. confidence: liczba 0-1 — pewność, że firma istnieje i pasuje do typu
14. reason: 1 zdanie — co konkretnie oferują i komu sprzedają

Zasady:
- Nie wpisuj "Brak danych" ani "brak" — używaj null.
- Jeśli firma jest restauracją/hotelem (końcowym konsumentem), nie umieszczaj jej na liście.
- Jeśli widzisz hurtownię HoReCa lub dystrybutora foodservice — DOPISZ JĄ. To są wartościowi
  partnerzy GastroBridge, nie filtruj ich jako "pośredników".
- Jeśli nie potrafisz określić typu — supplierType: "unknown" (lead pójdzie do research_needed,
  ale go nie odrzucamy automatycznie).

Zwróć WYŁĄCZNIE JSON w formacie:
{ "leads": [
  {
    "company": "...",
    "supplierType": "wholesaler",
    "directToHoreca": "yes",
    "brandsOrPortfolio": ["..."],
    "servesRegions": ["..."],
    "email": null,
    "website": null,
    "city": "...",
    "productCategory": "...",
    "sourceUrls": ["..."],
    "emailSource": null,
    "isProducer": false,
    "confidence": 0.8,
    "reason": "..."
  }
] }`;
}

/**
 * Instrukcja dla Knowledge Agent w Bloku 1b (discover-via-nlm).
 *
 * Knowledge agent dostaje ją jako user-message i zarządza mechaniką NLM
 * (create notebook, add sources, wait, query, parse, cleanup).
 */
export function knowledgeAgentDiscoveryInstruction(opts: {
  taskId: string;
  region: string;
  notebookTitle: string;
  sources: Array<{ url: string; title?: string }>;
  discoveryQuestion: string;
  count: number;
}): string {
  const { taskId, region, notebookTitle, sources, discoveryQuestion, count } = opts;
  const sourceList = sources
    .map((s, i) => `${i + 1}. ${s.url}${s.title ? ` — ${s.title}` : ''}`)
    .join('\n');

  return `Producer-hunt discovery (taskId=${taskId}, region=${region}).

WYKONAJ:
1. Stwórz NOWY notebook o tytule: "${notebookTitle}"
2. Dodaj poniższe ${sources.length} URL jako źródła (wait=True, wait_timeout=120):
${sourceList}
3. Odczekaj na indeksowanie (jeśli któreś źródło fail — kontynuuj z pozostałymi).
4. Zadaj DOKŁADNIE to pytanie do notebooka (timeout 180s):
---
${discoveryQuestion}
---
5. Zachowaj answer bez modyfikacji.
6. USUŃ notebook (cleanup) — to tymczasowy notebook discovery.
7. Zwróć WYŁĄCZNIE JSON w formacie:
{
  "status": "completed|partial|failed",
  "notebookId": "<id który zostal utworzony, dla audytu>",
  "leads": [ /* dokładnie taki array jak zwrócił notebook w odpowiedzi na pytanie — do ${count} pozycji */ ],
  "notes": "opcjonalne uwagi techniczne (np. ile źródeł nie zaindeksowało się)"
}

UWAGI:
- NIE wymyślaj firm — jeśli odpowiedź notebooka jest słaba, status="partial" i podaj co mniej.
- NIE zmieniaj struktury leads (zachowaj wszystkie pola: company, supplierType, directToHoreca, brandsOrPortfolio, servesRegions, email, website, city, productCategory, sourceUrls, emailSource, isProducer, confidence, reason).
- Cleanup wykonaj nawet jeśli query failed (poza tym pozostaje śmietnik).`;
}
