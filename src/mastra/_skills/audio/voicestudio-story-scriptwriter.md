---
name: voicestudio-story-scriptwriter
description: "Use when creating multi-character audio plays, radio dramas, dialogues, or story scripts formatted for VoiceStudio's Stories module and Autocast engine."
category: audio
keywords:
  - stories
  - voicestudio
  - autocast
  - screenplay
  - dialogue
  - audio-drama
  - multi-character
  - speech-script
minComplexity: moderate
recommendedTier: balanced
preferLocal: true
estimatedTokens: 900
outputFormat: text
tags:
  - audio
  - voicestudio
  - stories
  - scriptwriter
version: 1
---

# Procedure: VoiceStudio Story Scriptwriter (Stories & Autocast)

Use this procedure when generating multi-voice audio plays, podcast sketches, narrative dialogues, or drama scripts intended for the **VoiceStudio Stories Editor** (`/stories`).

Scripts formatted with this procedure are ready for immediate pasting into **"Paste & Split"** and 1-click **"Autocast"** track generation.

---

## 1. Stories Architecture & Autocast Invariants

1. **Stories Canvas Model:** Multi-track timeline where each spoken segment is a block assigned to a specific character voice profile.
2. **Autocast Grammar Rule (Critical for Polish):**
   - The VoiceStudio frontend parser (`Fe()`) supports three formats:
     - **Bracketed Speaker Tag:** `[Postać] Tekst kwestii...`
     - **Screenplay Colon Format:** `Postać: Tekst kwestii...`
     - **Quoted Prose:** `"Tekst dialogu," said Speaker.` (uses English-only regex verbs).
   - **MANDATORY INVARIANT FOR POLISH SCRIPTS:** Never format Polish dialogues using quoted prose (`"..." powiedział Patryk`), because VoiceStudio's verb regex will **fail** to detect Polish attribution verbs and will dump the entire line onto the Narrator track!
   - **STANDARD:** Always use `[Postać]` or `Postać:` at the start of each line/block. This ensures 100% deterministic speaker splitting in both Polish and English.

---

## 2. Structural Syntax for Stories

### A. Scene & Chapter Separation
Use H1 headers to delineate scenes, acts, or story chapters:
```text
# Akt I — W pracowni
```

### B. Speaker Assignment (Bracketed Standard)
Start each dialogue turn with the character name in square brackets:
```text
[Narrator] Noc była cicha, a w pracowni słychać było jedynie szum komputera. [pause 500ms]
[Patryk] Czy sprawdziłeś nowe wagi modelu?
[Vero] [fast]Tak, wszystko gotowe do wdrożenia![/fast]
```

### C. Multi-Line Blocks
When a character has a longer monologue across multiple paragraphs, you may either keep the speaker tag on each paragraph or let consecutive lines follow:
```text
[Patryk]
Pierwszy moduł jest już skompilowany. [pause 400ms]
Teraz musimy sprawdzić czasy odpowiedzi silnika.
```

---

## 3. Dialogue Expressiveness & Nonverbal Nuances

In radio dramas and multi-character stories, acting nuances make the dialogue authentic:

1. **Natural Breath & Reaction Beats:**
   - Place nonverbal tokens (`[laughter]`, `[sigh]`, `[surprise-ah]`, `[dissatisfaction-hm]`) at natural conversational junctures.
   - Example:
     ```text
     [Vero] [laughter] Nie ma szans, żeby to zadziałało za pierwszym razem.
     [Patryk] [dissatisfaction-hm] [pause 300ms] A jednak logi pokazują zero błędów.
     ```
2. **Conversational Micro-Pauses:**
   - Inter-dialogue beat (listening / reacting): `[pause 300ms]` or `[pause 500ms]`.
   - Hesitation before confession or answer: `[pause 700ms]`.
   - Interruptions or rushed replies: use `[fast]...[/fast]` without trailing pause.
3. **Emphasis & Whisper/Slow:**
   - Emphasized keywords: `[emphasis]dokładnie tak[/emphasis]`.
   - Intimate or grave lines: `[slow]Nigdy więcej tego nie powtarzaj.[/slow]`.

---

## 4. Phonetics Integration
Every technical term, English acronym, or foreign brand name must be wrapped in `[[pojęcie|fonetyka]]` (e.g. `[[AI|ej-aj]]`, `[[Docker|doker]]`). See `voicestudio-phonetics-respeller`.

---

## 5. Canonical Stories Template (Zero-Touch Paste & Split)

```text
# Scena 1 — Nocna Wymiana

[Narrator] Zegar na ścianie wybił trzecią nad ranem. [pause 600ms] Chłodne światło monitora oświetlało zmęczone twarze programistów.

[Patryk] [slow]Jeśli ten [[kontener|kontener]] teraz się wyłoży, cała migracja przepadnie.[/slow] [pause 400ms]

[Vero] Spokojnie. [pause 300ms] Sprawdziłam konfigurację [[Docker|dokera]] trzy razy. [fast]Wszystkie porty i wolumeny są podpięte prawidłowo.[/fast]

[Patryk] [sigh] [pause 500ms] Dobrze. Odpalam ostatni test dla modelu [[AI|ej-aj]].

[Narrator] W pokoju zapadła głęboka cisza. [pause 800ms] Jedynym dźwiękiem było miarowe stukanie klawiszy.

[Vero] [surprise-ah] [pause 200ms] Patryk, spójrz! Zwróciło kod dwieście!

[Patryk] [laughter] [emphasis]Mamy to![/emphasis] [pause 300ms] Idziemy na kawę.
```

---

## 6. Long-Form Processing Strategy (Chunking & Checkpoints)

Dla materiałów źródłowych powyżej 1500 słów / 8 KB:
1. **Nie generuj całego skryptu w jednym kroku:** Monolityczna generacja wieloaktowych historii i długich rozdziałów prowadzi do przekroczenia limitów czasu (harness timeout) i utraty postępu.
2. **Podziel na logiczne sceny / segmenty:** np. 3–4 sceny po ~700–1000 słów każda.
3. **Przetwarzaj i formatuj segmenty sekwencyjnie:** Dbaj o poprawne formatowanie `[Postać]` oraz fonetyczny respelling segment po segmencie.
4. **Po każdym segmencie utwórz punkt kontrolny:** Zapisz cząstkowy plik na dysku lub wywołaj `artifact_put` przed przejściem do kolejnego segmentu.
5. **Syntezę audio w VoiceStudio wykonuj dla wygenerowanych segmentów lub batchowo.**

