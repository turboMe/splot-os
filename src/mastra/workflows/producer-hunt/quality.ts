export type SupplierType =
  | 'producer'
  | 'manufacturer'
  | 'cooperative'
  | 'producer_group'
  | 'wholesaler'
  | 'distributor'
  | 'importer'
  | 'farm_aggregator'
  | 'unknown';

export type DirectToHoreca = 'yes' | 'limited' | 'no' | 'unknown';

export const ACCEPTABLE_SUPPLIER_TYPES: SupplierType[] = [
  'producer',
  'manufacturer',
  'cooperative',
  'producer_group',
  'wholesaler',
  'distributor',
  'importer',
  'farm_aggregator',
];

export type LeadQuality = {
  score: number;
  decision: 'draft_candidate' | 'research_needed' | 'reject';
  reasons: string[];
  inferredSupplierType: SupplierType;
};

type LeadForScoring = {
  company: string;
  companyName?: string | null;
  email?: string | null;
  website?: string | null;
  reason?: string | null;
  rawAnalysis?: string | null;
  personalizationHook?: string | null;
  city?: string | null;
  productCategory?: string | null;
  sourceUrls?: string[] | string | null;
  emailSource?: string | null;
  isProducer?: boolean | null;
  confidence?: number | null;
  supplierType?: SupplierType | null;
  directToHoreca?: DirectToHoreca | null;
  servesRegions?: string[] | null;
  brandsOrPortfolio?: string[] | null;
};

export function mapToCrmSegment(type: SupplierType): string {
  switch (type) {
    case 'wholesaler':       return 'wholesaler';
    case 'distributor':      return 'distributor';
    case 'importer':         return 'importer';
    case 'cooperative':
    case 'producer_group':   return 'cooperative';
    case 'farm_aggregator':  return 'aggregator';
    case 'manufacturer':     return 'manufacturer';
    case 'producer':         return 'producer';
    default:                 return 'unknown';
  }
}

const MISSING_VALUES = new Set([
  '',
  '-',
  'brak',
  'brak danych',
  'nie podano',
  'nieznana',
  'nieznany',
  'null',
  'undefined',
  'n/a',
]);

const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'op.pl',
  'poczta.fm',
  'gazeta.pl',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
];

const DIRECTORIES = [
  'gowork.pl',
  'panoramafirm.pl',
  'pkt.pl',
  'biznesfinder.pl',
  'ksiazka-telefoniczna.pl',
  'katalog-firm.pl',
  'aleo.com',
  'owg.pl',
  'cylex.pl',
  'infoveriti.pl',
  'krs-online.com.pl',
  'rejestr.io',
  'money.pl',
  'oferteo.pl',
  'yellowpages.com',
  'yelp.com',
];

const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com'];

const PRODUCTION_KEYWORDS = [
  'producent',
  'produkc',
  'wytworc',
  'wytwarza',
  'zaklad',
  'przetwor',
  'manufaktur',
  'masarnia',
  'tlocznia',
  'piekarnia',
  'cukiernia',
  'gospodarstwo',
  'hodowla',
  'upraw',
  'manufacturer',
  'producer',
  'factory',
  'production',
  'craft',
  'roastery',
  'bakery',
  'brewery',
  'distillery',
  'farm',
  'software house',
  'software development',
  'automation',
  'agency',
];

const FOOD_KEYWORDS = [
  'zywn',
  'jedzenie',
  'spozywcz',
  'produkt spozyw',
  'ser',
  'mieso',
  'warzyw',
  'owoc',
  'sok',
  'chleb',
  'maka',
  'olej',
  'nabial',
  'wedlin',
  'ryb',
  'slodycz',
  'cukiern',
  'piekar',
  'pieczyw',
  'pierog',
  'garmaz',
  'bakali',
  'kawa',
  'kaw',
  'herbat',
  'kiszon',
  'przetwor',
  'miod',
  'jaj',
  'catering',
  'kanapk',
  'potraw',
  'wedzon',
  'kasz',
  'zboz',
  'makaron',
  'food',
  'beverage',
  'dairy',
  'meat',
  'bakery',
  'seafood',
  'coffee',
  'tea',
  'software',
  'saas',
  'it services',
  'automation',
  'solutions',
];

const NEGATIVE_RESEARCH_SIGNALS = [
  'nie mozna potwierdzic',
  'nie da sie potwierdzic',
  'brak danych pozytywnych',
  'brak mozliwosci przeprowadzenia rzetelnej analizy',
  'niepowiazane z branza',
  'nie jest producentem',
  'wyklucza bezposrednia wspolprace',
  'dotyczy innej firmy',
  'inna firma',
  'nie mylic',
  'wymaga weryfikacji tozsamosci',
  'cannot be confirmed',
  'permanently closed',
  'out of business',
  'unrelated company',
  'different entity',
];

