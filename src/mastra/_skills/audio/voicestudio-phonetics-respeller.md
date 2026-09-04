---
name: voicestudio-phonetics-respeller
description: "Use when ensuring correct phonetic pronunciation and respelling for VoiceStudio/OmniVoice in Polish and English text, converting acronyms, technical loanwords, numbers, dates, and names into [[term|replacement]] syntax."
category: audio
keywords:
  - phonetics
  - respelling
  - pronunciation
  - voicestudio
  - acronyms
  - polish-phonetics
  - tts-tuning
  - lexicon
  - numbers-pronunciation
minComplexity: moderate
recommendedTier: balanced
preferLocal: true
estimatedTokens: 1100
outputFormat: text
tags:
  - audio
  - phonetics
  - voicestudio
  - polish
  - english
version: 1
---

# Procedure: VoiceStudio Phonetics & Respeller (PL & EN)

Use this procedure to eliminate synthetic mispronunciations in **VoiceStudio** (`k2-fsa/OmniVoice`).

Neural TTS engines fail on English loanwords in Polish prose, technical acronyms, irregular English homographs, and inflected Polish numerals/dates. This procedure enforces the canonical VoiceStudio inline respelling syntax:

```text
[[oryginalny_wyraz|zapis_fonetyczny]]
```

---

## 1. How VoiceStudio Resolves Pronunciation

In VoiceStudio's backend (`services/pronunciation.py`), the inline regex:
```python
_INLINE_RE = re.compile(r"\[\[([^\]]{0,256})\]\]")
```
splits on the pipe `|`:
1. The text before `|` is preserved for human readability and manuscript fidelity.
2. The text after `|` is substituted immediately prior to neural grapheme-to-phoneme encoding.
3. The audio output renders the phonetic string, while the source text remains clean.

---

## 2. Polish Technical & Acronym Respelling Dictionary

When writing or editing scripts in Polish (`deliverableLanguage = "pl"`), apply these canonical respellings:

### A. Core Tech Acronyms
| Term | VoiceStudio Inline Syntax | Phonetic Explanation |
| :--- | :--- | :--- |
| **AI** | `[[AI|ej-aj]]` | Unika czytania jako "aji" lub "a-i" |
| **API** | `[[API|ej-pi-aj]]` | Czytane po angielsku litera po literze |
| **LLM** | `[[LLM|el-el-em]]` | Poprawne polskie głoski akronimu |
| **GPU** | `[[GPU|gie-pe-u]]` | Polski akronim sprzętowy |
| **CPU** | `[[CPU|ce-pe-u]]` | Polski akronim procesora |
| **UI** | `[[UI|ju-aj]]` | Unika błędnego "uj" |
| **UX** | `[[UX|ju-iks]]` | Angielski akronim User Experience |
| **SaaS** | `[[SaaS|sas]]` | Płynna wymowa fonetyczna |
| **B2B** | `[[B2B|bi-tu-bi]]` | Angielski akronim biznesowy |
| **B2C** | `[[B2C|bi-tu-si]]` | Angielski akronim konsumencki |
| **CEO** | `[[CEO|si-i-o]]` | Angielski tytuł zarządczy |
| **CTO** | `[[CTO|si-ti-o]]` | Angielski tytuł techniczny |
| **SDK** | `[[SDK|es-de-ka]]` | Standardowa wymowa akronimu |
| **IDE** | `[[IDE|i-de-e]]` | Środowisko programistyczne |
| **CLI** | `[[CLI|ce-el-i]]` | Wiersz poleceń |
| **SQL** | `[[SQL|si-kłel]]` | Standard branżowy (lub `[[SQL|es-kju-el]]`) |
| **JSON** | `[[JSON|dżejson]]` | Płynna wymowa formatu danych |
| **REST** | `[[REST|rest]]` | Architektura API |

