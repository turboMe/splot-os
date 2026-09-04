/**
 * Ingredient-name normalizer — turns a raw recipe-library `ingredients.name` string
 * into the base-form name(s) the FlavorDB resolver can actually match.
 *
 * WHY: the library is OCR'd/scraped from bilingual (PL/EN) cookbooks, so the field
 * holds far more than ingredient names. A live probe of the palette that reaches
 * FlavorDB contained 'ziemniaków' (genitive), 'szczypta zmielonej kolendry'
 * ("a pinch of ground coriander"), 'kiełbasy krakowskiej parzonej', a whole
 * either/or line, and 'kuchnia chińska' — a CUISINE, not an ingredient. Coverage
 * was 6/14; the resolver was being asked the wrong questions.
 *
 * Every rule below is derived from a dump of the actual corpus (91 411 ingredient
 * rows / 29 797 distinct), not from imagination:
 *   - 22.2% of distinct names contain a digit (quantities, nutrition tables)
 *   - 92.2% are multi-word; 5 831 are longer than 40 chars (run-on prose lines)
 *   - tab-separated nutrition rows: "befsztyk wołowy\t100g\t114\t3,5"
 *   - metadata rows: "yield: 4 servings", "copyright 2007 bustersrecipes.com",
 *     "kuchnia chińska" (cuisine label), "x gn1/1" (gastronorm pan code)
 *   - 92 distinct names carry CP1250-as-Latin-1 mojibake ('miêso' → 'mięso')
 *
 * PURE and DETERMINISTIC: no DB, no model, no I/O — same input always yields the
 * same output, so it is unit-testable in isolation (check:ingredient-normalizer).
 * Candidate *selection* (which surface form actually resolves) is a lookup and
 * therefore lives next to the resolver in flavor-service.ts, not here.
 */

// ── Mojibake repair (CP1250 bytes decoded as Latin-1) ────────────────────────
// Only the chars that are unambiguous evidence of that specific mis-decode. 'ñ'
// and 'æ' are NOT diagnostic on their own (jalapeño, æbleskiver), so they are
// repaired only when a diagnostic char is present in the same string.
const MOJIBAKE_DIAGNOSTIC = /[¹³¿êœ¥¯£ÊŒ]/;
const MOJIBAKE_MAP: Record<string, string> = {
  '¹': 'ą', '¥': 'ą',
  '³': 'ł', '£': 'ł',
  '¿': 'ż', '¯': 'ż',
  'ê': 'ę', 'Ê': 'ę',
  'æ': 'ć', 'Æ': 'ć',
  'ñ': 'ń', 'Ñ': 'ń',
  'œ': 'ś', 'Œ': 'ś', '\u009c': 'ś', '\u008c': 'ś',
  'Ÿ': 'ź', '\u009f': 'ź', '\u008f': 'ź',
};
const MOJIBAKE_CHARS = new RegExp(`[${Object.keys(MOJIBAKE_MAP).join('')}]`, 'g');

/**
 * Repair CP1250-as-Latin-1 mojibake, preserving the case of the surrounding word
 * ('MIÊSO' → 'MIĘSO', 'ksi¥¯ka' → 'książka'). A no-op when the string shows no
 * diagnostic evidence of the mis-decode.
 */
export function repairMojibake(text: string): string {
  if (!MOJIBAKE_DIAGNOSTIC.test(text)) return text;
  // Word-by-word so the replacement can follow the case of the word it sits in.
  return text.replace(/\S+/g, (word) => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    const upper = letters.length > 0 && letters === letters.toUpperCase();
    return word.replace(MOJIBAKE_CHARS, (ch) => {
      const base = MOJIBAKE_MAP[ch];
      return upper ? base.toUpperCase() : base;
    });
  });
}

/** True when the string carries CP1250-as-Latin-1 mojibake (used by the data repair script). */
export function hasMojibake(text: string): boolean {
  return MOJIBAKE_DIAGNOSTIC.test(text);
}

// ── Word classes ─────────────────────────────────────────────────────────────

