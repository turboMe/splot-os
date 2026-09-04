# Plan wdrożenia: Chef Agent - Profesjonalne Menu AI

## Kontekst

Cel: rozbudowa meta-agenta o zdolności projektowania profesjonalnych menu gastronomicznych, opartych na rozległej wiedzy kulinarnej zebranej w researchu (`ideas/profesjonalna_architektura_wiedzy_agent_ai_menu_PL.md`).

System już posiada:
- Meta-agent z ReAct loop i ~93 narzędziami w tool-registry
- Integrację z NotebookLM (7 istniejących notatników + tryby existing/temporary/search)
- Własny RAG z embeddingami do odkrywania narzędzi
- Pamięć agenta (MongoDB + embeddingi wektorowe)
- System domen (`marketing`, `research`, `crm`, `terminal`, `automation`)
- Shared memory dla kontekstu międzyagentowego
- SSE do aktualizacji w czasie rzeczywistym

---

## Faza 1: Baza wiedzy - NotebookLM

**Cel**: Zasilenie agenta profesjonalną wiedzą kulinarną poprzez istniejącą infrastrukturę NotebookLM.

### 1.1 Utworzenie notatników kulinarnych

Stworzyć 10 notatników zgodnie z architekturą z researchu:

| # | ID notatnika | Temat | Priorytet |
|---|---|---|---|
| 1 | `chef_menu_engineering` | Menu engineering, typy lokali, formaty, porcje eventowe | P0 |
| 2 | `chef_flavor` | Nauka o smaku, pairing, bridging, regionalne palety | P0 |
| 3 | `chef_texture` | Tekstura, mouthfeel, plating, modernistyczne techniki | P1 |
| 4 | `chef_classic` | Technika klasyczna, sosy matka, stocki, brigade, kanon francuski | P1 |
| 5 | `chef_modern` | Sous vide, fermentacja, techniki molekularne, konserwacja | P1 |
| 6 | `chef_europe` | Włochy, Francja, Śródziemnomorze | P1 |
| 7 | `chef_asia` | Chiny, Japonia, Korea, Azja PD-Wschodnia, Indie | P1 |
| 8 | `chef_americas_mena` | Meksyk, Ameryka Łacińska, Bliski Wschód, Afryka Północna, Nordic | P1 |
| 9 | `chef_psychology` | Psychologia menu, doświadczenie gościa, narracja, ograniczenia dietetyczne | P0 |
| 10 | `chef_master` | Notatnik orkiestracyjny - sezonowość, alergeny, temperatury, routing | P0 |

### 1.2 Rejestracja w systemie

- Dodać nowe ID do `KNOWN_NOTEBOOK_IDS` w `packages/shared/src/constants.ts`
- Dodać definicje do `NOTEBOOK_DEFINITIONS` z opisami po polsku
- `chef_master` powinien być zawsze ładowany gdy domena to `chef` (analogicznie jak agent ma domyślne notebooki `['rynek', 'rhd', 'konkurencja', 'founder']`)

### 1.3 Zasilenie źródłami

Research wymienia konkretne książki i źródła per notatnik (§7 researchu). Każdy notatnik powinien mieć 20-50 źródeł. Można to zrobić etapami - zacząć od P0, potem P1.

Alternatywnie: sam research jest na tyle gęsty i dobrze ustrukturyzowany, że jego sekcje mogą być **pierwszymi źródłami** w odpowiednich notatnikach. Sekcje 1-2 → notebook 1-2, sekcje 3-4 → notebook 3-4 itd. To da natychmiastowy start bez czekania na pełną bibliotekę.

---

## Faza 2: Warstwa danych - MongoDB

**Cel**: Dedykowane miejsce na projekty menu, wygenerowane menu i notatki chefa.

### 2.1 Kolekcja `chef_projects`

Centralna kolekcja przechowująca kontekst projektu menu - zebrane odpowiedzi z kwestionariusza i metadane.

