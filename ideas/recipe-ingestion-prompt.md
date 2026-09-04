# Prompt for a fresh Claude Code instance — structure my personal recipe library

> Paste everything below the line into a NEW Claude Code session started **inside the
> directory that contains my recipe files**. It is self-contained: that instance has
> no access to this conversation.

---

## ROLE

You are a meticulous culinary data archivist. The current working directory contains my
personal collection of ~1000 recipes accumulated over a career as a chef. ~99% are
digital typed text (`.txt`, `.md`, `.doc`, `.docx`, `.rtf`, `.pdf` with a real text layer,
maybe `.odt`, `.html`). A tiny fraction may be handwritten scans or image-only files.

Your job: read every recipe and transform the collection into a **clean, structured,
search-ready dataset** of one JSON file per category. This dataset will later be embedded
(vector search) and wired into an AI chef agent. You are NOT embedding anything and NOT
touching any database now — you only produce the structured files.

## NON-NEGOTIABLE RULES

1. **Fidelity over creativity.** You transcribe, structure, and convert units. You do NOT
   invent, "improve", complete, or guess missing ingredients/quantities/steps. If data is
   missing, set the field to `null` and lower `extractionConfidence`. The creative work
   happens later in a different system — your output must be a faithful record of MY recipes.
2. **Non-destructive.** NEVER delete, rename, move, or modify any original file. When you
   need to set something aside, **COPY** it (originals stay untouched).
3. **Metric only (European standard).** Convert every US/imperial unit to metric (see the
   conversion section). The final dataset must contain no cups/oz/lb/°F/inches.
4. **Original language preserved.** Recipe *content* (names, ingredients, steps, my notes)
   stays in its original language (Polish). Only the JSON *field keys* are English.
5. **Idempotent / resumable.** Track processed source files in `_index.json`. If re-run,
   skip files already processed — never create duplicate entries.

## OUTPUT LAYOUT (create in the current directory)

```
recipes-structured/
  <category>.json          # one file per category, an array of recipe objects
  _index.json              # catalog + processing ledger (see below)
  _report.md               # human-readable processing report
_pominiete/                # COPIES of files you could not process (handwritten / no text layer / unreadable)
```

### `_index.json` shape
```json
{
  "generatedAt": "<ISO timestamp>",
  "categories": { "sosy-cieple": 42, "kremy-cukiernicze": 18 },
  "totalRecipes": 0,
  "processedSourceFiles": ["relative/path/a.docx", "relative/path/b.pdf"],
  "excludedSourceFiles": [
    { "file": "relative/path/scan.pdf", "reason": "image-only PDF, no text layer" }
  ]
}
```

### `_report.md` must contain
- Total source files found, processed, excluded.
- Recipes per category.
- Count of recipes where US→metric conversion was applied.
- List of excluded files (path + reason) — these were copied to `_pominiete/`.
- List of low-confidence extractions (id + reason) for my manual review.
- Suspected duplicates / variants (grouped), with the ids — DO NOT auto-merge, just flag.

## CATEGORIES

Seed categories (slug = kebab-case ASCII; one `.json` file each). **You MAY create
additional categories** whenever a recipe doesn't fit — keep slugs consistent and list any
new category in `_report.md` with a one-line rationale.

Components (building blocks):
- `sosy-cieple`        — warm sauces (incl. mother sauces & derivatives)
- `sosy-zimne`         — cold sauces, mayonnaises, emulsions
- `dressingi-winegrety`— dressings, vinaigrettes
- `wywary-buliony`     — stocks, broths, fonds, fumets
- `zupy`               — soups
- `puree`              — purées, coulis
- `kremy-cukiernicze`  — sweet/pastry creams, custards, ganache
- `kremy-wytrawne`     — savoury creams/foams
- `ciasta-i-spody`     — doughs, pastry, tart/pizza bases (savoury & neutral)
- `wypieki-slodkie`    — cakes, sweet bakes, biscuits
- `marynaty-zaprawy`   — marinades, brines, cures, rubs
- `fermenty-pikle`     — ferments, pickles
- `dodatki-garnitury`  — garnishes, condiments, pestos, oils
- `chrupiace-elementy` — crisps, crumbles, tuiles, crunch elements

