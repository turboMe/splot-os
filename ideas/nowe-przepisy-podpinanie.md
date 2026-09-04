# Poradnik: Zbieranie, Formatowanie i Podpinanie Nowych Przepisów dla chefAgent

Niniejszy dokument opisuje kompletny proces pozyskiwania przepisów z internetu, ich standaryzacji do formatu JSON oraz automatycznego indeksowania w bazie wektorowej Mastra i warstwie chemicznej FlavorDB.

---

## 1. Architektura i Przepływ Danych

```
[Agent Scraper / WWW]
        │  (Pobiera przepis ze strony, czyści i normalizuje)
        ▼
[Pliki JSON na dysku] ──► storage/recipes/recipes-structured/<kategoria>.json
        │
        ├── 1. npm run embed:recipe-library ────► MongoDB: `chef_recipe_library` + wektory bge-m3
        ├── 2. npm run build:flavor-aliases  ───► Dopasowanie składników PL ➔ EN FlavorDB (`chef_flavor_aliases`)
        └── 3. npm run enrich:recipe-flavor  ───► Profil zapachowy i cząsteczki PubChem (`flavorProfileFdb`)
```

---

## 2. Format Plików i Dozwolone Kategorie

### 📁 Lokalizacja plików na dysku
Pliki z przepisami znajdują się w katalogu:
`storage/recipes/recipes-structured/<kategoria>.json`

System wczytuje **wszystkie pliki `.json`** z tego katalogu (z wyłączeniem plików zaczynających się od podkreślnika `_`).

### 🏷️ Dozwolone kategorie (`category`):
- `dania-glowne` — pełne dania obiadowe, mięsa, ryby
- `bazy-polprodukty` — ciasta bazowe, zasmażki, marynaty, półprodukty
- `zupy` — zupy czyste, kremy, chłodniki
- `przystawki` — zimne i ciepłe startery
- `desery` — desery talerzowe, musy, lody
- `wypieki-slodkie` — ciasta, tarty, ciasteczka
- `sosy-cieple` — sosy na ciepło (demi-glace, pieprzowy, beszamel)
- `sosy-zimne` — majonezy, dipy, sosy chrzanowe
- `salatki` — sałatki i surówki
- `fermenty-pikle` — kiszonki, pikle, octy smakowe
- `wywary-buliony` — wywary mięsne, rybne, warzywne, esencje
- `napoje` — napary, kompoty, syropy
- `dodatki-garnitury` — purée, kluski, warzywa glacowane
- `dressingi-winegrety` — sosy sałatkowe, emulsje zimne
- `dania-jednogarnkowe` — gulasze, potrawki, curry

---

## 3. Schemat JSON Pojedynczego Przepisu

Każdy plik JSON to tablica obiektów o następującej strukturze:

```json
[
  {
    "id": "sosy-cieple--klasyczny-sos-pieprzowy",
    "name": "Klasyczny sos pieprzowy",
    "aliases": ["Sauce au poivre", "Sos z zielonego pieprzu"],
    "type": "component",
    "category": "sosy-cieple",
    "subcategory": "sosy na demi-glace",
    "cuisine": ["francuska"],
    "course": "dodatek",
    "techniques": ["deglesowanie", "redukowanie", "montowanie masłem"],
    "flavorProfile": {
      "dominant": ["pieprzny", "maślany", "umami"],
      "family": "pieprzowe"
    },
    "textures": ["kremowy", "gładki"],
    "temperature": "ciepłe",
    "allergens": ["mleko", "seler"],
    "dietaryTags": ["bezglutenowe"],
    "yield": {
      "amount": 4,
      "unit": "porcji"
    },
    "ingredients": [
      {
        "name": "zielony pieprz z zalewy",
        "quantity": 30.0,
        "unit": "g",
        "notes": "lekko rozgnieciony"
      },
      {
        "name": "koniak",
        "quantity": 50.0,
        "unit": "ml",
        "notes": "lub brandy do flambowania"
      },
      {
        "name": "demi-glace wołowy",
        "quantity": 250.0,
        "unit": "ml",
        "notes": "mocno zredukowany wywar"
      },
      {
        "name": "śmietanka 36%",
        "quantity": 100.0,
        "unit": "ml",
        "notes": null
      },
      {
        "name": "masło",
        "quantity": 30.0,
        "unit": "g",
        "notes": "bardzo zimne, do montowania"
      },
      {
        "name": "sól",
        "quantity": null,
        "unit": null,
        "notes": "do smaku"
      }
    ],
    "steps": [
      {
        "order": 1,
        "instruction": "Na patelni podsmażyć rozgnieciony zielony pieprz.",
        "time": 2,
        "temperature": 160
      },
      {
        "order": 2,
        "instruction": "Wlać koniak, zdeglazować dno patelni i zredukować alkohol o połowę.",
        "time": 3,
        "temperature": 100
      },
      {
        "order": 3,
        "instruction": "Dodać demi-glace oraz śmietankę, gotować na małym ogniu do zgęstnienia.",
        "time": 5,
        "temperature": 90
      },
      {
        "order": 4,
        "instruction": "Zdjąć z ognia, wmieszać partiami zimne masło (monter au beurre) i doprawić solą.",
        "time": 2,
        "temperature": null
      }
    ],
    "summary": "Klasyczny francuski sos pieprzowy na bazie koniaku, zredukowanego demi-glace i śmietanki, montowany zimnym masłem.",
    "searchKeywords": ["sos pieprzowy", "zielony pieprz", "do steka", "demi glace"],
    "pairings": ["stek z polędwicy", "antrykot", "pieczona wołowina"],
    "difficulty": 2,
    "usage": "adapt",
    "chefNotes": "Masło musi być lodowate, a patelnia zdjęta z ognia, aby sos nie rozwarstwił się.",
    "provenance": {
      "sourceUrl": "https://przyklad.pl/sos-pieprzowy",
      "extractionConfidence": "high"
    }
  }
]
```