```
chef_projects:
  id: string (UUID)
  name: string                    // "Menu weselne Kowalskich" 
  status: 'draft' | 'questionnaire' | 'generating' | 'review' | 'finalized'
  
  // Profil zebrany z kwestionariusza
  profile:
    establishmentType: string     // bistro | casual | upscale | fine_dining | event_catering | food_truck | hotel
    eventType?: string            // wedding | corporate | cocktail | seasonal | private
    cuisineTypes: string[]        // ['french', 'italian', 'mediterranean']
    cuisineApproach: string       // traditional | modern | fusion | regional
    serviceFormat: string         // a_la_carte | tasting | prix_fixe | buffet | family_style | stations
    
    guestProfile:
      count: number
      demographics: string        // family | corporate | young_couples | mixed
      dietaryRestrictions: string[] // vegetarian, vegan, gluten_free, halal, kosher, nut_free...
      restrictionPercentage: number // szacowany % gości z ograniczeniami
    
    priceRange:
      tier: string                // budget | mid | premium | luxury
      currency: string
      avgMainPrice?: number
    
    seasonality:
      targetSeason: string        // spring | summer | autumn | winter
      targetMonth?: number
      rotationStrategy?: string   // quarterly | monthly | weekly_specials
    
    location:
      region: string              // np. "central_europe" | "mediterranean" 
      country: string
      localIngredients: boolean   // czy priorytet na lokalne składniki
    
    identity:
      signatureDishes: string[]   // anchor dishes które nie rotują
      narrative?: string          // "Podróż przez Toskanie jesienią"
      chefPhilosophy?: string
    
    operationalConstraints:
      kitchenCapability: string[] // grill, sous_vide, smoker, wood_oven...
      staffLevel: string          // minimal | standard | full_brigade
      miseEnPlaceSharing: boolean // czy dania muszą dzielić komponenty
    
    additionalNotes: string
  
  // Historia wersji menu
  menuVersions: string[]          // referencje do chef_menus.id
  currentMenuId?: string
  
  createdAt: Date
  updatedAt: Date
  createdBy: string               // threadId konwersacji
```

### 2.2 Kolekcja `chef_menus`

Wygenerowane dokumenty menu.

```
chef_menus:
  id: string (UUID)
  projectId: string               // ref → chef_projects.id
  version: number
  
  title: string
  narrative: string               // 2-3 zdania opisu/historii menu
  
  sections: Array<
    name: string                  // "Przystawki", "Dania główne", "Desery"...
    dishes: Array<
      name: string
      description: string         // opis na menu (styl zależny od typu lokalu)
      ingredients: string[]       // główne składniki
      techniques: string[]        // użyte techniki
      flavorProfile:
        dominant: string[]        // np. ['umami', 'sour']
        bridges: string[]        // składniki pomostowe
        family: string           // rodzina aromatyczna
      textures: string[]          // crispy, creamy, silky...
      temperature: string         // hot | warm | cold | frozen | mixed
      allergens: string[]         // matrix alergenów
      dietaryTags: string[]       // vegetarian, vegan, gf, halal...
      menuEngineering:
        predictedQuadrant: string // star | plowhorse | puzzle | dog
        costTier: string          // low | medium | high
        marginLever: string       // co napędza marżę
      pairingWine?: string
      pairingNonAlcoholic?: string
      plateDescription?: string   // wizja platingu
    >
  >
  
  metadata:
    totalDishes: number
    cuisineBalance: object        // rozkład kuchni
    allergenMatrix: object        // macierz alergenów per danie
    seasonalIngredients: string[] // składniki sezonowe użyte
    techniqueDistribution: object // rozkład technik (aby uniknąć powtórzeń)
    temperatureArc: string[]      // łuk temperatur przez cały posiłek
    textureVariety: number        // score różnorodności tekstur
    
  generatedAt: Date
  sources: Array<{ notebook, citation }> // skąd agent czerpał wiedzę
```

### 2.3 Kolekcja `chef_notes`

