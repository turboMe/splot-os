/**
 * Per-supplier-type enrichment helpers — used by producer-hunt enrich-leads step.
 * Plan: ideas/producer-hunt-fix-v3.md §5.
 */
import type { SupplierType } from './quality.js';

export type EnrichmentLeadContext = {
  company: string;
  website?: string | null;
  facebook?: string | null;
  linkedIn?: string | null;
  city?: string | null;
  productCategory?: string | null;
};

/**
 * Domyślny hook per typ — używany gdy LLM/NLM nie zwrócił własnego hooka,
 * albo gdy identity-mismatch zmusza nas do bezpiecznej wartości.
 */
export function defaultHookForType(supplierType: SupplierType, region: string): string {
  switch (supplierType) {
    case 'wholesaler':
      return `Hurtownia spożywcza obsługująca region ${region}.`;
    case 'distributor':
      return `Dystrybutor żywności obsługujący ${region}.`;
    case 'importer':
      return `Importer specjalistyczny w regionie ${region}.`;
    case 'cooperative':
    case 'producer_group':
      return `Zrzeszenie producentów z regionu ${region}.`;
    case 'farm_aggregator':
      return `Platforma producentów z regionu ${region}.`;
    case 'manufacturer':
      return `Zakład przetwórstwa z regionu ${region}.`;
    case 'producer':
    case 'unknown':
    default:
      return `Producent żywności z regionu ${region}.`;
  }
}

/**
 * Generuje listę URL podstron, które warto dodać do NotebookLM dla danego typu.
 * Zwraca surowe ścieżki — wywołujący skleja je z bazową stroną firmy.
 *
 * NotebookLM toleruje 404, więc nie pre-fetchujemy.
 */
export function additionalSourcePathsForType(supplierType: SupplierType): string[] {
  switch (supplierType) {
    case 'producer':
    case 'manufacturer':
      return ['/o-nas', '/produkty', '/aktualnosci', '/kontakt'];
    case 'wholesaler':
      return ['/asortyment', '/oferta', '/dla-gastronomii', '/horeca', '/cennik', '/kontakt'];
    case 'distributor':
      return ['/marki', '/portfolio', '/oferta', '/horeca', '/kontakt'];
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return ['/o-nas', '/czlonkowie', '/produkcja', '/aktualnosci', '/kontakt'];
    case 'importer':
      return ['/marki', '/portfolio', '/dla-gastronomii', '/kontakt'];
    case 'unknown':
    default:
      return ['/o-nas', '/oferta', '/kontakt'];
  }
}

/**
 * Dodatkowe zapytanie Tavily, które wzbogaca kontekst snippetów per typ.
 * Zwraca null jeśli typ nie wymaga ekstra zapytania.
 */
export function additionalSearchQueryForType(
  supplierType: SupplierType,
  company: string,
): string | null {
  switch (supplierType) {
    case 'wholesaler':
      return `"${company}" hurtownia HoReCa minimum zamówienia dostawa restauracje`;
    case 'distributor':
      return `"${company}" dystrybutor marki regiony dostaw HoReCa`;
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return `"${company}" zrzeszenie ilu członków produkty kontakt`;
    case 'importer':
      return `"${company}" import marek dystrybucja Polska kontakt`;
    case 'producer':
    case 'manufacturer':
      return null;
    case 'unknown':
    default:
      return null;
  }
}

/**
 * Pytanie do NotebookLM dopasowane do typu firmy.
 * Każdy szablon kończy się sekcjami `PERSONALIZATION_HOOK:`, `DEEP_ANALYSIS:`
 * oraz `EXTRACT_EMAIL:` — regex w enrich-leads
 * (`/PERSONALIZATION_HOOK:\s*(.*)/`, `/DEEP_ANALYSIS:\s*(.*)/s`,
 * `/EXTRACT_EMAIL:\s*(.*)/`) wymaga tych dokładnych nagłówków.
 *
 * EXTRACT_EMAIL: NotebookLM widzi pełne treści stron firmy (w tym /kontakt),
 * więc to najlepszy moment na ekstrakcję email — zamiast tworzyć osobny
 * notebook w extract-emails step. Wartość "null" jeśli brak.
 */