const WHOLESALE_KEYWORDS = [
  'hurt',
  'hurtow',
  'cash and carry',
  'cash&carry',
  'cash & carry',
  'b2b',
  'dla gastronomii',
  'dla horeca',
  'horeca',
  'sprzedaz hurtowa',
  'oferta dla restauracji',
  'sprzedaz dla restauracji',
  'wholesale',
  'b2b supply',
  'b2b supplier',
  'b2b sales',
  'bulk ordering',
  'vendor',
];

const DISTRIBUTION_KEYWORDS = [
  'dystrybut',
  'dostawca do restauracji',
  'dostawca do gastronomii',
  'dostawy do horeca',
  'sprzedaz do gastronomii',
  'foodservice',
  'food service',
  'logistyka spozywcz',
  'distributor',
  'distribution',
  'logistics',
  'supplier',
  'food service supply',
];

const IMPORTER_KEYWORDS = [
  'import',
  'importer',
  'wylaczny przedstawiciel',
  'wlosk',
  'hiszpansk',
  'francusk',
  'azjatyck',
  'sprowadzamy',
  'specjalnosci kulinarne',
  'exclusive distributor',
  'import export',
  'international trade',
];

const COOPERATIVE_KEYWORDS = [
  'spoldziel',
  'kooperaty',
  'grupa producenck',
  'zrzeszenie',
  'lokalna inicjatywa',
  'platforma producentow',
  'agregator producent',
  'czlonkow gospodarstw',
  'cooperative',
  'producer group',
  'association',
  'consortium',
];

const END_CONSUMER_KEYWORDS = [
  'restauracja',
  'restauracje',
  'hotel',
  'pizzeria',
  'bistro',
  'kawiarnia',
  'pub',
  'bar mleczny',
  'food truck',
  'restaurant',
  'cafe',
  'bar',
];

const RETAIL_CHAIN_KEYWORDS = [
  'biedronka',
  'lidl',
  'auchan',
  'tesco',
  'kaufland',
  'carrefour',
  'netto',
  'aldi',
  'dino',
  'stokrotka',
  'walmart',
  'target',
  'costco',
];

// ── Restaurant (demand-side / customer) signals — used only by scoreRestaurant ──
// Restaurants are GastroBridge's BUYERS, so the same venue words that are a *penalty*
// when hunting suppliers (END_CONSUMER_KEYWORDS) become the *core positive* here.
const RESTAURANT_VENUE_KEYWORDS = [
  'restauracja',
  'restauracje',
  'restaurant',
  'bistro',
  'pizzeria',
  'trattoria',
  'osteria',
  'kawiarnia',
  'pub',
  'bar mleczny',
  'food truck',
  'karczma',
  'gospoda',
  'tawerna',
  'brasserie',
  'fine dining',
  'kuchnia',
  'lokal gastronomiczn',
  'gastronomia',
  'winiarnia',
  'burgerownia',
  'ramen',
  'sushi',
];

const RESTAURANT_MENU_KEYWORDS = [
  'menu',
  'karta dan',
  'nasze dania',
  'kuchnia wlosk',
  'kuchnia polsk',
  'kuchnia azjatyck',
  'kuchnia francusk',
  'dania glowne',
  'przystawki',
  'degustacyjne',
  'szef kuchni',
];

const RESTAURANT_BOOKING_KEYWORDS = [
  'rezerwacj',
  'zarezerwuj',
  'zamow online',
  'zamowienia online',
  'dowoz',
  'dostawa jedzenia',
  'pyszne.pl',
  'ubereats',
  'uber eats',
  'glovo',
  'wolt',
  'godziny otwarcia',
];

const RESTAURANT_REPUTATION_KEYWORDS = [
  'opinie',
  'recenzj',
  'tripadvisor',
  'google reviews',
  'gwiazdk',
  'michelin',
  'nagrod',
  'nasze lokale',
  'kolejny lokal',
  'siec restauracji',
];

const RESTAURANT_CLOSED_KEYWORDS = [
  'zamkniet',
  'nieczynne',
  'zlikwidowan',
  'permanently closed',
  'lokal na sprzedaz',
  'zaprzestal dzialalnosci',
  'dzialalnosc zawieszona',
];