Notatki robocze agenta-chefa - preferencje klienta, odkryte pairingi, notatki z iteracji.

```
chef_notes:
  id: string (UUID)
  projectId?: string              // opcjonalnie powiązane z projektem
  type: 'preference' | 'pairing' | 'technique' | 'seasonal' | 'feedback' | 'general'
  topic: string
  content: string
  embedding: number[]             // wektor do semantic search
  createdAt: Date
```

### 2.4 Inicjalizacja w `db.ts`

Dodać kolekcje i indeksy w `ensureCollections()` w `apps/workers/src/core/db.ts`:
- `chef_projects`: index na `id`, `status`, `createdBy`
- `chef_menus`: index na `id`, `projectId`
- `chef_notes`: index na `id`, `projectId`, `type`

---

## Faza 3: Domena i narzędzia

**Cel**: Nowa domena `chef` z dedykowanymi narzędziami, zintegrowana z istniejącym toolchain.

### 3.1 Nowa domena systemowa

Dodać do `SYSTEM_DOMAINS` w `packages/shared/src/agentConfig.ts`:

```
id: 'chef'
label: 'Chef & Menu Design'
icon: '👨‍🍳'
categories: ['chef', 'knowledge']
instruction: 'Działaj jako profesjonalny Head Chef i konsultant menu. 
  Tworzysz menu w oparciu o wiedzę z menu engineering, nauki o smaku,
  technik kulinarnych i psychologii gościa. Zawsze zaczynaj od 
  zrozumienia potrzeb klienta przez pytania diagnostyczne...'
```

To daje:
- Slot w UI dashboardu (slash-menu `/chef`)
- Kontekstową instrukcję systemową dla LLM
- Filtrowanie narzędzi do kategorii `chef` + `knowledge`

### 3.2 Nowa kategoria narzędzi

Dodać `'chef'` do unii `ToolCategory` w `tool-definitions.ts`.

### 3.3 Definicje narzędzi

Nowe narzędzia w `META_AGENT_TOOL_DEFINITIONS`:

| Narzędzie | Opis | Risk | Approval |
|---|---|---|---|
| `chef.start_project` | Tworzy nowy projekt menu i inicjuje kwestionariusz | write | no |
| `chef.update_profile` | Aktualizuje profil projektu po zebraniu odpowiedzi | write | no |
| `chef.get_project` | Pobiera szczegóły projektu | read | no |
| `chef.list_projects` | Lista projektów menu | read | no |
| `chef.generate_menu` | Generuje menu na podstawie profilu (wielokrokowe z NotebookLM) | write | no |
| `chef.save_menu` | Zapisuje wygenerowane menu | write | no |
| `chef.get_menu` | Pobiera zapisane menu | read | no |
| `chef.iterate_menu` | Modyfikuje istniejące menu na podstawie feedbacku | write | no |
| `chef.query_knowledge` | Odpytuje notebooki kulinarne (wrapper na NotebookLM) | read | no |
| `chef.suggest_pairing` | Sugestie pairingów smakowych dla składników | read | no |
| `chef.check_seasonal` | Sprawdza sezonowość składników dla regionu i daty | read | no |
| `chef.add_note` | Dodaje notatkę roboczą chefa | write | no |
| `chef.search_notes` | Szuka w notatkach chefa (semantic search) | read | no |
| `chef.export_menu` | Eksportuje menu do formatu gotowego do druku/PDF | read | yes |

Każde narzędzie z keywords po polsku i angielsku do RAG discovery, np.:
`chef.start_project` → `['menu', 'nowe menu', 'zaprojektuj menu', 'restauracja', 'karta dań', 'wesele', 'event', 'catering', 'bistro', 'fine dining']`

### 3.4 Handlery w tool-registry

Każdy handler w `TOOL_HANDLERS` w `tool-registry.ts`. Kluczowe:

- **`chef.start_project`**: tworzy rekord w `chef_projects`, ustawia status `questionnaire`, zwraca ID i pierwszy zestaw pytań (na podstawie wstępnie podanego typu lokalu)
- **`chef.generate_menu`**: wielokrokowy - odpytuje odpowiednie notebooki NotebookLM, buduje menu sekcja po sekcji, weryfikuje balans (techniki, tekstury, temperatury, alergeny), zapisuje wynik
- **`chef.query_knowledge`**: korzysta z istniejącego `MetaNotebookService` w trybie `existing` z notebook IDs z domeny `chef_*`
- **`chef.suggest_pairing`**: odpytuje `chef_flavor` notebook + wbudowane heurystyki z researchu (flavor bridging)

---

## Faza 4: Inteligentny kwestionariusz

**Cel**: Agent zadaje trafne pytania, aby zbudować idealny profil menu. Pytania adaptują się do kontekstu.

### 4.1 Drzewo decyzyjne pytań

Kwestionariusz nie jest liniowy - jest drzewem. Typ lokalu determinuje kolejne gałęzie:

```
[1] Typ punktu gastronomicznego?
    ├── Restauracja → [2a] Poziom? (bistro / casual / upscale / fine dining)
    │   ├── Fine dining → pytania o tasting menu, amuse-bouche, łuk narracyjny
    │   ├── Bistro → pytania o rozmiar karty, dania dnia, sezonowość
    │   └── Casual → pytania o breadth menu, kids menu, family-style
    ├── Event / catering → [2b] Typ eventu?
    │   ├── Wesele → format (plated / buffet / family / cocktail+stacje)
    │   │   → liczba gości, budżet, sezon, ograniczenia religijne
    │   │   → czy cocktail hour przed, ile canapés na osobę
    │   ├── Korporacyjny → inkluzywność dietetyczna, czas serwisu, profil smaku
    │   └── Cocktail / reception → duration, hot/cold ratio, bite-size
    ├── Food truck / street food → pytania o speed, portability, signature item
    └── Hotel → pytania o śniadania, room service, restauracja hotelowa, bankiety

[3] Kuchnia(e)?
    → Jedna dominująca vs. multi-cuisine vs. fusion
    → Jeśli fusion: które elementy z jakiej kuchni (zasady z §5.10 researchu)
    → Regionalna specyfika (np. nie "włoska" a "toskańska" vs "sycylijska")

[4] Profil gości?
    → Liczba
    → Demografia (wiek, kultura)
    → Ograniczenia dietetyczne i % gości z ograniczeniami
    → Czy potrzebne ścieżki równoległe (vege tasting, pescatarian tasting)

[5] Sezon i lokalizacja?
    → Docelowy miesiąc/sezon
    → Region klimatyczny (wpływa na dostępność składników)
    → Priorytet na lokalne składniki?

[6] Budżet i format cenowy?
    → Tier cenowy
    → Strategia cenowa (anchoring, good-better-best)

[7] Tożsamość i narracja?
    → Signature dishes (anchor SKUs - nie rotują)
    → Filozofia szefa kuchni
    → Łuk narracyjny (sezonowa podróż / terroir / wspomnienie / showcase / konceptualne)

[8] Ograniczenia operacyjne?
    → Możliwości kuchni (sprzęt)
    → Poziom kadry
    → Współdzielenie mise-en-place między daniami
```

### 4.2 Implementacja w ReAct loop

Agent **nie** dostaje jednorazowej listy pytań. Zamiast tego:

1. Użytkownik pisze np. "zaprojektuj menu na wesele"
2. Intent classification → `tool_request` (wykrywa `chef.*`)
3. Agent wywołuje `chef.start_project` z `eventType: 'wedding'`
4. Narzędzie zwraca: ID projektu + kontekst jakie pytania jeszcze trzeba zadać (na podstawie pustych pól w profilu)
5. Agent **w naturalnej konwersacji** zadaje pytania - 2-3 naraz, nie wszystkie od razu
6. Po każdej odpowiedzi użytkownika agent wywołuje `chef.update_profile` z zebranymi danymi
7. Narzędzie zwraca zaktualizowany profil + listę brakujących pól + sugestie domyślnych wartości
8. Agent kontynuuje pytania aż profil jest kompletny
9. Gdy profil gotowy → agent proponuje generację menu