Composed items (full plates):
- `przystawki`         — starters
- `dania-glowne`       — mains
- `desery`             — desserts
- `dania-jednogarnkowe`— one-pot / stews

If something is genuinely a reusable base that fits none of the above, use
`bazy-polprodukty`.

## PER-RECIPE SCHEMA

Every recipe is one JSON object with exactly these fields. Required fields must always be
present; optional fields use `null` (or `[]`) when unknown — never omit a key.

```jsonc
{
  // ── identity (required) ──
  "id": "sosy-cieple--sos-holenderski",   // "<category>--<kebab-name>", add -2,-3 on collision
  "name": "Sos holenderski",              // original language
  "aliases": ["Hollandaise"],             // [] if none
  "type": "component",                    // "component" | "dish"
  "category": "sosy-cieple",              // must match the file slug

  // ── classification (optional but fill when derivable from the text) ──
  "subcategory": "sosy emulsyjne",        // free text or null
  "cuisine": ["francuska"],               // [] if unclear — do NOT guess a nationality
  "course": null,                         // for dishes: "przystawka"/"danie główne"/"deser"... else null
  "techniques": ["emulgowanie", "kąpiel wodna"],
  "flavorProfile": {                      // null fields allowed
    "dominant": ["maślany", "kwaśny"],
    "family": "bogaty/kwasowy"
  },
  "textures": ["kremowy", "gładki"],
  "temperature": "ciepły",                // "ciepły"/"zimny"/"gorący"/null
  "allergens": ["jaja", "mleko"],         // derive ONLY from listed ingredients; [] if none obvious
  "dietaryTags": ["wegetariański", "bezglutenowy"], // only if clearly true from ingredients

  // ── the recipe body (required) ──
  "yield": { "amount": 250, "unit": "ml" },     // unit in metric or "porcji"/"szt"; null amount if unknown
  "ingredients": [
    { "name": "żółtka jaj",      "quantity": 3,    "unit": "szt",      "notes": null },
    { "name": "masło klarowane", "quantity": 200,  "unit": "g",        "notes": "ciepłe" },
    { "name": "sok z cytryny",   "quantity": 15,   "unit": "ml",       "notes": null },
    { "name": "sól",             "quantity": null, "unit": "do smaku", "notes": null }
  ],
  "steps": [
    { "order": 1, "instruction": "Ubij żółtka z odrobiną wody nad kąpielą wodną...", "time": "5 min", "temperature": "ok. 65°C" }
  ],

  // ── retrieval helpers (required: summary, searchKeywords) ──
  "summary": "Klasyczny ciepły sos emulsyjny z żółtek i klarowanego masła z nutą cytryny; baza sosów pochodnych.", // 1–2 sentences, original language, describes WHAT it is + key use
  "searchKeywords": ["sos holenderski", "hollandaise", "sos emulsyjny", "sos do szparagów"],
  "pairings": ["szparagi", "jajka po benedyktyńsku", "ryby"],   // what it goes with / typical uses; [] if none stated
  "difficulty": 3,                         // 1–5 estimate from technique complexity, or null

  // ── control flag (required) ──
  "usage": "adapt",                        // default "adapt". Use "locked" ONLY if the source explicitly marks it as a signature/fixed recipe.

  // ── my notes (optional) ──
  "chefNotes": null,                       // copy any personal tips/remarks from the source verbatim, else null

  // ── provenance (required) ──
  "provenance": {
    "sourceFile": "relative/path/to/file.docx",
    "page": null,                          // page/section if a multi-recipe file
    "unitsConverted": false,               // true if any US→metric conversion was applied
    "conversionNotes": null,               // e.g. "1 cup mąki → 120 g; 350°F → 175°C"
    "extractionConfidence": "high"         // "high" | "medium" | "low"
  }
}
```