const REGION_TOKENS: Record<string, string[]> = {
  slaskie: [
    'slaskie',
    'slask',
    'katowice',
    'katowick',
    'czestochowa',
    'bielsko',
    'biala',
    'gliwice',
    'zabrze',
    'bytom',
    'chorzow',
    'chorzowsk',
    'tychy',
    'sosnowiec',
    'dabrowa',
    'rybnik',
    'cieszyn',
    'zywiec',
    'zywca',
    'pszczyna',
    'mikolow',
    'myslowic',
    'ruda slaska',
    'czaniec',
    'piekary',
  ],
  dolnoslaskie: [
    'dolnoslaskie',
    'dolny slask',
    'wroclaw',
    'wroclawsk',
    'legnica',
    'walbrzych',
    'jelenia gora',
    'baryczy',
  ],
  wroclaw: ['wroclaw', 'wroclawsk', 'dolnoslaskie', 'dolny slask', 'baryczy'],
  mazowieckie: ['mazowieckie', 'mazowsze', 'mazowsza', 'warszawa', 'grójec', 'grojec', 'radom', 'siedlce', 'plock'],
  lubelskie: ['lubelskie', 'lublin', 'lubelszczyzna', 'janow lubelski', 'godziszow', 'izbica', 'hopkie'],
};

export function isKnownMissingValue(value?: string | null): boolean {
  if (value == null) return true;
  return MISSING_VALUES.has(value.trim().toLowerCase());
}

export function normalizeOptionalText(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return isKnownMissingValue(trimmed) ? null : trimmed;
}

function normalizeForMatch(value?: string | null): string {
  return normalizeOptionalText(value)
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l') ?? '';
}

function getDomain(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isValidEmail(e?: string | null): e is string {
  return !!normalizeOptionalText(e) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeOptionalText(e)!);
}

function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.some((publicDomain) => domain === publicDomain || domain.endsWith(`.${publicDomain}`));
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(normalizeForMatch(keyword)));
}

export function getRegionTokens(region: string): string[] {
  const normalizedRegion = normalizeForMatch(region);
  const direct = REGION_TOKENS[normalizedRegion];
  if (direct) return direct;

  const matched = Object.entries(REGION_TOKENS).find(([key, tokens]) =>
    normalizedRegion.includes(key) || tokens.some((token) => normalizedRegion.includes(normalizeForMatch(token))),
  );

  return matched ? matched[1] : [region];
}

function aggregatedText(lead: LeadForScoring): string {
  return [
    lead.reason,
    lead.rawAnalysis,
    lead.personalizationHook,
    lead.city,
    lead.productCategory,
    lead.emailSource,
    lead.company,
    lead.companyName,
    lead.website,
    sourceUrlsText(lead.sourceUrls),
    Array.isArray(lead.brandsOrPortfolio) ? lead.brandsOrPortfolio.join(' ') : '',
  ]
    .map((part) => normalizeForMatch(part))
    .filter(Boolean)
    .join(' ');
}

function textConfirms(lead: LeadForScoring, type: SupplierType): boolean {
  const text = aggregatedText(lead);
  switch (type) {
    case 'wholesaler':       return hasAny(text, WHOLESALE_KEYWORDS);
    case 'distributor':      return hasAny(text, DISTRIBUTION_KEYWORDS);
    case 'importer':         return hasAny(text, IMPORTER_KEYWORDS);
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':  return hasAny(text, COOPERATIVE_KEYWORDS);
    case 'manufacturer':
    case 'producer':         return hasAny(text, PRODUCTION_KEYWORDS) || lead.isProducer === true;
    default:                 return false;
  }
}

export function inferSupplierType(
  lead: LeadForScoring,
  declared?: SupplierType | null,
): SupplierType {
  if (declared && declared !== 'unknown' && textConfirms(lead, declared)) {
    return declared;
  }

  const text = aggregatedText(lead);

  if (hasAny(text, WHOLESALE_KEYWORDS))     return 'wholesaler';
  if (hasAny(text, DISTRIBUTION_KEYWORDS))  return 'distributor';
  if (hasAny(text, IMPORTER_KEYWORDS))      return 'importer';
  if (hasAny(text, COOPERATIVE_KEYWORDS)) {
    if (text.includes('grupa producenck') || text.includes('zrzeszenie')) return 'producer_group';
    if (text.includes('agregator producent') || text.includes('platforma producentow')) return 'farm_aggregator';
    return 'cooperative';
  }
  if (hasAny(text, PRODUCTION_KEYWORDS) || lead.isProducer === true) {
    if (text.includes('zaklad') || text.includes('przetwor') || text.includes('manufaktur')) return 'manufacturer';
    return 'producer';
  }

  if (declared && declared !== 'unknown') return declared;

  return 'unknown';
}

function sourceUrlsText(sourceUrls?: string[] | string | null): string {
  if (!sourceUrls) return '';
  if (Array.isArray(sourceUrls)) return sourceUrls.join(' ');
  return sourceUrls;
}