**Kluczowe**: Drzewo pytań jest zakodowane jako logika w handlerze `chef.start_project` i `chef.update_profile` - narzędzie mówi agentowi *co jeszcze trzeba ustalić*, a agent formułuje pytania naturalnie. Agent jest konwersacyjny, narzędzie jest strukturalne.

### 4.3 Domyślne wartości i szablony

Dla typowych scenariuszy agent sugeruje sensowne defaults z researchu:
- Wesele, 120 osób → propozycja: plated 4-daniowe, 2 opcje main do wyboru, parallel vege ścieżka, 30% ograniczeń dietetycznych
- Bistro → 6-10 przystawek, 8-12 mains, 4-6 deserów, dania dnia
- Fine dining tasting → 8-12 dań, progresja lekkie→ciężkie, palate cleanser co 4-5 dań

Użytkownik może zaakceptować defaults lub je modyfikować.

---

## Faza 5: Silnik generacji menu

**Cel**: Wielokrokowa generacja profesjonalnego menu z weryfikacją jakości.

### 5.1 Pipeline generacji

Gdy profil jest kompletny, `chef.generate_menu` uruchamia pipeline:

```
Krok 1: ROUTING
  → Odpytaj chef_master (notatnik orkiestracyjny) z profilem
  → Otrzymaj rekomendację: które notatniki odpytać i w jakiej kolejności
  → Wynik: lista notatników + kontekstowe pytania do każdego

Krok 2: RESEARCH
  → Odpytaj wskazane notatniki równolegle (2-4 z nich)
  → chef_menu_engineering → szablon struktury dla tego typu lokalu
  → chef_flavor → paleta smakowa dla wybranej kuchni
  → chef_psychology → zasady progresji dań i doświadczenia gościa
  → Notatnik regionalny (6/7/8) → specyfika kuchni
  → Wynik: zebrany kontekst z NotebookLM + cytaty

Krok 3: SZKIELET
  → Na podstawie kontekstu z Kroku 2 + profilu projektu
  → Wygeneruj strukturę menu: sekcje, liczba dań per sekcja, poziomy cenowe
  → Zastosuj zasady menu engineering (macierz Kasavana-Smith)
  → Wynik: szkielet menu bez konkretnych dań

Krok 4: KOMPOZYCJA
  → Dla każdej sekcji generuj dania
  → Weryfikuj pairingi smakowe (odpytaj chef_flavor jeśli potrzeba)
  → Sprawdzaj sezonowość składników
  → Buduj każde danie z: min. 3 tekstury, kontrast temperatury, complete bite
  → Wynik: pełne dania z opisami

Krok 5: WALIDACJA
  → Sprawdź balans technik (max 2 tego samego sous vide, sear itp. niekolejno)
  → Sprawdź łuk temperatur (zimne→ciepłe→gorące→ciepłe→zimne)
  → Sprawdź różnorodność rodzin aromatycznych (nie 3 alliums pod rząd)
  → Sprawdź macierz alergenów
  → Sprawdź równoległe ścieżki dietetyczne
  → Sprawdź operacyjną wykonalność (mise-en-place sharing)
  → Wynik: raport walidacji + korekty

Krok 6: FINALIZACJA
  → Wygeneruj opisy dań w stylu dopasowanym do typu lokalu
     (bistro: 5-10 słów | fine dining: 3-5 składników | casual: sensoryczne opisy)
  → Wygeneruj narrację menu (2-3 zdania)
  → Sugestie wine pairing per danie
  → Zapisz w chef_menus
```

### 5.2 Wykorzystanie istniejącej infrastruktury