export function researchQuestionFor(
  supplierType: SupplierType,
  lead: EnrichmentLeadContext,
): string {
  const company = lead.company;

  switch (supplierType) {
    case 'producer':
    case 'manufacturer':
      return `Co konkretnie wytwarza firma "${company}"?
1. Lista produktów lub kategorii (sery, wędliny, pieczywo, soki, przetwory, ...).
2. Skala produkcji (rzemieślnicza / średnia / przemysłowa).
3. Certyfikaty (Produkt Lokalny, RHD, Bio, ISO, BRC/IFS).
4. Tradycja / historia / wartości (rodzina, eko, naturalne).

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, konkretne odniesienie do ich produktu lub historii.
- DEEP_ANALYSIS: 4-6 zdań o tym, co produkują, dla kogo i co GastroBridge może im zaproponować.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki / strony zamówień, lub "null" jeśli brak (priorytet: kontakt handlowy / sprzedaż > ogólny biuro@ > brak).`;

    case 'wholesaler':
      return `Co oferuje hurtownia "${company}"?
1. Główne kategorie asortymentu (mięso, nabiał, warzywa, owoce, mrożonki, suchy magazyn, ...).
2. Marki własne i marki obce w portfolio.
3. Czy obsługują HoReCa (restauracje, hotele, catering)? Czy mają minimum zamówienia?
4. Zasięg dostaw (jakie województwa / miasta).

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odniesienie do ich oferty HoReCa lub konkretnej kategorii.
- DEEP_ANALYSIS: 4-6 zdań o portfolio, zasięgu i tym, jak GastroBridge może im pomóc dotrzeć do nowych restauracji.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki / cennika, lub "null" jeśli brak (priorytet: kontakt handlowy / HoReCa > biuro > brak).`;

    case 'distributor':
      return `Co dystrybuuje firma "${company}"?
1. Marki w portfolio (5-10 najważniejszych).
2. Specjalizacja kategorii (np. kuchnia włoska, kuchnia azjatycka, słodycze premium, mrożonki).
3. Region działania.
4. Czy są ekskluzywnym przedstawicielem jakichś marek?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odwołanie do konkretnej marki z ich portfolio lub specjalizacji.
- DEEP_ANALYSIS: 4-6 zdań o ich pozycji rynkowej i tym, czemu warto, żeby restauracje GastroBridge ich zauważyły.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki, lub "null" jeśli brak (priorytet: sprzedaż / przedstawiciel handlowy > biuro > brak).`;

    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return `Czym jest "${company}"?
1. Ile gospodarstw / producentów zrzesza (jeśli źródła podają)?
2. Jakie kategorie produktów reprezentują (warzywa, mięso, mleko, ...)?
3. Czy sprzedają zbiorczo, czy każdy członek osobno?
4. Czy obsługują HoReCa?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odniesienie do skali zrzeszenia, regionu lub charakteru kooperatywy.
- DEEP_ANALYSIS: 4-6 zdań o strukturze, asortymencie członków i potencjale współpracy z GastroBridge.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki, lub "null" jeśli brak (priorytet: koordynator / zarząd > sekretariat > brak).`;

    case 'importer':
      return `Co importuje firma "${company}"?
1. Marki / kraje pochodzenia produktów.
2. Specjalizacja kulinarna (włoska, francuska, hiszpańska, azjatycka, ...).
3. Czy mają wyłączność na jakieś marki?
4. Czy obsługują restauracje fine dining / casual / sieciowe?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odniesienie do ich konkretnej marki, kraju pochodzenia lub specjalizacji.
- DEEP_ANALYSIS: 4-6 zdań o ich portfolio i wartości dla restauracji oraz tym, jak GastroBridge może wspierać ich dystrybucję.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki, lub "null" jeśli brak (priorytet: sprzedaż / HoReCa > biuro > brak).`;

    case 'unknown':
    default:
      return `Co oferuje firma "${company}"?
1. Czy są producentem, hurtownią, dystrybutorem, importerem, czy kooperatywą?
2. Jakie produkty / marki są w ich ofercie?
3. Czy sprzedają do restauracji / hoteli / cateringu?
4. Region działania (województwo, miasta).

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, neutralne (nie zakładaj typu).
- DEEP_ANALYSIS: 4-6 zdań — co konkretnie wiadomo o firmie ze źródeł i co GastroBridge może jej zaproponować.
- EXTRACT_EMAIL: jeden najlepszy adres e-mail z /kontakt / stopki, lub "null" jeśli brak.`;
  }
}