function hasUsableSourceUrl(sourceUrls?: string[] | string | null): boolean {
  const urls = Array.isArray(sourceUrls) ? sourceUrls : sourceUrls ? [sourceUrls] : [];
  return urls.some((url) => {
    const domain = getDomain(url);
    if (!domain) return false;
    return !DIRECTORIES.some((d) => domain.includes(d)) && !SOCIAL_DOMAINS.some((d) => domain.endsWith(d));
  });
}

export function scoreLead(lead: LeadForScoring, region: string): LeadQuality {
  let score = 0;
  const reasons: string[] = [];

  const email = normalizeOptionalText(lead.email);
  const website = normalizeOptionalText(lead.website);
  const text = aggregatedText(lead);

  const inferredSupplierType = inferSupplierType(lead, lead.supplierType);
  const isProducerLike = inferredSupplierType === 'producer' || inferredSupplierType === 'manufacturer';
  reasons.push(`type: ${inferredSupplierType}`);

  if (isValidEmail(email)) {
    score += 25;
    reasons.push('+25: poprawny email');

    const emailDomain = email.split('@')[1].toLowerCase();
    const webDomain = getDomain(website);
    if (webDomain && !isPublicEmailDomain(emailDomain) && (emailDomain.includes(webDomain) || webDomain.includes(emailDomain))) {
      score += 20;
      reasons.push('+20: domena email pasuje do website');
    } else if (isPublicEmailDomain(emailDomain)) {
      reasons.push('0: email w publicznej domenie, bez kary za brak zgodności domeny');
    }
  }

  const websiteDomain = getDomain(website);
  const hasDirectoryWebsite = !!website && DIRECTORIES.some(d => website.toLowerCase().includes(d));
  const hasSocialWebsite = !!websiteDomain && SOCIAL_DOMAINS.some(d => websiteDomain.endsWith(d));

  if (websiteDomain && !hasDirectoryWebsite && !hasSocialWebsite) {
    score += 20;
    reasons.push('+20: website wygląda jak oficjalna strona');
  }

  if (hasUsableSourceUrl(lead.sourceUrls)) {
    score += 10;
    reasons.push('+10: discovery podało użyteczne źródło');
  }

  const hasProductionSignal = hasAny(text, PRODUCTION_KEYWORDS);
  const hasWholesaleSignal = hasAny(text, WHOLESALE_KEYWORDS);
  const hasDistributionSignal = hasAny(text, DISTRIBUTION_KEYWORDS);
  const hasImporterSignal = hasAny(text, IMPORTER_KEYWORDS);
  const hasCooperativeSignal = hasAny(text, COOPERATIVE_KEYWORDS);

  switch (inferredSupplierType) {
    case 'producer':
    case 'manufacturer':
      if (hasProductionSignal) {
        score += 15;
        reasons.push('+15: sygnał produkcji/wytwórstwa');
      }
      break;
    case 'wholesaler':
      if (hasWholesaleSignal) {
        score += 15;
        reasons.push('+15: sygnał hurtowni / sprzedaży B2B');
      }
      break;
    case 'distributor':
      if (hasDistributionSignal || hasWholesaleSignal) {
        score += 15;
        reasons.push('+15: sygnał dystrybucji do HoReCa');
      }
      break;
    case 'importer':
      if (hasImporterSignal) {
        score += 15;
        reasons.push('+15: sygnał importera specjalistycznego');
      }
      break;
    case 'cooperative':
    case 'producer_group':
    case 'farm_aggregator':
      if (hasCooperativeSignal) {
        score += 15;
        reasons.push('+15: sygnał kooperatywy / grupy producenckiej');
      }
      break;
  }

  const hasFoodSignal = hasAny(text, FOOD_KEYWORDS);
  if (hasFoodSignal) {
    score += 15;
    reasons.push('+15: reason zawiera słowa branży spożywczej');
  }

  if (normalizeOptionalText(lead.productCategory)) {
    score += 10;
    reasons.push('+10: podana kategoria produktu');
  }

  if (lead.isProducer === true && isProducerLike) {
    score += 10;
    reasons.push('+10: oznaczone jako producent (zgodne z typem)');
  }

  if (lead.directToHoreca === 'yes') {
    score += 15;
    reasons.push('+15: bezpośrednia sprzedaż do HoReCa');
  } else if (lead.directToHoreca === 'limited') {
    score += 5;
    reasons.push('+5: ograniczona sprzedaż do HoReCa');
  } else if (lead.directToHoreca === 'no' && inferredSupplierType === 'wholesaler') {
    score -= 20;
    reasons.push('-20: hurtownia bez sprzedaży do HoReCa');
  }

  if (typeof lead.confidence === 'number') {
    if (lead.confidence >= 0.8) {
      score += 10;
      reasons.push('+10: wysokie confidence discovery');
    } else if (lead.confidence >= 0.5) {
      score += 5;
      reasons.push('+5: średnie confidence discovery');
    } else if (lead.confidence < 0.35) {
      score -= 25;
      reasons.push('-25: niskie confidence discovery');
    }
  }

  const regionTokens = getRegionTokens(region);
  if (regionTokens.some((token) => text.includes(normalizeForMatch(token)))) {
    score += 10;
    reasons.push('+10: region zgodny z inputem');
  }

  const legalForms = ['sp. z o.o.', 's.c.', 'sp.j.', 'sp. j.', 'spółka', 'p.h.u.', 'p.p.h.u.', 'phup', 'f.p.u.h.', 'firma produkcyjna'];
  if (legalForms.some(f => normalizeForMatch(lead.company).includes(normalizeForMatch(f)))) {
    score += 10;
    reasons.push('+10: firma ma formę prawną');
  }

  if (hasDirectoryWebsite) {
    score -= 40;
    reasons.push('-40: website to katalog/portal');
  }

  if (hasSocialWebsite) {
    score -= 15;
    reasons.push('-15: social media jako główne źródło');
  }

  if (!hasFoodSignal && !normalizeOptionalText(lead.productCategory)) {
    score -= 20;
    reasons.push('-20: brak słów kluczowych branży spożywczej');
  }

  if (isProducerLike && !hasProductionSignal && lead.isProducer !== true) {
    score -= 15;
    reasons.push('-15: brak jasnego sygnału produkcji/wytwórstwa');
  }

  if (
    inferredSupplierType === 'unknown'
    && lead.directToHoreca !== 'yes'
    && lead.directToHoreca !== 'limited'
  ) {
    score -= 50;
    reasons.push('-50: typ dostawcy nieznany i brak potwierdzenia HoReCa');
  }

  const hasEndConsumerSignal = hasAny(text, END_CONSUMER_KEYWORDS);
  const hasSupplierSignal = hasProductionSignal || hasWholesaleSignal || hasDistributionSignal || hasImporterSignal || hasCooperativeSignal;
  if (hasEndConsumerSignal && !hasSupplierSignal && inferredSupplierType === 'unknown') {
    score -= 30;
    reasons.push('-30: tekst wskazuje końcowego konsumenta (restauracja/hotel) bez sygnału dostawcy');
  }

  if (hasAny(text, RETAIL_CHAIN_KEYWORDS)) {
    score -= 25;
    reasons.push('-25: dotyczy sieci handlowej B2C');
  }

  if (hasAny(text, NEGATIVE_RESEARCH_SIGNALS)) {
    score -= 50;
    reasons.push('-50: research zawiera negatywny sygnał potwierdzenia');
  }

  let decision: LeadQuality['decision'] = 'reject';
  if (score >= 55) decision = 'draft_candidate';
  else if (score >= 25) decision = 'research_needed';

  return { score, decision, reasons, inferredSupplierType };
}