- **Generacja LLM**: Używa istniejącego `callLLM()` z odpowiednim modelem (najlepiej najsilniejszy dostępny, konfigurowalny w `agentConfig.ts`)
- **NotebookLM queries**: Przez istniejący `MetaNotebookService` z rozszerzonym zestawem notatników
- **Progress reporting**: Istniejące SSE events (`meta:tool_start`, `meta:progress`, `meta:tool_done`) informują dashboard o postępie wielokrokowej generacji
- **Citations**: Źródła z NotebookLM przepływają do UI jako `sources` w wiadomości

### 5.3 Iteracja menu

`chef.iterate_menu` pozwala na modyfikacje po generacji:
- "Zamień rybę na pozycji 5 na coś mięsnego"
- "Dodaj więcej opcji wegańskich"
- "Uprość desery - za dużo technik modernistycznych"
- "Zamień na kuchnię bardziej azjatycką"

Agent ładuje istniejące menu, aplikuje zmianę, re-waliduje balans, zapisuje nową wersję. Wersjonowanie w `chef_menus.version`.

---

## Faza 6: Integracja z dashboardem

**Cel**: Użytkownik widzi projekty menu, postęp generacji i wynik w UI.

### 6.1 Nowe API routes

W `apps/dashboard/src/app/api/`:

- `GET /api/chef/projects` - lista projektów
- `GET /api/chef/projects/[id]` - szczegóły projektu z aktualnym menu
- `GET /api/chef/menus/[id]` - pełne menu z metadanymi
- `GET /api/chef/menus/[id]/export` - export do PDF/print-ready

### 6.2 Rozszerzenie MetaAgentChat

Nie tworzymy osobnej strony - menu design dzieje się w istniejącym chacie meta-agenta:

- **Quick Action chip**: Dodać "Projektuj Menu" do chips w `MetaAgentChat.tsx`
- **Slash-menu**: `/chef` aktywuje domenę chef (już obsługiwane przez istniejący mechanizm domen)
- **Wizualizacja menu**: Gdy agent generuje menu, wynik renderowany jako sformatowana karta w wiadomości (podobnie jak `suggestedJobs` czy `sources` - nowy typ display)
- **Progress stepper**: Istniejący ReAct stepper pokazuje kroki generacji (Research → Szkielet → Kompozycja → Walidacja → Finalizacja)

### 6.3 Opcjonalnie: Strona Chef Projects

Jeśli potrzebna dedykowana strona:
- `/dashboard/chef` - lista projektów z statusami
- Klik w projekt → widok menu z sekcjami, macierzą alergenów, raportami walidacji
- Eksport do PDF

---

## Faza 7: Prompt engineering

**Cel**: Nauczyć agenta myśleć jak Head Chef.

### 7.1 Nowy prompt specjalistyczny

Dodać plik `apps/workers/src/agents/meta-agent/prompts/chef-domain.md`:

Zawartość - skondensowana wiedza z researchu, sformatowana jako instrukcje dla LLM:
- Zasady menu engineering (macierz Kasavana-Smith)
- Psychologia menu (primacy/recency, paradoks wyboru, eye-flow)
- Progresja dań (lekkie→ciężkie, zimne→gorące→zimne, kwas po tłuszczu)
- Kontrast tekstur (min. 3 per danie, min. 1 para kontrastowa)
- Flavor bridging (trzeci składnik łączący dwa niepowiązane)
- Menu fatigue prevention (max 2 te same techniki niekolejno)
- Complete bite philosophy (każdy kęs zawiera każdy element)
- Styl opisu wg typu lokalu

Ten prompt ładowany jest kontekstowo gdy domena = `chef` (analogicznie do instrukcji w `SYSTEM_DOMAINS[].instruction`, ale obszerniejszy - osobny plik).

### 7.2 Rozszerzenie intent classification

W `intent-router.md` dodać pattern matching na chef/menu/gastronomia:
- "zaprojektuj menu", "stwórz kartę dań", "menu na wesele" → `tool_request` z context chef
- Dodać regex fallbacki w `fallbackIntent()` na słowa: menu, danie, kuchnia, restauracja, wesele, catering, chef

