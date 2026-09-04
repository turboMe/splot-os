---
name: voicestudio-audiobook-formatter
description: "Use when formatting books, long articles, essays, or chapters into paste-ready scripts for the VoiceStudio Audiobook module (Markdown H1, multi-voice casting [voice:X], pauses, SSML-lite prosody, and OmniVoice nonverbal reactions)."
category: audio
keywords:
  - audiobook
  - voicestudio
  - omnivoice
  - narration
  - speech-synthesis
  - voice-casting
  - prosody
  - pauses
  - audio-formatting
minComplexity: moderate
recommendedTier: balanced
preferLocal: true
estimatedTokens: 950
outputFormat: text
tags:
  - audio
  - voicestudio
  - audiobook
  - writer
version: 1
---

# Procedure: VoiceStudio Audiobook Formatter

Use this procedure when producing or converting manuscripts, longform articles, non-fiction chapters, or narrative fiction into **VoiceStudio Audiobook** scripts. The output must be 100% paste-ready into VoiceStudio's Audiobook tab or savable as `.md` / `.txt` for 1-click import.

---

## 1. Core Architecture & VoiceStudio Engine Invariants

1. **Active Engine:** `k2-fsa/OmniVoice` (multilingual zero-shot neural TTS).
2. **Audiobook Input Canvas:** Single continuous Markdown script.
3. **Chapter Segmentation Invariant:**
   - Exclusively top-level H1 headings demarcate chapters:
     ```markdown
     # Rozdział 1 — Przebudzenie
     ```
   - Subheadings (`##`, `###`) **do not** split chapters; they are spoken aloud as body text.
   - At the beginning of every `# Chapter`, the voice engine automatically resets to `default_voice` unless overridden by an explicit voice tag.

---

## 2. Multi-Voice Casting Grammar (`[voice:NAME]`)

VoiceStudio parses `[voice:NAME]` tags dynamically and populates the **Cast** list in the right-hand panel of the UI, allowing instant 1-click binding to cloned profiles (np. `patryk-polish-voice` [PL: eab289ea], `patryk-english-voice` [EN: c310508f]).

- **Speaker Tag Syntax:** `[voice:CharacterName]` at the start of a paragraph or inline before dialogue.
- **Narrator Designation:** Use `[voice:Narrator]` for third-person or non-dialogue narration.
- **Reset Tag:** Use `[voice:default]` to return to the project-level default voice.
- **Character Naming Convention:** Use clean alphanumeric identifiers matching cast roles: e.g. `[voice:Narrator]`, `[voice:Patryk]`. Avoid punctuation inside the voice name tag.

---

## 3. Pacing, Breathing, and Micro-Pauses

The neural engine uses pause tags to control cadence, dramatic silence, and paragraph transitions:

1. **Standard Pause Tag:**
   - `[pause]` -> Default duration: 350 ms.
   - `[pause <duration>]` -> Specify explicit time in `ms` or `s`:
     - Micro-pause (comma breath / hesitation): `[pause 250ms]` or `[pause 300ms]`
     - Mid-pause (sentence end / transition): `[pause 500ms]` or `[pause 600ms]`
     - Major pause (scene break / dramatic beat): `[pause 800ms]` or `[pause 1.2s]`
     - Chapter conclusion: `[pause 1.5s]`
2. **Interpunction Cues:**
   - Em-dash (`—`) followed by `[pause 400ms]` produces natural dramatic suspension.
   - Ellipsis (`...`) naturally pitches the voice downward into a quiet fade.

---

## 4. Prosody & Expressive Styling (SSML-Lite)

Wrap phrases or sentences in SSML-Lite tags to alter speed and delivery:

- `[slow]...[/slow]` -> Decelerates delivery (~0.85x speed). Ideal for tension, contemplation, technical explanation, solemnity.
- `[fast]...[/fast]` -> Accelerates delivery (~1.15x speed). Ideal for panic, urgency, rushed speech, excitement.
- `[emphasis]...[/emphasis]` -> Mildly decelerates (~0.92x) and applies emphasis weight to highlight key phrases.
- `[spell]...[/spell]` -> Spells out uppercase abbreviations character-by-character (e.g. `[spell]KESTREL[/spell]` -> "K E S T R E L").