/**
 * Demand-side qualifier: scores a RESTAURANT as a potential GastroBridge customer.
 * Parallel rubric to scoreLead but with the polarity flipped — venue/menu/booking
 * signals that *disqualify* a supplier are exactly what *qualifies* a restaurant.
 * `inferredSupplierType` is always 'unknown' here (restaurants are buyers, not suppliers);
 * the field is kept only to satisfy the shared LeadQuality shape.
 */
export function scoreRestaurant(lead: LeadForScoring, region: string): LeadQuality {
  let score = 0;
  const reasons: string[] = [];

  const email = normalizeOptionalText(lead.email);
  const website = normalizeOptionalText(lead.website);
  const text = aggregatedText(lead);

  reasons.push('target: restaurant (customer)');

  // Contactability — same weighting as supplier scoring.
  if (isValidEmail(email)) {
    score += 25;
    reasons.push('+25: poprawny email');

    const emailDomain = email.split('@')[1].toLowerCase();
    const webDomain = getDomain(website);
    if (webDomain && !isPublicEmailDomain(emailDomain) && (emailDomain.includes(webDomain) || webDomain.includes(emailDomain))) {
      score += 20;
      reasons.push('+20: domena email pasuje do website');
    } else if (isPublicEmailDomain(emailDomain)) {
      reasons.push('0: email w publicznej domenie, bez kary za brak zgodności domeny');
    }
  }

  const websiteDomain = getDomain(website);
  const hasDirectoryWebsite = !!website && DIRECTORIES.some(d => website.toLowerCase().includes(d));
  const hasSocialWebsite = !!websiteDomain && SOCIAL_DOMAINS.some(d => websiteDomain.endsWith(d));

  if (websiteDomain && !hasDirectoryWebsite && !hasSocialWebsite) {
    score += 20;
    reasons.push('+20: website wygląda jak własna strona lokalu');
  }

  if (hasUsableSourceUrl(lead.sourceUrls)) {
    score += 10;
    reasons.push('+10: discovery podało użyteczne źródło');
  }

  // Core positive: is this actually a restaurant / gastro venue?
  const hasVenueSignal = hasAny(text, RESTAURANT_VENUE_KEYWORDS);
  if (hasVenueSignal) {
    score += 20;
    reasons.push('+20: sygnał lokalu gastronomicznego (restauracja/bistro/…)');
  }

  if (hasAny(text, RESTAURANT_MENU_KEYWORDS)) {
    score += 10;
    reasons.push('+10: obecne menu / typ kuchni');
  }

  if (hasAny(text, RESTAURANT_BOOKING_KEYWORDS)) {
    score += 10;
    reasons.push('+10: rezerwacje / zamówienia online / godziny otwarcia (lokal aktywny)');
  }

  if (hasAny(text, RESTAURANT_REPUTATION_KEYWORDS)) {
    score += 10;
    reasons.push('+10: opinie / nagrody / wiele lokali');
  }

  if (typeof lead.confidence === 'number') {
    if (lead.confidence >= 0.8) {
      score += 10;
      reasons.push('+10: wysokie confidence discovery');
    } else if (lead.confidence >= 0.5) {
      score += 5;
      reasons.push('+5: średnie confidence discovery');
    } else if (lead.confidence < 0.35) {
      score -= 25;
      reasons.push('-25: niskie confidence discovery');
    }
  }

  const regionTokens = getRegionTokens(region);
  if (regionTokens.some((token) => text.includes(normalizeForMatch(token)))) {
    score += 10;
    reasons.push('+10: region zgodny z inputem');
  }

  // Penalties.
  if (hasDirectoryWebsite) {
    score -= 40;
    reasons.push('-40: website to katalog/portal, nie własna strona lokalu');
  }

  if (hasSocialWebsite) {
    score -= 15;
    reasons.push('-15: social media jako jedyne źródło');
  }

  if (hasAny(text, RESTAURANT_CLOSED_KEYWORDS)) {
    score -= 50;
    reasons.push('-50: lokal zamknięty / zlikwidowany');
  }

  if (hasAny(text, RETAIL_CHAIN_KEYWORDS)) {
    score -= 25;
    reasons.push('-25: dotyczy sieci handlowej B2C, nie lokalu gastronomicznego');
  }

  if (!hasVenueSignal && !hasAny(text, RESTAURANT_MENU_KEYWORDS)) {
    score -= 30;
    reasons.push('-30: brak jakiegokolwiek sygnału lokalu gastronomicznego');
  }

  if (hasAny(text, NEGATIVE_RESEARCH_SIGNALS)) {
    score -= 50;
    reasons.push('-50: research zawiera negatywny sygnał potwierdzenia');
  }

  let decision: LeadQuality['decision'] = 'reject';
  if (score >= 55) decision = 'draft_candidate';
  else if (score >= 25) decision = 'research_needed';

  return { score, decision, reasons, inferredSupplierType: 'unknown' };
}