/** Measures and containers — dropped outright. */
const UNIT_WORDS = new Set([
  // metric / imperial
  'g', 'gr', 'gram', 'grama', 'gramy', 'gramów', 'dag', 'dkg', 'kg', 'mg',
  'ml', 'l', 'dl', 'cl', 'litr', 'litra', 'litry', 'litrów',
  'oz', 'lb', 'lbs', 'pound', 'pounds', 'ounce', 'ounces', 'qt', 'pt', 'quart', 'pint', 'gallon',
  // english volume abbreviations that dominate this corpus ("t chili powder", "c. flour")
  't', 'ts', 'tb', 'tbs', 'tbsp', 'tbsps', 'tsp', 'tsps', 'c', 'cup', 'cups',
  'teaspoon', 'teaspoons', 'tablespoon', 'tablespoons',
  'can', 'cans', 'pkg', 'pkgs', 'package', 'packages', 'stick', 'sticks', 'jar', 'jars',
  'dash', 'pinch', 'clove', 'cloves', 'slice', 'slices', 'bunch', 'sprig', 'sprigs',
  'head', 'bottle', 'box', 'bag', 'drop', 'drops', 'piece', 'pieces', 'doz', 'dozen',
  // size codes used as units in the scraped set ("lg egg", "md onion")
  'lg', 'md', 'sm', 'sq', 'x', 'gn', 'cn',
  // polish measures and containers
  'szt', 'sztuka', 'sztuki', 'sztuk', 'sztukę',
  'szklanka', 'szklanki', 'szklankę', 'szklanek', 'szklance',
  'łyżka', 'łyżki', 'łyżkę', 'łyżek', 'łyżeczka', 'łyżeczki', 'łyżeczkę', 'łyżeczek',
  'szczypta', 'szczypty', 'szczyptę', 'garść', 'garści', 'garstka',
  'pęczek', 'pęczka', 'pęczki', 'gałązka', 'gałązki', 'gałązek', 'gałązkę',
  'ząbek', 'ząbki', 'ząbka', 'ząbków', 'zabek',
  'plasterek', 'plasterki', 'plasterków', 'plaster', 'plastry', 'plastrów',
  'kostka', 'kostki', 'kostkę', 'puszka', 'puszki', 'puszkę',
  'opakowanie', 'opakowania', 'słoik', 'słoika', 'słoiczek',
  'butelka', 'butelki', 'kropla', 'krople', 'kropli',
  'listek', 'listki', 'liść', 'liście', 'listków',
  'kawałek', 'kawałki', 'kawałka', 'porcja', 'porcje', 'porcji',
  'kieliszek', 'kieliszka', 'filiżanka', 'filiżanki', 'filiżankę',
  'kubek', 'kubka', 'miarka', 'miarki', 'torebka', 'torebki', 'torebkę',
  'paczka', 'paczki', 'główka', 'główki', 'ćwiartka', 'ćwiartki',
  'słoiczka', 'szklankach', 'krążek', 'krążki',
]);

/** Approximation / quantity qualifiers — dropped outright. */
const QUANTITY_WORDS = new Set([
  'ok', 'około', 'okolo', 'pół', 'pol', 'połowa', 'połowę', 'ćwierć',
  'kilka', 'kilku', 'parę', 'pare', 'trochę', 'troche', 'odrobina', 'odrobinę',
  'nieco', 'więcej', 'wiecej', 'mniej', 'dużo', 'sporo',
  'about', 'approx', 'approximately', 'half', 'quarter', 'few', 'several', 'some',
  'plus', 'more', 'extra', 'additional', 'each', 'per',
]);

/**
 * Preparation / state / size / colour qualifiers — dropped so the head noun
 * survives. Polish entries are listed as stems and expanded over the adjective
 * endings, so 'biał' strips 'biała/białej/białych' but never the NOUN 'białko'.
 */