### 7.3 Agent musi wiedzieć kiedy odpytywać NotebookLM

W promptcie chef-domain jasno opisać routing:
- Pytania o strukturę/format menu → `chef_menu_engineering`
- Pytania o pairingi → `chef_flavor`
- Pytania o techniki → `chef_classic` lub `chef_modern`
- Pytania o kuchnię regionalną → odpowiedni notatnik (6/7/8)
- Pytania o psychologię gościa → `chef_psychology`
- Wątpliwości ogólne → `chef_master`

---

## Faza 8: RAG i tool discovery

**Cel**: Agent odkrywa narzędzia chefa przez semantic search.

### 8.1 Sync narzędzi

W istniejącym `tool-rag-service.ts` metoda `syncTools()` automatycznie zaindeksuje nowe narzędzia `chef.*` dzięki temu, że czyta z `META_AGENT_TOOL_DEFINITIONS`. Wystarczy dobrze dobrać `keywords` i `description`.

### 8.2 Sync notatników

`syncN8nWorkflows()` może być rozszerzony (lub stworzony osobny `syncChefNotebooks()`) aby zaindeksować notatniki kulinarne jako wirtualne źródła wiedzy, odkrywane przez `system.search_tools`.

---

## Kolejność wdrożenia

```
Etap 1 (fundament):
  ├── Kolekcje MongoDB (Faza 2)
  ├── Domena systemowa chef (Faza 3.1-3.2)
  └── Prompt chef-domain.md (Faza 7.1)

Etap 2 (narzędzia core):
  ├── Definicje narzędzi chef.* (Faza 3.3)
  ├── Handlery narzędzi (Faza 3.4)
  ├── Logika kwestionariusza (Faza 4)
  └── Intent classification updates (Faza 7.2)

Etap 3 (wiedza):
  ├── Utworzenie notatników P0 w NotebookLM (Faza 1.1)
  ├── Zasilenie źródłami z researchu (Faza 1.3)
  └── Rejestracja w systemie (Faza 1.2)

Etap 4 (generacja):
  ├── Pipeline generacji menu (Faza 5.1)
  ├── Iteracja menu (Faza 5.3)
  └── RAG sync (Faza 8)

Etap 5 (UI):
  ├── Quick action chip + slash command (Faza 6.2)
  ├── Wizualizacja menu w chacie (Faza 6.2)
  ├── API routes (Faza 6.1)
  └── Opcjonalnie: strona Chef Projects (Faza 6.3)

Etap 6 (notatniki P1):
  └── Zasilenie pozostałych notatników (Faza 1)
```

---

## Ryzyka i decyzje do podjęcia

1. **Limity NotebookLM**: 10 nowych notatników to dużo. Jeśli limit ilościowy jest problemem, skonsolidować do 6-7 (połączyć notatniki regionalne). Zacząć od P0 (4 notatniki) i rozbudowywać.

2. **Koszt odpytywania**: Generacja menu to 3-6 zapytań do NotebookLM + wielokrokowe LLM. Warto rozważyć cache wyników NotebookLM per profil/kuchnia w `chef_notes` aby nie odpytywać za każdym razem tych samych rzeczy.

3. **Długość generacji**: Pipeline 6-krokowy może trwać 2-5 minut. Istniejący SSE + stepper w UI to obsłuży, ale warto ustawić realistyczne oczekiwania (heartbeat progress co 4s już istnieje).

4. **Prompt length**: Chef-domain prompt + kontekst z NotebookLM + profil projektu mogą być duże. Rozważyć dynamiczne ładowanie sekcji promptu w zależności od etapu pipeline (nie wszystko naraz).

5. **Własny RAG vs NotebookLM**: Dla rzeczy które nie zmieniają się (tabele temperatur, macierze alergenów, proporcje stocków) - lepiej wbudować w prompt lub w `chef_master` niż odpytywać dynamicznie. NotebookLM rezerwować na wiedzę złożoną wymagającą syntezowania.