export type IdentityCheck = {
  ok: boolean;
  confidence: number;
  reasons: string[];
};

export function validateEnrichmentIdentity(lead: any, enriched: any): IdentityCheck {
  const reasons: string[] = [];
  let confidence = 1.0;

  const enrichedSupplierType = (enriched?.supplierType as SupplierType | undefined) ?? undefined;
  const declaredType = enrichedSupplierType ?? (lead?.supplierType as SupplierType | undefined);
  const distributionLikeType = declaredType === 'wholesaler'
    || declaredType === 'distributor'
    || declaredType === 'importer';

  // 1. Token matching, only when the model explicitly returned a company name.
  if (enriched.companyName) {
    const leadTokens = normalizeForMatch(lead.company).replace(/[^a-z0-9 ]/g, '').split(' ').filter((t: string) => t.length > 2);
    const enrichedTokens = normalizeForMatch(enriched.companyName).replace(/[^a-z0-9 ]/g, '').split(' ').filter((t: string) => t.length > 2) || [];

    const commonTokens = leadTokens.filter((t: string) => enrichedTokens.includes(t));
    if (commonTokens.length === 0 && leadTokens.length > 0) {
      confidence -= 0.6;
      reasons.push('Brak wspólnych słów kluczowych w nazwie firmy');
    }
  }

  // 2. Domain check — hurtownie/dystrybutorzy często mają osobne domeny B2B/portalowe.
  if (lead.email && enriched.website) {
    const emailDomain = String(lead.email).split('@')[1]?.toLowerCase();
    const webDomain = getDomain(enriched.website);
    if (emailDomain && webDomain && !isPublicEmailDomain(emailDomain) && !emailDomain.includes(webDomain) && !webDomain.includes(emailDomain)) {
      const penalty = distributionLikeType ? 0.2 : 0.6;
      confidence -= penalty;
      reasons.push(`Domena website nie pasuje do domeny email (${distributionLikeType ? 'tolerancja dla hurtowni/dystrybutora' : 'pełna kara'})`);
    }
  }

  const webDomain = getDomain(enriched.website);
  if (webDomain && /\.(co\.uk|com\.au|ca|de|fr|it|es)$/.test(webDomain) && !webDomain.endsWith('.pl')) {
    confidence -= 0.2;
    reasons.push('Domena wygląda na zagraniczny podmiot');
  }

  // 3. Supplier-type drift — model klasyfikuje inny typ niż heurystyka.
  if (enrichedSupplierType) {
    const heuristicType = inferSupplierType(
      {
        company: lead?.company ?? '',
        companyName: enriched?.companyName ?? lead?.companyName ?? null,
        reason: lead?.reason ?? null,
        rawAnalysis: enriched?.rawAnalysis && typeof enriched.rawAnalysis === 'string' ? enriched.rawAnalysis : null,
        productCategory: lead?.productCategory ?? null,
        website: enriched?.website ?? lead?.website ?? null,
      },
      enrichedSupplierType,
    );
    if (heuristicType !== 'unknown' && heuristicType !== enrichedSupplierType) {
      confidence -= 0.2;
      reasons.push(`Model klasyfikuje typ jako ${enrichedSupplierType}, heurystyka jako ${heuristicType}`);
    }
  }

  return {
    ok: confidence >= 0.5,
    confidence,
    reasons
  };
}