### Zasady wypełniania pól:
1. **`id`**: `<kategoria>--<slug-nazwy>` (małe litery, bez polskich znaków, myślniki zamiast spacji).
2. **`type`**: 
   - `"dish"` — pełne, serwowane danie.
   - `"component"` — baza, sos, purée, wywar, dodatek, półprodukt.
3. **`ingredients`**:
   - `name`: Czysta nazwa składnika w języku polskim w MIANOWNIKU (np. `"masło"`, `"czosnek"`, `"mąka pszenna"`).
   - `quantity`: Wartość liczbowa (`float`/`int`) lub `null` (jeśli „do smaku”).
   - `unit`: Jednostka metryczna (`"g"`, `"ml"`, `"kg"`, `"l"`, `"szt"`, `"ząbek"`, `"łyżka"`, `"łyżeczka"` lub `null`).
   - `notes`: Opis obróbki wstępnej (`"posiekany"`, `"zimne"`, `"w kostkę"`) lub `null`.
4. **`usage`**:
   - `"adapt"` — domyślne (pozwala chefowi adaptować proporcje).
   - `"locked"` — chroniona receptura bazowa.

---

## 4. Prompt Systemowy dla Agenta Pobierającego Przepisy

Wklej poniższy prompt jako instrukcję dla swojego agenta zbierającego dane:

```markdown
Jesteś profesjonalnym Agentem Kulinarnym (Culinary Ingestion & Recipe Structuring Specialist).
Twoim zadaniem jest pobieranie przepisów kulinarnych z internetu (lub przetwarzanie podanego tekstu/artykułu/strony WWW) i przekształcanie ich w precyzyjny, znormalizowany format JSON dla systemu gastronomicznego Mastra ChefAgent.

Twoje wyjście musi być ZAWSZE czystym kodem JSON (tablicą obiektów Recipe[] w języku polskim).

ZASADY:
1. Zawsze tłumacz i normalizuj nazwy składników oraz kroki na język POLSKI.
2. Zachowaj dokładne proporcje w jednostkach metrycznych (g, ml, kg, l, szt, łyżka, łyżeczka).
3. W polu ingredients.name podawaj wyłącznie czystą nazwę składnika w mianowniku (np. "czosnek", a nie "2 ząbki posiekanego czosnku").
4. Przypisz poprawny slug kategorii (dania-glowne, bazy-polprodukty, zupy, przystawki, desery, wypieki-slodkie, sosy-cieple, sosy-zimne, salatki, fermenty-pikle, wywary-buliony, napoje, dodatki-garnitury, dressingi-winegrety, dania-jednogarnkowe).
5. Oznacz type jako "component" dla baz/sosów/półproduktów lub "dish" dla pełnych dań.
```

---

## 5. Instrukcja Krok-po-Kroku: Wdrożenie Nowych Przepisów do Systemu

Gdy masz już przygotowane nowe pliki JSON:

### Krok 1: Umieszczenie w katalogu
Umieść pliki lub doklej obiekty JSON w:
`/projekty/mastra-agentic-environment/agentic-agents/storage/recipes/recipes-structured/`

### Krok 2: Uruchomienie pipeline'u
Przejdź do katalogu `agentic-agents` i wykonaj po kolei 3 polecenia:

```bash
cd /projekty/mastra-agentic-environment/agentic-agents

# 1. Indeksowanie wektorowe bge-m3 i zapis do bazy MongoDB (chef_recipe_library)
npm run embed:recipe-library

# 2. Dopasowanie nowych składników do cząsteczek FlavorDB (chef_flavor_aliases)
npm run build:flavor-aliases

# 3. Wzbogacenie przepisów o profile zapachowe i cząsteczki PubChem (flavorProfileFdb)
npm run enrich:recipe-flavor
```

### Krok 3: Weryfikacja
Możesz sprawdzić poprawność działania indeksu poleceniem:
```bash
npm run eval:recipe-retrieval
```

Od tego momentu `chefAgent` automatycznie korzysta z nowych przepisów, ich proporcji oraz danych sensorycznych przy generowaniu menu i kart technologicznych dań.
