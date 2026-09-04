/**
 * Per-supplier-type cold-email drafting helpers.
 * Plan: ideas/producer-hunt-fix-v3.md §8.
 */
import type { SupplierType } from './quality.js';

export type DraftLeadContext = {
  company: string;
  email: string;
  region: string;
  rawAnalysis: string;
  personalizationHook: string;
  city?: string | null;
  productCategory?: string | null;
  brandsOrPortfolio?: string[] | null;
  servesRegions?: string[] | null;
};

// Kanoniczna stopka RODO — MUSI zawierać markery hard-checkowane przez validateDraft (PL_RODO_FOOTER):
// 'Administratorem danych jest GastroBridge', 'Cel kontaktu:', 'Źródło danych:', '"STOP"'. Trzymaj 1:1
// z PL_RODO_FOOTER_TEMPLATE w quality.ts (huntAgent dostaje ten sam tekst przez Market Pack).
const RODO_FOOTER =
  'Administratorem danych jest Organization (Data Controller). Cel kontaktu: nawiązanie relacji biznesowej w sektorze HoReCa. Źródło danych: publicznie dostępne informacje z sieci (research). Jeśli nie chcesz otrzymywać wiadomości, odpowiedz "STOP", a usuniemy Twoje dane.';

const SHARED_RULES = `
ZASADY PATRYKA:
1. Treść do 180 słów. Konkret, zero "waty" sprzedażowej.
2. ZERO emoji. Profesjonalny, ale bezpośredni ton.
3. Hook musi być na samym początku.

WYMOGI PRAWNE (RODO):
1. Nie obiecuj wysyłki oferty ani cennika bez zgody odbiorcy.
2. Nie sugeruj, że kontakt pochodzi z kupionej listy (zawsze odnoś się do researchu).
3. Na końcu maila (po podpisie) dodaj obowiązkową stopkę:
   ---
   ${RODO_FOOTER}

Zwróć WYŁĄCZNIE JSON: { "subject": "Temat maila", "body": "Treść maila" }
`.trim();

/**
 * Buduje prompt cold-emaila dopasowany do typu firmy.
 */
export function draftPromptFor(supplierType: SupplierType, lead: DraftLeadContext): string {
  const intro = `Jesteś Patrykiem, chefem który koduje i buduje GastroBridge.
Napisz krótki, profesjonalny cold-email do firmy: "${lead.company}".

KONTEKST O FIRMIE (Deep Research):
${lead.rawAnalysis}

DEDYKOWANY HOOK:
${lead.personalizationHook}`;

  const body = bodyInstructionsFor(supplierType, lead);

  return `${intro}

${body}

${SHARED_RULES}`;
}