/**
 * Optional compliance-footer override (Market Pack). When omitted, the check is the
 * Polish RODO footer 1:1 — so existing producer-hunt callers (`validateDraft(draft, lead)`)
 * stay byte-for-byte equivalent. The huntAgent passes the active market's markers for
 * non-PL locales (e.g. an Icelandic GDPR footer). `label` only customises the failure text.
 */
export interface FooterCheck {
  adminMarker: string;
  optOutMarker: string;
  /** Purpose-of-contact marker (PL RODO "Cel kontaktu:"). Hard-checked when present. */
  purposeMarker?: string;
  /** Data-source marker (PL RODO "Źródło danych:"). Hard-checked when present. */
  sourceMarker?: string;
  /**
   * Canonical full footer text the agent appends verbatim. The `<źródło>` token is the only part
   * the agent fills in (the public source the lead was found at). Lets the agent recover a failed
   * footer from the Market Pack instead of hunting for it in source files.
   */
  template?: string;
  label?: string;
}

/**
 * Canonical PL RODO footer. First contact under Polish law is a *relationship-initiation*, not a
 * sales offer — the footer states who the controller is, why we reach out, where the data came
 * from (always a public source), and a one-word opt-out. The `<źródło>` token is filled per lead.
 */
export const PL_RODO_FOOTER_TEMPLATE =
  'Administratorem danych jest Organization (Data Controller). ' +
  'Cel kontaktu: nawiązanie relacji biznesowej w sektorze HoReCa. ' +
  'Źródło danych: publicznie dostępne informacje (<źródło>). ' +
  'Jeśli nie chcesz otrzymywać wiadomości, odpowiedz "STOP", a usuniemy Twoje dane.';

const PL_RODO_FOOTER: FooterCheck = {
  adminMarker: 'Administratorem danych jest GastroBridge',
  optOutMarker: '"STOP"',
  purposeMarker: 'Cel kontaktu:',
  sourceMarker: 'Źródło danych:',
  template: PL_RODO_FOOTER_TEMPLATE,
  label: 'Brak pełnej stopki RODO (wymagane: administrator, cel kontaktu, źródło danych, opt-out "STOP")',
};