// Both adjective paradigms: hard stems ('zielon-ej', 'suszon-ych') and soft stems
// ('chińsk-iej', 'krakowsk-iego'). Missing the soft set leaves the modifier glued
// to the head noun ('kiełbasa krakowskiej').
const PL_ADJ_ENDINGS = [
  'y', 'a', 'e', 'i', 'ą', 'ie', 'em',
  'ego', 'emu', 'ej', 'ym', 'ych', 'ymi',
  'iego', 'iemu', 'iej', 'im', 'ich', 'imi', 'iem',
];
const PL_QUALIFIER_STEMS = [
  // preparation
  'mielon', 'zmielon', 'posiekan', 'siekan', 'pokrojon', 'krojon', 'obran',
  'start', 'tart', 'ugotowan', 'gotowan', 'obgotowan', 'parzon', 'wędzon', 'wedzon',
  'pieczon', 'upieczon', 'smażon', 'smazon', 'duszon', 'marynowan', 'kiszon',
  'solon', 'słodzon', 'slodzon', 'roztopion', 'rozpuszczon', 'przecedzon',
  'przesian', 'ubit', 'schłodzon', 'schlodzon', 'oczyszczon', 'umyt', 'opłukan',
  'oplukan', 'rozdrobnion', 'sparzon', 'namoczon', 'odsączon', 'odsaczon',
  'mrożon', 'mrozon', 'rozmrożon', 'rozmrozon', 'suszon', 'śwież', 'swiez',
  'konserwow', 'sproszkowan', 'skrusz', 'faszerowan', 'nadziewan',
  // size / shape / temperature / colour
  'duż', 'duz', 'mał', 'mal', 'średni', 'sredni', 'grub', 'cienk', 'cał', 'cal',
  'drobn', 'ciepł', 'ciepl', 'zimn', 'gorąc', 'gorac', 'letni', 'chłodn', 'chlodn',
  'zielon', 'czerwon', 'biał', 'bial', 'czarn', 'żółt', 'zolt', 'brązow', 'brazow',
  'dojrzał', 'dojrzal', 'młod', 'mlod', 'stary', 'chud', 'tłust', 'tlust', 'gęst', 'gest',
  // origin/style adjectives — they qualify the head noun, they are not the
  // ingredient ('chińskie suszone czarne grzybki' is a mushroom)
  'chińsk', 'chinsk', 'włosk', 'wlosk', 'francusk', 'greck', 'hiszpańsk', 'hiszpansk',
  'węgiersk', 'wegiersk', 'polsk', 'niemieck', 'tureck', 'meksykańsk', 'meksykansk',
  'japońsk', 'japonsk', 'tajsk', 'indyjsk', 'amerykańsk', 'amerykansk', 'angielsk',
  'wiejsk', 'domow', 'krakowsk', 'śląsk', 'slask', 'podlask',
];
const PL_QUALIFIERS = new Set<string>();
for (const stem of PL_QUALIFIER_STEMS) {
  for (const end of PL_ADJ_ENDINGS) PL_QUALIFIERS.add(stem + end);
}
// adverbs, and the trailing phrases 'do smaku' (to taste) / 'do dekoracji' (for
// garnish) — neither takes adjective endings, so both are listed literally.
for (const w of [
  'drobno', 'grubo', 'cienko', 'lekko', 'mocno', 'dobrze', 'najlepiej',
  'ewentualnie', 'opcjonalnie', 'ewent',
  'smaku', 'smak', 'dekoracji', 'posypania', 'wysmarowania', 'uznania', 'podania',
]) {
  PL_QUALIFIERS.add(w);
}

const EN_QUALIFIERS = new Set([
  'chopped', 'finely', 'coarsely', 'ground', 'minced', 'grated', 'shredded', 'sliced',
  'diced', 'cubed', 'crushed', 'peeled', 'seeded', 'cored', 'trimmed', 'pitted',
  'boneless', 'skinless', 'fresh', 'freshly', 'dried', 'frozen', 'canned', 'cooked',
  'uncooked', 'raw', 'melted', 'softened', 'beaten', 'sifted', 'packed', 'drained',
  'rinsed', 'halved', 'quartered', 'shelled', 'husked', 'stemmed', 'julienned',
  'large', 'small', 'medium', 'fine', 'coarse', 'thin', 'thick', 'thinly', 'thickly',
  'hot', 'cold', 'warm', 'chilled', 'room', 'temperature', 'whole', 'ripe', 'lean',
  'unsalted', 'salted', 'sweetened', 'unsweetened', 'low', 'fat', 'reduced',
  'optional', 'divided', 'well', 'lightly', 'boiling', 'cooking', 'preferably',
  'good', 'quality', 'best', 'firmly', 'loosely', 'heaping', 'level', 'scant',
  // trailing phrases: "salt to taste", "parsley for garnish", "flour as needed"
  'taste', 'garnish', 'needed', 'purpose', 'all-purpose',
]);