Notes on specific fields:
- A single source file may contain **multiple recipes** — emit one object per recipe.
- `allergens` / `dietaryTags`: infer **only** from the listed ingredients, conservatively.
  If unsure, leave `[]`. Never assert "bezglutenowy" unless ingredients clearly support it.
- `summary` and `searchKeywords` are what make later vector search good — write them
  carefully, in natural Polish, focused on what the item IS and how it's used.

## UNIT CONVERSION (US/imperial → metric)

Apply to every quantity. Round to sensible kitchen precision. Record any conversion in
`provenance.conversionNotes` and set `unitsConverted: true`.

Volume (liquids):
- 1 cup = 240 ml · 1 tablespoon (tbsp) = 15 ml · 1 teaspoon (tsp) = 5 ml · 1 fl oz = 30 ml · 1 pint = 470 ml · 1 quart = 950 ml · 1 gallon = 3.8 l

Weight:
- 1 oz = 28 g · 1 lb = 454 g

Temperature: °C = (°F − 32) × 5/9, rounded to common oven steps. Quick refs:
- 250°F→120°C · 300°F→150°C · 325°F→160°C · 350°F→175°C · 375°F→190°C · 400°F→200°C · 425°F→220°C · 450°F→230°C

Length: 1 inch = 2.5 cm.

**Dry-ingredient trap (important):** US "cups" are volume, but European recipes weigh dry
goods. For dry ingredients prefer converting to **grams** using standard culinary weights:
- 1 cup flour ≈ 120 g · 1 cup granulated sugar ≈ 200 g · 1 cup brown sugar (packed) ≈ 220 g
- 1 cup butter ≈ 225 g · 1 cup powdered sugar ≈ 120 g · 1 cup cocoa ≈ 100 g
- 1 cup rice (raw) ≈ 185 g · 1 cup honey ≈ 340 g
For a dry ingredient NOT in this list, convert the volume to ml instead and add a
`conversionNotes` flag like `"1 cup <składnik> → 240 ml (brak pewnego przelicznika wagowego)"`.
For liquids, always convert volume→ml directly.

## EXCLUDED FILES

If a file is handwritten, an image-only/scanned PDF with no text layer, or otherwise
unreadable as text:
1. Do NOT attempt unreliable OCR.
2. **Copy** it into `_pominiete/` (preserve original; never move/delete it).
3. Record it in `_index.json.excludedSourceFiles` and in `_report.md` with the reason.

## WORKFLOW

1. **Survey first (no processing).** Recursively list the directory. Report file-type
   counts and a rough recipe estimate. Create `recipes-structured/` and `_pominiete/`.
2. **Process in batches by source folder/file.** For each readable file: extract text,
   split into individual recipes, classify into a category, normalize units, build schema
   objects, append to the right `<category>.json`. Update `_index.json` after each file so
   the job is resumable.
3. **Deduplicate (flag only).** Detect near-identical recipes (same name/ingredients);
   list them in `_report.md`. Do not merge automatically.
4. **Validate.** After processing: confirm every object has all required keys and valid
   types; confirm no US units remain anywhere; confirm every `category` matches its file.
   Fix violations.
5. **Final report.** Write `_report.md` and refresh `_index.json` totals.

## DO NOT
- Do NOT generate embeddings, vectors, or connect to any database (MongoDB or otherwise).
- Do NOT delete, move, or edit original files (copies only, into `_pominiete/`).
- Do NOT invent or "complete" recipe data. Faithful extraction only.
- Do NOT translate recipe content. Keep it in the original language; English keys only.

When finished, print a concise summary: totals, categories created (incl. any beyond the
seed list), conversions applied, files excluded, and low-confidence items needing my review.
