/**
 * Discovery query profiles per supplier type.
 * Used by `producer-hunt.discover-leads` to build Tavily queries dopasowane do typu firmy.
 *
 * Plan: ideas/producer-hunt-fix-v3.md §4.
 */
import type { SupplierType } from './quality.js';

export type DiscoveryProfile = {
  type: SupplierType;
  baseQueries: (region: string, productType?: string) => string[];
  nicheQueries: (region: string, productType?: string) => string[];
  cityQueries: (region: string, city: string, productType?: string) => string[];
  /** Domain hints used by URL filtering — these are NOT excluded from NotebookLM. */
  trustedDomainHints: string[];
};

const food = (productType?: string) => productType ?? 'żywności';
const productOrEmpty = (productType?: string) => productType ?? '';

export const DISCOVERY_PROFILES: Record<Exclude<SupplierType, 'unknown'>, DiscoveryProfile> = {
  producer: {
    type: 'producer',
    baseQueries: (region, productType) => [
      `producent ${food(productType)} ${region} kontakt email`,
      `lokalni dostawcy do restauracji ${region} ${productOrEmpty(productType)}`,
      `gospodarstwo rolne ${region} sprzedaż bezpośrednia do restauracji`,
      `manufaktura ${productOrEmpty(productType)} ${region} kontakt`,
    ],
    nicheQueries: (region, productType) => productType ? [] : [
      `sery rzemieślnicze nabiał kozi owczy ${region} producent`,
      `wędliny ekologiczne rzemieślnicze masarnia ${region}`,
      `tłocznia soków przetwory owoce warzywa ${region} kontakt`,
      `piekarnia rzemieślnicza chleb na zakwasie ${region} producent`,
      `produkty regionalne certyfikowane ${region} producenci`,
    ],
    cityQueries: (_region, city, productType) => [
      `producent ${food(productType)} ${city} kontakt`,
      `gospodarstwo rolne ${city} sprzedaż bezpośrednia`,
    ],
    trustedDomainHints: ['gospodarstwo', 'manufaktura', 'serowarnia', 'tlocznia', 'masarnia', 'piekarnia'],
  },
  manufacturer: {
    type: 'manufacturer',
    baseQueries: (region, productType) => [
      `zakład przetwórstwa ${productType ?? 'spożywczy'} ${region} kontakt`,
      `${productOrEmpty(productType)} przetwórstwo zakład produkcyjny ${region}`,
      `rolniczy handel detaliczny ${region} ${productOrEmpty(productType)} lista kontakt`,
    ],
    nicheQueries: (region, productType) => productType ? [] : [
      `zakład przetwórstwa mięsnego ${region} kontakt`,
      `mleczarnia zakład produkcyjny ${region}`,
      `przetwórnia owoców warzyw ${region} kontakt`,
    ],
    cityQueries: (_region, city, productType) => [
      `zakład przetwórstwa ${productType ?? 'spożywczy'} ${city}`,
    ],
    trustedDomainHints: ['zaklad', 'przetwor', 'mleczarnia', 'przetwornia'],
  },
  cooperative: {
    type: 'cooperative',
    baseQueries: (region, productType) => [
      `kooperatywa spożywcza ${region} ${productOrEmpty(productType)}`,
      `spółdzielnia rolnicza ${productOrEmpty(productType)} ${region} kontakt`,
      `lokalna inicjatywa producentów ${region}`,
    ],
    nicheQueries: () => [],
    cityQueries: (_region, city) => [`kooperatywa spożywcza ${city}`],
    trustedDomainHints: ['kooperatywa', 'spoldzielnia', 'spoldzielczy'],
  },
  producer_group: {
    type: 'producer_group',
    baseQueries: (region, productType) => [
      `grupa producencka ${productOrEmpty(productType)} ${region} kontakt`,
      `zrzeszenie hodowców ${productOrEmpty(productType)} ${region}`,
      `grupa producentów ${productOrEmpty(productType)} ${region}`,
    ],
    nicheQueries: () => [],
    cityQueries: (_region, city, productType) => [`grupa producencka ${productOrEmpty(productType)} ${city}`],
    trustedDomainHints: ['grupa-producencka', 'gpr-', 'zrzeszenie'],
  },
  wholesaler: {
    type: 'wholesaler',
    baseQueries: (region, productType) => [
      `hurtownia spożywcza ${region} HoReCa kontakt`,
      `hurtownia ${productType ?? 'gastronomiczna'} ${region}`,
      `cash and carry ${productOrEmpty(productType)} ${region}`,
      `dla gastronomii dostawca ${region}`,
    ],
    nicheQueries: (region, productType) => productType ? [
      `hurtownia ${productType} ${region} dla restauracji`,
    ] : [
      `hurtownia mięsa ${region} HoReCa`,
      `hurtownia nabiału ${region} dla restauracji`,
      `hurtownia warzyw owoców ${region} dostawa`,
      `hurtownia mrożonek ${region} gastronomia`,
    ],
    cityQueries: (_region, city, productType) => [
      `hurtownia ${productType ?? 'spożywcza'} ${city} HoReCa`,
      `dostawca dla restauracji ${city}`,
    ],
    trustedDomainHints: ['hurtownia', 'hurt-', 'cashandcarry', 'bsdhurt', 'eurocash', 'gastropol'],
  },
  distributor: {
    type: 'distributor',
    baseQueries: (region, productType) => [
      `dystrybutor ${productType ?? 'spożywczy'} ${region} HoReCa`,
      `dostawca do restauracji ${region} ${productOrEmpty(productType)}`,
      `regionalny dystrybutor ${productOrEmpty(productType)} ${region}`,
      `foodservice dystrybucja ${region}`,
    ],
    nicheQueries: (_region, productType) => productType ? [] : [
      `dystrybutor mięsa nabiału warzyw ${_region} restauracje`,
      `dostawca produktów premium ${_region} fine dining`,
    ],
    cityQueries: (_region, city, productType) => [
      `dystrybutor ${productType ?? 'spożywczy'} ${city} HoReCa`,
    ],
    trustedDomainHints: ['dystrybucja', 'horeca', 'dostawca', 'gastropol', 'gourmet', 'foodservice'],
  },
  importer: {
    type: 'importer',
    baseQueries: (region, productType) => [
      `importer ${productType ?? 'specjalności kulinarnych'} ${region}`,
      `bezpośredni import ${productOrEmpty(productType)} dystrybucja Polska`,
      `importer marek ${productOrEmpty(productType)} HoReCa Polska`,
    ],
    nicheQueries: (_region, productType) => productType ? [] : [
      `produkty włoskie hiszpańskie azjatyckie importer Polska`,
      `oliwa wino sery importer dystrybucja Polska`,
      `kawa rzemieślnicza importer Polska HoReCa`,
    ],
    cityQueries: () => [],
    trustedDomainHints: ['import', 'importer', 'wlosk', 'hiszpansk', 'francusk', 'gourmet'],
  },
  farm_aggregator: {
    type: 'farm_aggregator',
    baseQueries: (region, _productType) => [
      `platforma rolnicy lokalni ${region} dostawa do restauracji`,
      `agregator producentów ${region}`,
      `marketplace producentów żywności ${region}`,
    ],
    nicheQueries: () => [],
    cityQueries: (_region, city) => [`platforma producentów ${city}`],
    trustedDomainHints: ['platforma', 'agregator', 'marketplace'],
  },
};

/** Domains to exclude from NotebookLM input (B2C marketplaces, retail chains, big sieci). */
export const EXCLUDED_DOMAIN_HINTS = [
  'allegro.pl',
  'olx.pl',
  'ceneo.pl',
  'empik.com',
  'lidl.pl',
  'biedronka.pl',
  'auchan.pl',
  'tesco.pl',
  'kaufland.pl',
  'carrefour.pl',
  'netto-online.pl',
  'aldi.pl',
];

/** Social/Notebook-incompatible domains. NotebookLM słabo indeksuje te strony. */
export const SOCIAL_AND_NLM_INCOMPATIBLE_HINTS = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
];

/** Hard budget na cały run, żeby nie eksplodował koszt Tavily. */
export const TAVILY_QUERY_BUDGET = 30;

/** Maks. liczba zapytań na profil w rundzie 1. */
export const MAX_QUERIES_PER_PROFILE_ROUND_1 = 5;