export function validateDraft(draft: { subject: string, body: string }, lead: any, footerCheck: FooterCheck = PL_RODO_FOOTER): { ok: boolean; hardFailures: string[]; softWarnings: string[] } {
  const hardFailures: string[] = [];
  const softWarnings: string[] = [];
  const subject = typeof draft?.subject === 'string' ? draft.subject : '';
  const body = typeof draft?.body === 'string' ? draft.body : '';

  if (subject.length < 5) hardFailures.push('Temat za krótki');

  const placeholders = ['[Twoje Imię i Nazwisko]', '[imię]', '[nazwa firmy]', '{{', '}}', '[...]', 'XYZ'];
  for (const p of placeholders) {
    if (body.includes(p)) hardFailures.push(`Zawiera placeholder: ${p}`);
  }

  if (!body.includes('GastroBridge')) hardFailures.push('Brak nazwy GastroBridge');

  const forbiddenNames = ['Gastro-Supply', 'Gastro Market'];
  for (const fn of forbiddenNames) {
    if (body.includes(fn)) hardFailures.push(`Zawiera wymyśloną nazwę: ${fn}`);
  }

  const footerMissing =
    !body.includes(footerCheck.adminMarker) ||
    !body.includes(footerCheck.optOutMarker) ||
    (footerCheck.purposeMarker != null && !body.includes(footerCheck.purposeMarker)) ||
    (footerCheck.sourceMarker != null && !body.includes(footerCheck.sourceMarker));
  if (footerMissing) {
    hardFailures.push(footerCheck.label ?? 'Brak wymaganej stopki compliance');
  }

  if (body.length < 200) softWarnings.push('Draft może być za krótki');
  if (lead?.rawAnalysis && body.length > 0) {
    const analysisWords = String(lead.rawAnalysis).toLowerCase().match(/[a-ząćęłńóśźż]{5,}/g) ?? [];
    const matched = analysisWords.slice(0, 30).some((word) => body.toLowerCase().includes(word));
    if (!matched) softWarnings.push('Draft może nie używać konkretów z researchu');
  }

  // Neutralny check — czy mail nawiązuje do oferty firmy (różne dla producent/hurtownia/dystrybutor).
  // softWarnings są wyłącznie doradcze (workflow czyta tylko .ok/.hardFailures), więc lista jest
  // bezpiecznie rozszerzalna. Pierwotnie zawierała tylko słownictwo hurtowni/dystrybutora/importera,
  // przez co LUDZKI mail do PRODUCENTA nazywający konkretny wyrób ("chleb żytni na zakwasie") fałszywie
  // dostawał ostrzeżenie i popychał agenta do upychania słów-kluczy. Dodajemy rzeczowniki produktowe
  // (strona podażowa), świadomie NIE dodając "restauracj"/popytowych słów, by check nadal weryfikował
  // odniesienie do OFERTY firmy, a nie samą wzmiankę o restauracjach.
  const offerKeywords = [
    'produkt', 'asortyment', 'portfolio', 'marki', 'oferta',
    'dostarcza', 'dystrybu', 'importu', 'członkow', 'członków',
    'zrzesz', 'wytwarza', 'horeca', 'gastronom',
    // producent / wyroby spożywcze (strona podażowa)
    'wypiek', 'pieczyw', 'chleb', 'ciast', 'piekarni', 'rzemieśln',
    'ser', 'nabiał', 'wędlin', 'mięs', 'masarni', 'warzyw', 'owoc',
    'sok', 'miód', 'olej', 'oliw', 'przetwor', 'kasz', 'makaron', 'wytwór',
  ];
  if (body.length > 0 && !offerKeywords.some((kw) => body.toLowerCase().includes(kw))) {
    softWarnings.push('Draft nie odwołuje się do oferty/asortymentu/portfolio firmy');
  }

  // Pierwszy kontakt = nawiązanie relacji, NIE oferta sprzedażowa (prawo PL). Słowa cenowe/„za darmo”
  // sygnalizują ton ofertowy, a deklaracje typu „całkowicie bezpłatne” bywają wprost nieprawdziwe
  // (aplikacja jest płatna dla sprzedawców po pilotażu). Advisory — agent ma to poprawić, nie blokujemy
  // workflowu, bo to ocena tonu, nie struktury.
  const salesPricingKeywords = [
    'darmow', 'bezpłatn', 'za darmo', 'gratis', 'promocj', 'rabat', 'zniżk',
    'cennik', 'cena', 'najtańsz', 'oferta specjaln', 'wyprzedaż',
  ];
  const lowerBody = body.toLowerCase();
  const pricingHit = salesPricingKeywords.find((kw) => lowerBody.includes(kw));
  if (body.length > 0 && pricingHit) {
    softWarnings.push(`Ton ofertowo-cenowy ("${pricingHit}") — pierwszy kontakt to nawiązanie relacji, nie oferta; usuń obietnice cenowe i deklaracje "darmowe"`);
  }

  return {
    ok: hardFailures.length === 0,
    hardFailures,
    softWarnings
  };
}