/**
 * Words that mark the string as NOT an ingredient name: cuisine/section labels,
 * yield and copyright metadata, and cooking-instruction prose. One hit rejects
 * the whole candidate.
 */
const NON_INGREDIENT_WORDS = new Set([
  // cuisine / section labels
  'kuchnia', 'kuchni', 'kuchnie', 'cuisine', 'rozdział', 'rozdzial', 'spis', 'treści',
  'książka', 'ksiazka', 'kucharska', 'przepis', 'przepisy', 'potrawy', 'dania',
  // yield / metadata
  'yield', 'serving', 'servings', 'serves', 'portions', 'copyright', 'recipe', 'recipes',
  'source', 'from', 'kcal', 'kal', 'kalorii', 'kalorie', 'calories',
  // table/column headers from the OCR'd cookbooks ("Danie | Wielkość | Piec")
  'danie', 'dania', 'daniu', 'wielkość', 'wielkosc', 'nazwa', 'skład', 'sklad',
  'składniki', 'skladniki', 'składnik', 'skladnik', 'sposób', 'sposob',
  'przygotowanie', 'przygotowania', 'wykonanie', 'czas', 'ilość', 'ilosc',
  'waga', 'cena', 'uwagi', 'razem', 'suma', 'opis', 'tabela', 'kategoria',
  'rodzaj', 'typ', 'poziom', 'piec', 'pieca', 'piecu', 'ingredients', 'directions',
  'instructions', 'preparation', 'method', 'notes', 'total',
  // instruction verbs / nouns (prose lines)
  'minut', 'minutes', 'minute', 'godzin', 'godziny', 'hours', 'hour', 'stopni', 'degrees',
  'piekarnik', 'piekarnika', 'oven', 'bake', 'cook', 'stir', 'serve', 'heat', 'preheat',
  'temp', 'temperatura', 'temperaturze', 'program', 'programie', 'sondę', 'sonda',
  'podajemy', 'układamy', 'ukladamy', 'dekoracja', 'dekoracje', 'dekoracją',
  // function words — a real ingredient name never contains them
  'że', 'ze', 'żeby', 'jest', 'są', 'sa', 'być', 'byc', 'jak', 'jaki', 'jaka', 'ale',
  'oraz', 'przez', 'dla', 'przy', 'więc', 'wiec', 'tylko', 'także', 'takze', 'można',
  'mozna', 'należy', 'nalezy', 'potem', 'następnie', 'nastepnie', 'wtedy', 'gdy',
  'jeśli', 'jesli', 'nasze', 'nasz', 'twoje', 'swoje', 'który', 'ktory', 'która',
  'ktora', 'które', 'ktore', 'this', 'that', 'they', 'your', 'you', 'will', 'would',
  'should', 'when', 'then', 'than', 'into', 'about', 'because', 'however', 'therefore',
  'until', 'while', 'with', 'without', 'over', 'under', 'their',
]);

/** Prepositions/conjunctions that appear INSIDE valid names ('mleko w proszku') — dropped, not rejected. */
const CONNECTOR_WORDS = new Set(['w', 'we', 'z', 'ze', 'na', 'do', 'po', 'od', 'bez', 'of', 'in', 'a', 'an', 'the', 'and', 'to', 'for']);

/**
 * Polish verb endings that mark an instruction line rather than an ingredient:
 * 1st-person plural ('rozgrzewamy', 'dodajemy') and 3rd-person ('potrzebuje',
 * 'zawierają'). No Polish food noun ends this way.
 */
const PL_VERB_RE = /^\p{L}{3,}(?:my|amy|emy|imy|ujemy|uje|ują|eje|eją)$/u;

/** Present participles ('ważący', 'zawierające') — modifiers, never the head noun. */
const PL_PARTICIPLE_RE = /^\p{L}{4,}ąc[yaąeę]$/u;