/**
 * Buduje finalny prompt dla LLM, który dokończa enrichment per typ. Wynik to prompt
 * zwracający `enrichmentResponseSchema`-zgodny JSON.
 */
export function finalEnrichmentPromptFor(args: {
  supplierType: SupplierType;
  lead: EnrichmentLeadContext;
  researchWebsite: string | null;
  website: string | null;
  sourceUrls: string;
  reason: string | null;
  nlmAnalysis: string;
  nlmHook: string;
  marketContext: string;
  leadContext: string;
  region: string;
}): string {
  const {
    supplierType, lead, researchWebsite, website, sourceUrls, reason,
    nlmAnalysis, nlmHook, marketContext, leadContext, region,
  } = args;

  const typeContext = supplierTypeBriefingFor(supplierType);

  return `Dokończ research firmy "${lead.company}" w kontekście GastroBridge (B2B platforma łącząca dostawców żywności z restauracjami).

Typ dostawcy (z discovery / heurystyki): ${supplierType}.
${typeContext}

Strona: ${researchWebsite ?? website ?? 'nieznana'}.
Miasto: ${lead.city ?? 'nieznane'}.
Kategoria z discovery: ${lead.productCategory ?? 'nieznana'}.
Region inputu: ${region}.

Źródła z discovery:
${sourceUrls || 'Brak.'}
Oryginalny powód discovery: ${reason ?? 'lokalny dostawca żywności'}.

Dane z głębokiego researchu (NotebookLM):
${nlmAnalysis || 'Brak.'}
Hook z NLM: ${nlmHook || 'Brak.'}

Kontekst rynkowy:
${marketContext || 'Brak.'}

Wyniki wyszukiwania (snippets):
${leadContext || 'Brak.'}

Reguły:
1. Nie podmieniaj firmy na inną o podobnej nazwie.
2. Jeśli nie potrafisz potwierdzić, że źródło dotyczy dokładnie tej firmy, ustaw "identityConfidence" poniżej 0.5.
3. Klasyfikuj typ — pole "supplierType" musi być spójne ze źródłami. Jeśli zmieniasz względem discovery, dodaj "identityWarning".
4. Hook ma być zgodny z typem — dla hurtowni/dystrybutora odwołuj się do oferty HoReCa lub portfolio marek, nie do "rzemieślniczego wytwarzania".
5. "rawAnalysis" to 4-6 zdań o firmie i potencjale współpracy z GastroBridge.

Zwróć WYŁĄCZNIE JSON:
{
  "companyName": "Potwierdzona nazwa firmy",
  "supplierType": "${supplierType}",
  "directToHoreca": "yes | limited | no | unknown",
  "brandsOrPortfolio": ["..."],
  "servesRegions": ["..."],
  "personalizationHook": "Finalny 1-2 zdaniowy hook do maila",
  "rawAnalysis": "Podsumowanie: kim są, co oferują, potencjał współpracy z GastroBridge",
  "website": "...",
  "linkedIn": "...",
  "facebook": "...",
  "identityConfidence": 1.0
}`;
}

function supplierTypeBriefingFor(supplierType: SupplierType): string {
  switch (supplierType) {
    case 'producer':
    case 'manufacturer':
      return 'Skup się na produktach, skali wytwarzania, certyfikatach (Produkt Lokalny, RHD, Bio) i historii rodzinnej / wartościach.';
    case 'wholesaler':
      return 'Skup się na asortymencie, kategoriach produktowych, marżach i obsłudze HoReCa (minimum zamówienia, dostawy do restauracji, region zasięgu).';
    case 'distributor':
      return 'Skup się na portfolio marek, specjalizacji kulinarnej, ekskluzywnych przedstawicielstwach i obsłudze foodservice.';
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return 'Skup się na strukturze (ilu członków / gospodarstw), kategoriach produktów członków i modelu sprzedaży zbiorczej.';
    case 'importer':
      return 'Skup się na markach importowanych, krajach pochodzenia, ekskluzywnościach i specjalizacji kulinarnej (np. kuchnia włoska, hiszpańska, azjatycka).';
    case 'unknown':
    default:
      return 'Najpierw spróbuj ustalić typ firmy ze źródeł. Jeśli nie da się — zostaw "supplierType": "unknown".';
  }
}