---

## 5. OmniVoice Nonverbal Reactions (Audio Tokens)

The `k2-fsa/OmniVoice` engine has native audio tokenizers for non-speech vocalizations. Insert them as standalone tokens:

- `[laughter]` -> Natural human laughter / chuckle.
- `[sigh]` -> Audible breath / deep sigh.
- `[confirmation-en]` -> Affirmative vocalization ("mhm", "uh-huh").
- `[question-en]`, `[question-ah]`, `[question-oh]` -> Querying / questioning vocal inflection.
- `[surprise-ah]`, `[surprise-oh]`, `[surprise-wa]` -> Sudden surprise or gasp.
- `[dissatisfaction-hm]` -> Skeptical hum or grunt of discontent.

*Rule:* Place reaction tokens adjacent to dialogue where an actor naturally vocalizes before or after speaking:
```markdown
[voice:Vero] [laughter] [fast]Nie wierzę, że to złożyłeś w jeden wieczór![/fast]
[voice:Patryk] [sigh] [pause 400ms] Ja też nie, ale logi są czyste.
```

---

## 6. Phonetic Respelling Integration

For all acronyms, foreign terminology, technical terms, or numerals, apply the inline respelling syntax:
`[[pojęcie|zapis_fonetyczny]]` (see skill `voicestudio-phonetics-respeller` for exhaustive rules).
- Polish: `[[AI|ej-aj]]`, `[[workflow|łorkfloł]]`, `[[2026|dwa tysiące dwudziestym szóstym]]`
- English: `[[SQL|sequel]]`, `[[API|A-P-I]]`

---

## 7. Canonical Audiobook Template (Zero-Touch)

```markdown
# Rozdział 1 — Przełom

[voice:Narrator] W cichym biurze słychać było jedynie cichy szum wentylatorów stacji roboczej. [pause 700ms] Zegar wskazywał drugą w nocy. [slow]Patryk obserwował wskaźniki obciążenia pamięci, czekając na wynik ostatniego testu [[AI|ej-aj]].[/slow] [pause 500ms] Na ekranie pojawił się zielony komunikat.

[voice:Patryk] [emphasis]Mamy to.[/emphasis] [pause 400ms] Vero, spójrz na czas generacji dla modelu [[OmniVoice|omni-wojs]].

[voice:Vero] [laughter] [fast]Wreszcie poniżej trzystu milisekund![/fast] [pause 300ms] To oznacza, że cały nasz [[pipeline|pajplajn]] może działać lokalnie bez żadnych zewnętrznych opóźnień.

[voice:Narrator] Patryk oparł się na fotelu. [sigh] [pause 600ms] Przez ostatnie tygodnie każdy błąd wydawał się krytyczny, ale teraz architektura była kompletna.

# Rozdział 2 — Nowy Standard

[voice:Narrator] Następnego ranka rozpoczęły się pierwsze testy pełnego formatowania długich książek.
```

---

## 8. Long-Form Processing Strategy (Chunking & Checkpoints)

Dla materiałów źródłowych powyżej 1500 słów / 8 KB:
1. **Nie generuj całego skryptu w jednym kroku:** Monolityczna generacja długich rozdziałów prowadzi do przekroczenia limitów czasu (harness timeout) i utraty postępu.
2. **Podziel rozdział na logiczne sceny / segmenty:** np. 3–4 sceny po ~700–1000 słów każda.
3. **Przetwarzaj i formatuj segmenty sekwencyjnie:** Nadawaj znaczniki tempa (`[slow]`), pauz (`[pause]`), kasting (`[voice:X]`) oraz fonetyczny respelling scenę po scenie.
4. **Po każdym segmencie utwórz punkt kontrolny:** Zapisz cząstkowy plik na dysku lub wywołaj `artifact_put` przed przejściem do następnego segmentu.
5. **Syntezę audio w VoiceStudio wykonuj dla wygenerowanych segmentów lub batchowo:** Renderuj poszczególne części lub scal zweryfikowane segmenty przed ostatecznym wywołaniem `voiceStudioRenderAudiobookTool`.