/** Frequent genitive/plural forms whose nominative is not derivable by rule. */
const LEMMA_EXCEPTIONS: Record<string, string> = {
  mąki: 'mąka', maki: 'mąka', mąkę: 'mąka', mące: 'mąka',
  masła: 'masło', masla: 'masło', masłem: 'masło',
  cukru: 'cukier', cukrem: 'cukier',
  soli: 'sól', solą: 'sól', sola: 'sól',
  wody: 'woda', wodą: 'woda', wodę: 'woda',
  mleka: 'mleko', mlekiem: 'mleko',
  oleju: 'olej', olejem: 'olej',
  octu: 'ocet', octem: 'ocet',
  czosnku: 'czosnek', czosnkiem: 'czosnek',
  cebuli: 'cebula', cebule: 'cebula', cebulę: 'cebula', cebulą: 'cebula',
  jaja: 'jajo', jaj: 'jajo', jajka: 'jajko', jajek: 'jajko',
  żółtka: 'żółtko', żółtek: 'żółtko',
  białka: 'białko', białek: 'białko',
  śmietany: 'śmietana', śmietaną: 'śmietana', śmietanę: 'śmietana',
  pietruszki: 'pietruszka', pietruszkę: 'pietruszka', pietruszką: 'pietruszka',
  tłuszczu: 'tłuszcz', tluszczu: 'tłuszcz',
  pieprzu: 'pieprz', pieprzem: 'pieprz',
  miodu: 'miód', miodem: 'miód',
  sera: 'ser', serem: 'ser', serze: 'ser',
  szynki: 'szynka', boczku: 'boczek', boczkiem: 'boczek',
  kurczaka: 'kurczak', kurczakiem: 'kurczak',
  wołowiny: 'wołowina', wieprzowiny: 'wieprzowina', cielęciny: 'cielęcina',
  ryżu: 'ryż', ryzu: 'ryż', makaronu: 'makaron',
  bułki: 'bułka', bułek: 'bułka', kaszy: 'kasza',
  groszku: 'groszek', grzybki: 'grzyb', grzybków: 'grzyb', grzybów: 'grzyb',
  pieczarki: 'pieczarka', pieczarek: 'pieczarka',
  papryki: 'papryka', paprykę: 'papryka', papryką: 'papryka',
  ogórka: 'ogórek', ogórki: 'ogórek', ogórków: 'ogórek',
  kapusty: 'kapusta', kapustę: 'kapusta',
  selera: 'seler', pora: 'por', porów: 'por',
  koperku: 'koperek', koperkiem: 'koperek',
  bazylii: 'bazylia', wanilii: 'wanilia', waniliowego: 'wanilia',
  majeranku: 'majeranek', cynamonu: 'cynamon', kolendry: 'kolendra',
  drożdży: 'drożdże', rodzynek: 'rodzynki', rodzynki: 'rodzynki',
  migdałów: 'migdał', orzechy: 'orzech',
  cytryny: 'cytryna', cytrynę: 'cytryna', jabłek: 'jabłko', jabłka: 'jabłko',
  śliwek: 'śliwka', truskawek: 'truskawka', malin: 'malina', wiśni: 'wiśnia',
  gruszek: 'gruszka', marchewki: 'marchewka', marchwi: 'marchew',
  ziemniaki: 'ziemniak', kiełbasy: 'kiełbasa', kiełbasę: 'kiełbasa',
  sosu: 'sos', sosem: 'sos', sosie: 'sos',
  bulionu: 'bulion', rosołu: 'rosół', wina: 'wino', winem: 'wino',
  margaryny: 'margaryna', oliwy: 'oliwa', oliwą: 'oliwa',
  szczypiorku: 'szczypiorek', chrzanu: 'chrzan', musztardy: 'musztarda',
  koncentratu: 'koncentrat', pomidorów: 'pomidor', pomidory: 'pomidor',
  fasoli: 'fasola', soczewicy: 'soczewica', kaszanki: 'kaszanka',
};

/**
 * Reduce a Polish inflected form toward the nominative. Deliberately conservative:
 * only the unambiguous genitive-plural '-ów' rule plus the exception table above.
 * Broader suffix rewriting (-y/-i → -a) is not applied — this corpus is half
 * English, and the rule would corrupt it ('honey' → 'honea').
 */