### B. Brands, Frameworks & Tools
| Term | VoiceStudio Inline Syntax |
| :--- | :--- |
| **Python** | `[[Python|pajton]]` |
| **Docker** | `[[Docker|doker]]` |
| **Node.js** | `[[Node.js|nołd-dżejes]]` |
| **JavaScript** | `[[JavaScript|dżawa-skript]]` |
| **TypeScript** | `[[TypeScript|tajp-skript]]` |
| **PostgreSQL** | `[[PostgreSQL|post-gres-kju-el]]` |
| **GitHub** | `[[GitHub|git-hab]]` |
| **Google** | `[[Google|gugl]]` |
| **OpenAI** | `[[OpenAI|ołpen-ej-aj]]` |
| **Claude** | `[[Claude|klod]]` |
| **Gemini** | `[[Gemini|dżeminaj]]` |
| **Mastra** | `[[Mastra|mastra]]` |
| **VoiceStudio** | `[[VoiceStudio|wojs-stjudjo]]` |
| **OmniVoice** | `[[OmniVoice|omni-wojs]]` |

### C. Common English Loanwords in Polish Prose
| Term | VoiceStudio Inline Syntax |
| :--- | :--- |
| **workflow** | `[[workflow|łorkfloł]]` |
| **pipeline** | `[[pipeline|pajplajn]]` |
| **feedback** | `[[feedback|fidbek]]` |
| **lead / leady** | `[[lead|lid]]` / `[[leady|lidy]]` |
| **deadline** | `[[deadline|dedlajn]]` |
| **frontend** | `[[frontend|frontend]]` |
| **backend** | `[[backend|bekend]]` |
| **cloud** | `[[cloud|klaud]]` |

---

## 3. Polish Grammatical Inflection & Numeral Protection

Polish neural TTS models frequently default to the nominative case (*mianownik*) when reading digits or abbreviations, causing glaring grammatical errors.

1. **Years and Centuries:**
   - Instead of: *"w 2026 roku"* (TTS may read: *"w dwa tysiące dwadzieścia sześć roku"* - ERROR)
   - Force inflection: *"w [[2026|dwa tysiące dwudziestym szóstym]] roku"*
   - Instead of: *"w XXI wieku"*
   - Force inflection: *"w [[XXI|dwudziestym pierwszym]] wieku"*
2. **Ordinal Numbers:**
   - Instead of: *"w 1. rozdziale"*
   - Force inflection: *"w [[1.|pierwszym]] rozdziale"*
3. **Percentages and Measurements:**
   - *"50%"* $ightarrow$ `[[50%|pięćdziesiąt procent]]`
   - *"150 ms"* $ightarrow$ `[[150 ms|sto pięćdziesiąt milisekund]]`
   - *"10 GB"* $ightarrow$ `[[10 GB|dziesięć gigabajtów]]`
4. **Abbreviations:**
   - `m.in.` $ightarrow$ `[[m.in.|między innymi]]`
   - `np.` $ightarrow$ `[[np.|na przykład]]`
   - `tzn.` $ightarrow$ `[[tzn.|to znaczy]]`
   - `itd.` $ightarrow$ `[[itd.|i tak dalej]]`
   - `godz.` $ightarrow$ `[[godz.|godzina]]`

---

## 4. English Pronunciation & Homographs Rules

When generating scripts in English (`deliverableLanguage = "en"`):

1. **Heteronyms (Spelled the same, pronounced differently):**
   - *Lead:* `[[lead|leed]]` (to guide) vs `[[lead|led]]` (metal / past)
   - *Read:* `[[read|reed]]` (present) vs `[[read|red]]` (past)
   - *Live:* `[[live|lyve]]` (broadcast) vs `[[live|liv]]` (exist)
   - *Wind:* `[[wind|wynd]]` (turn clock) vs `[[wind|wihnd]]` (breeze)
2. **English Acronyms:**
   - `[[API|A-P-I]]`
   - `[[SQL|sequel]]`
   - `[[SaaS|sass]]`
3. **Polish Names in English Audio:**
   - `[[Patryk|Pah-trick]]`
   - `[[Warszawa|Var-shah-vah]]`
   - `[[Kraków|Krah-koov]]`
   - `[[Łódź|Woodzh]]`