function bodyInstructionsFor(supplierType: SupplierType, lead: DraftLeadContext): string {
  const portfolioLine = lead.brandsOrPortfolio && lead.brandsOrPortfolio.length > 0
    ? `Portfolio z researchu: ${lead.brandsOrPortfolio.slice(0, 5).join(', ')}.`
    : '';
  const reachLine = lead.servesRegions && lead.servesRegions.length > 0
    ? `Zasięg dostaw z researchu: ${lead.servesRegions.slice(0, 5).join(', ')}.`
    : '';
  const cityLine = lead.city ? `Miasto/region: ${lead.city}.` : `Region: ${lead.region}.`;
  const productLine = lead.productCategory ? `Kategoria: ${lead.productCategory}.` : '';

  switch (supplierType) {
    case 'producer':
    case 'manufacturer':
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o dostawach bezpośrednich do restauracji przez GastroBridge.
Argumenty: skrócenie łańcucha dostaw, lepsze marże dla producenta, dostęp do nowych restauracji.
Wspomnij, że obecnie prowadzimy darmowy pilotaż dla wybranych producentów (zaznacz, że jest darmowy tylko w ramach trwającego pilotażu).

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu, aby pokazać, że znasz firmę:
   - konkretny produkt lub kategorię (np. "Wasze sery kozie"),
   - region lub miejscowość,
   - odniesienie do informacji ze strony WWW lub sukcesu firmy (certyfikat, tradycja).

${productLine}
${cityLine}`.trim();

    case 'wholesaler':
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o tym, jak GastroBridge może wzmocnić ich kanał HoReCa.
Argumenty: GastroBridge agreguje popyt z restauracji, dzięki czemu hurtownia może obsłużyć więcej lokali bez kosztu pozyskania klienta. Zaznacz darmowy pilotaż dla wybranych dostawców (tylko w ramach trwającego pilotażu).
Nie nazywaj ich "producentem". Nie pisz "Wasze produkty wytwarzane".

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu:
   - kategoria asortymentu lub konkretna marka z portfolio,
   - region/zasięg dostaw,
   - sposób obsługi HoReCa (minimum zamówienia, dostawa do restauracji).

${portfolioLine}
${reachLine}
${cityLine}`.trim();

    case 'distributor':
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o tym, jak GastroBridge może wzmocnić obecność ich marek w kanale restauracyjnym.
Argumenty: GastroBridge daje dystrybutorowi widoczność wśród restauracji szukających konkretnych marek/kategorii bez kosztu sprzedażowego. Wspomnij darmowy pilotaż.
Nie nazywaj ich "producentem".

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu:
   - konkretna marka z ich portfolio,
   - specjalizacja kulinarna lub kategoria,
   - region działania.

${portfolioLine}
${reachLine}
${cityLine}`.trim();

    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o tym, jak GastroBridge może pomóc zrzeszeniu/grupie/platformie dotrzeć do nowych restauracji w modelu zbiorczym.
Argumenty: GastroBridge daje całej grupie producenckiej / kooperatywie dostęp do popytu z restauracji bez kosztu pozyskania per-członek. Darmowy pilotaż dla wybranych zrzeszeń.
Nie pisz do nich jak do pojedynczego producenta — mów o "Waszych członkach" / "gospodarstwach".

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu:
   - skala (liczba członków / gospodarstw, jeśli wynika ze źródeł),
   - kategorie produktów członków,
   - region.

${portfolioLine}
${cityLine}`.trim();

    case 'importer':
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o tym, jak GastroBridge może promować ich marki w kanale restauracyjnym, zwłaszcza fine dining / bistro szukającym specjalistycznych produktów.
Argumenty: GastroBridge daje importerowi dostęp do restauracji ceniących konkretną kuchnię/markę, bez kosztu sprzedażowego. Darmowy pilotaż dla wybranych importerów.

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum dwa konkretne elementy z researchu:
   - konkretna marka, którą reprezentują,
   - kraj pochodzenia / specjalizacja kulinarna,
   - region / target restauracji.

${portfolioLine}
${cityLine}`.trim();

    case 'unknown':
    default:
      return `CEL MAILA: zaproponowanie krótkiej rozmowy o potencjalnej współpracy w GastroBridge.
Argumenty: GastroBridge łączy dostawców żywności z restauracjami w modelu B2B. Darmowy pilotaż dla wybranych dostawców.
Nie zakładaj typu firmy — używaj neutralnego określenia "Wasza firma" zamiast "producent".

ZASADY PERSONALIZACJI:
1. Wykorzystaj minimum jeden konkretny element z researchu (produkt, kategoria, region, marka).

${cityLine}`.trim();
  }
}

/**
 * Bezpieczny fallback draft per typ — używany gdy LLM/repair/cloud zawodzą wszystkie.
 * Zawsze zawiera nazwę "GastroBridge" i pełną stopkę RODO, żeby przeszedł `validateDraft`.
 */
export function fallbackDraftFor(
  supplierType: SupplierType,
  lead: { company: string; region: string },
): { subject: string; body: string } {
  const subject = subjectForType(supplierType, lead.company);
  const opener = openerForType(supplierType, lead.region);

  const body = `Dzień dobry,

${opener}

Buduję GastroBridge – platformę B2B łączącą dostawców żywności z restauracjami w regionie ${lead.region}, z pominięciem zbędnych pośredników. Chętnie sprawdzę, czy nasz model współpracy (obecnie w darmowym pilotażu) mógłby pasować do Państwa profilu.

Czy możemy umówić krótką rozmowę?

Pozdrawiam,
Patryk (GastroBridge)

---
${RODO_FOOTER}`;

  return { subject, body };
}

function subjectForType(supplierType: SupplierType, company: string): string {
  switch (supplierType) {
    case 'wholesaler':
      return `Wzmocnienie kanału HoReCa dla ${company} – GastroBridge`;
    case 'distributor':
      return `${company} a restauracje – GastroBridge`;
    case 'importer':
      return `Marki ${company} w restauracjach – GastroBridge`;
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return `Współpraca GastroBridge x ${company} (zrzeszenie producentów)`;
    case 'manufacturer':
    case 'producer':
    case 'unknown':
    default:
      return `Współpraca GastroBridge x ${company}`;
  }
}

function openerForType(supplierType: SupplierType, region: string): string {
  switch (supplierType) {
    case 'wholesaler':
      return `Kontaktuję się w sprawie wzmocnienia Państwa obecności w kanale restauracyjnym w regionie ${region}.`;
    case 'distributor':
      return `Kontaktuję się w sprawie ekspozycji marek z Państwa portfolio wśród restauracji w regionie ${region}.`;
    case 'importer':
      return `Kontaktuję się w sprawie promocji marek importowanych w restauracjach w regionie ${region}.`;
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      return `Kontaktuję się w sprawie potencjalnej współpracy z Państwa zrzeszeniem producentów obsługującym region ${region}.`;
    case 'manufacturer':
    case 'producer':
      return `Kontaktuję się w sprawie potencjalnej współpracy z Państwa firmą jako producentem żywności z regionu ${region}.`;
    case 'unknown':
    default:
      return `Kontaktuję się w sprawie potencjalnej współpracy z Państwa firmą w regionie ${region}.`;
  }
}