export function lemmatizePolish(token: string): string {
  const exception = LEMMA_EXCEPTIONS[token];
  if (exception) return exception;
  if (token.length >= 6 && (token.endsWith('ów') || token.endsWith('ow'))) {
    return token.slice(0, -2);
  }
  return token;
}

export type RejectReason = 'empty' | 'non-ingredient' | 'metadata' | 'prose' | 'numeric';

export interface NormalizedIngredient {
  /** The input, unchanged. */
  raw: string;
  /**
   * FALLBACK CHAIN for the first ingredient in the string — most specific form
   * first, then the bare head noun (e.g. ['kiełbasa krakowska', 'kiełbasa']).
   * The caller resolves down this chain and keeps the first form FlavorDB knows.
   * Empty when the string is not an ingredient at all.
   */
  candidates: string[];
  /**
   * OTHER ingredients in the same string, each a name in its own right, not a
   * fallback for the one above: substitutes from 'X lub Y' and further items
   * from a list line ('sól i pieprz' → candidates ['sól'], alternatives
   * ['pieprz']). Only the most specific form of each is kept.
   */
  alternatives: string[];
  /** Set when nothing survived, for diagnostics. */
  reason?: RejectReason;
}

const METADATA_RE = /(?:yield\s*:|copyright|www\.|https?:|\.com\b|\.net\b|\.org\b|©|\bgn\s?\d)/i;
const MAX_SEGMENT_TOKENS = 2;

/** Tokens that survive stripping but carry no information on their own. */
function isDroppableToken(token: string): boolean {
  if (UNIT_WORDS.has(token)) return true;
  if (QUANTITY_WORDS.has(token)) return true;
  if (PL_QUALIFIERS.has(token)) return true;
  if (EN_QUALIFIERS.has(token)) return true;
  if (CONNECTOR_WORDS.has(token)) return true;
  return false;
}

/** Clean one comma/`lub`-delimited segment down to its base-form candidates. */
function cleanSegment(segment: string): string[] {
  const rawTokens = segment
    .split(/[^\p{L}\p{N}%-]+/u)
    // Split glued digit/letter runs so "100g" and "to448" fall apart into a
    // quantity and a word — otherwise the real ingredient behind them is lost.
    .flatMap((t) => t.split(/(?<=\d)(?=\p{L})|(?<=\p{L})(?=\d)/u))
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  if (rawTokens.length === 0) return [];

  const kept: string[] = [];
  for (const token of rawTokens) {
    // quantities: bare numbers, fractions, vulgar fractions, ranges, "1/2", "0,5"
    if (/^[\d.,/½¼¾⅓⅔⅛%-]+$/.test(token)) continue;
    if (isDroppableToken(token)) continue;
    // an instruction line or a label — the whole segment is not an ingredient
    if (NON_INGREDIENT_WORDS.has(token)) return [];
    if (PL_VERB_RE.test(token)) return [];
    if (PL_PARTICIPLE_RE.test(token)) continue;
    if (token.length < 2) continue;
    kept.push(token);
  }

  if (kept.length === 0) return [];
  // Run-on lines survive tokenisation but are never a single ingredient name.
  if (kept.length > MAX_SEGMENT_TOKENS + 1) return [];

  const lemmas = kept.map(lemmatizePolish);
  const specific = lemmas.slice(0, MAX_SEGMENT_TOKENS).join(' ');
  const head = lemmas[0];
  return specific === head ? [specific] : [specific, head];
}

const ALTERNATIVE_SPLIT = /\s+(?:lub|albo|or)\s+|\s+\/\s+/;
const SEGMENT_SPLIT = /\s*[;,]\s*|\s+i\s+|\s+and\s+/;

/**
 * Normalize one raw `ingredients.name` string.
 *
 * Order matters: nutrition tables are cut at the first tab, parentheticals are
 * dropped, metadata is rejected whole, and only then is the remainder split into
 * alternatives ('X lub Y') and list segments — so a prose line cannot leak
 * fragments through the comma split.
 */
export function normalizeIngredientName(raw: string): NormalizedIngredient {
  const reject = (reason: RejectReason): NormalizedIngredient => ({ raw, candidates: [], alternatives: [], reason });

  if (typeof raw !== 'string' || raw.trim().length === 0) return reject('empty');

  let text = repairMojibake(raw).toLowerCase();
  // Nutrition-table rows keep the ingredient in the first column.
  text = text.split('\t')[0];
  // Parentheticals are always annotations here ("(105 kal, 7g tł.)", "( bez skóry )").
  text = text.replace(/\([^)]*\)/g, ' ').replace(/\([^)]*$/, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length === 0) return reject('empty');
  if (METADATA_RE.test(text)) return reject('metadata');
  if (!/\p{L}/u.test(text)) return reject('numeric');
  // A trailing colon marks a section header ("TO:", "From Cobblers:").
  if (/:\s*$/.test(text)) return reject('non-ingredient');

  // One group per ingredient found; each group is that ingredient's fallback chain.
  // Splitting alternatives first, then list separators, keeps 'A lub B, C' honest:
  // three groups, not one chain of three.
  const groups: string[][] = [];
  for (const part of text.split(ALTERNATIVE_SPLIT)) {
    for (const segment of part.split(SEGMENT_SPLIT)) {
      const chain = cleanSegment(segment);
      if (chain.length > 0) groups.push(chain);
    }
  }

  if (groups.length === 0) {
    return reject(text.split(' ').length > 4 ? 'prose' : 'non-ingredient');
  }

  const candidates = groups[0];
  const alternatives: string[] = [];
  for (const group of groups.slice(1)) {
    const name = group[0];
    if (!candidates.includes(name) && !alternatives.includes(name)) alternatives.push(name);
  }
  return { raw, candidates, alternatives };
}

/**
 * Share of strings in a list that are not ingredient names at all.
 *
 * This separates a genuinely long recipe from a whole cookbook chapter parsed as
 * one record: measured over the library, normal recipes (5–40 ingredients) sit at
 * a mean of 0.163 and only 4.6% exceed 0.5, while the chapter blobs — 'MIĘSO'
 * (235 "ingredients"), 'SMAK & ŚNIADANIA' (313) — run 0.56–1.00. A 101-ingredient
 * chili recipe scores 0.30 and is correctly kept.
 */
export function nonIngredientRatio(names: string[]): number {
  if (names.length === 0) return 1;
  let rejected = 0;
  for (const name of names) {
    if (normalizeIngredientName(name).candidates.length === 0) rejected++;
  }
  return rejected / names.length;
}

/**
 * A whole cookbook chapter imported as one recipe, rather than a recipe.
 *
 * All three signals are required, because each one alone is wrong:
 *  - SIZE alone quarantines real food: '"Capitol Punishment" Chili' genuinely
 *    lists 101 ingredients and carries 225 steps.
 *  - NON-INGREDIENT RATIO alone quarantines real food too: OCR fragmented
 *    'Another Chili Recipe' into bare 't'/'T'/number rows, so 81% of its
 *    "ingredients" are unparseable — the recipe itself is fine.
 *  - AN ALL-CAPS NAME alone is common in this corpus ('WIEJSKIE PLACKI
 *    ZIEMNIACZANE' is a real potato-pancake recipe with 11 ingredients).
 *
 * Together they select the chapter headings and nothing else: 'MIĘSO' (a meat
 * chapter, 235 "ingredients", 79% non-ingredient), 'SMAK & ŚNIADANIA' (313, 81%).
 */
export function isChapterBlob(name: string, ingredientNames: string[]): boolean {
  if (ingredientNames.length <= 40) return false;
  const trimmed = name.trim();
  const allCaps = trimmed.length > 1 && /\p{Lu}/u.test(trimmed) && trimmed === trimmed.toUpperCase();
  if (!allCaps) return false;
  return nonIngredientRatio(ingredientNames) > 0.5;
}

/**
 * Normalize a list of raw ingredient names into a deduplicated candidate list,
 * preserving first-seen order. Each entry keeps its fallback chain so the caller
 * can prefer the form that actually resolves.
 */
export function normalizeIngredientNames(rawNames: string[]): NormalizedIngredient[] {
  const seen = new Set<string>();
  const out: NormalizedIngredient[] = [];
  for (const raw of rawNames) {
    const normalized = normalizeIngredientName(raw);
    if (normalized.candidates.length === 0) continue;
    const key = normalized.candidates[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
