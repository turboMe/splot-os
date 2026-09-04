# OmniVoice ↔ Meta Agent — plan implementacji komunikacji głosowej

Status: plan implementacyjny  
Tryb docelowy: local-first, język polski, push-to-talk  
Zakres MVP: głos użytkownika → STT → Meta Agent → pełny tekst + krótkie podsumowanie → TTS  
Główny agent: `metaAgent`  
Silnik audio: lokalny VoiceStudio/OmniVoice na `127.0.0.1:3900`

## 1. Cel

Zbudować lokalny kanał rozmowy głosowej z obecnym Meta Agentem, w którym:

1. użytkownik przytrzymuje skonfigurowany klawisz;
2. system nagrywa mikrofon do momentu zwolnienia klawisza;
3. OmniVoice zamienia polską mowę na tekst;
4. finalna transkrypcja trafia do Meta Agenta jako zwykła wiadomość użytkownika;
5. Meta Agent wykonuje normalne rozumowanie, narzędzia i delegację;
6. pełna odpowiedź pozostaje dostępna tekstowo;
7. TTS odczytuje wyłącznie krótkie, polskie podsumowanie;
8. ponowne naciśnięcie klawisza natychmiast zatrzymuje odtwarzanie TTS, ale nie anuluje wykonywanego zadania.

Rozwiązanie ma zachować wszystkie obecne możliwości Meta Agenta. Kanał głosowy nie może wymuszać skracania kanonicznej odpowiedzi ani zanieczyszczać pamięci dodatkową wiadomością z podsumowaniem.

## 2. Decyzja architektoniczna

Docelowy przepływ:

```text
globalny klawisz PTT
        │
        ▼
Native Voice Companion
(mikrofon, hotkey, status, playback, barge-in)
        │ PCM 16 kHz mono
        ▼
VoiceStudio /ws/transcribe
        │ final transcript
        ▼
POST /voice/v1/turn
        │
        ▼
executeMetaTurn()
Meta Agent + harness + pamięć
        │
        ├── displayText ──► UI / transcript / artefakty
        │
        ▼
SpeechSummaryProjector
        │ spokenText
        ▼
VoiceStudio /v1/audio/speech
        │
        ▼
lokalne odtwarzanie
```

Podział odpowiedzialności:

| Komponent | Odpowiedzialność |
|---|---|
| Voice Companion | globalny PTT, mikrofon, format audio, status, odtwarzanie, barge-in |
| VoiceStudio/OmniVoice | STT i TTS, bez logiki agenta |
| Voice Gateway w Mastrze | tożsamość, idempotencja, serializacja tur, kontrakt dual-output |
| Meta Agent | pełna odpowiedź, narzędzia, pamięć, delegacja i approvals |
| Speech Summary Projector | bezpieczna, krótka projekcja odpowiedzi do odczytania |
| Meta Front/dashboard | opcjonalny widok transkrypcji i statusów, poza krytyczną ścieżką MVP |

## 3. Decyzje wiążące

### 3.1. Meta Agent pozostaje jedynym mózgiem rozmowy

MVP nie kieruje wypowiedzi do `metaFrontAgent`. Obecny Meta Front ma ograniczony zestaw durable-job tools, prawie każde polecenie zamienia w job i nie udostępnia jeszcze kompletnego kanału wyników ani `spokenText`.

Nie należy kopiować narzędzi Meta Agenta do Meta Frontu. Zniszczyłoby to jego strukturalną gwarancję `front_only` i stworzyło dwa konkurencyjne orkiestratory.

### 3.2. Pełny tekst i tekst mówiony są osobnymi rezultatami

Każdy turn głosowy zwraca co najmniej:

```typescript
type VoiceTurnResult = {
  conversationId: string;
  utteranceId: string;
  runId: string;
  turnId: string;
  transcript: string;
  displayText: string;
  spokenText: string;
  shouldSpeak: boolean;
  speakKind: 'answer' | 'ack' | 'question' | 'warning' | 'done' | 'none';
  requiresUserAction: boolean;
  jobRefs: string[];
  artifactRefs: string[];
};
```

`displayText` jest kanoniczną odpowiedzią Meta Agenta. `spokenText` jest wtórną projekcją transportową i nie jest zapisywany jako kolejna wiadomość asystenta.

### 3.3. MVP używa `metaAgent.generate()`, nie `stream()`

Obecny wrapper Meta Agenta obejmuje pełnym harness-em tylko `generate()`. Pierwsza wersja voice endpointu musi używać tej samej ścieżki. Strumieniowanie można włączyć dopiero po wydzieleniu wspólnego kernela i uzyskaniu parity `generate/stream` dla timeoutów, fallbacków, artefaktów i telemetrii.

### 3.4. Audio nie trafia do Meta Agenta jako załącznik

Voice Companion wykonuje STT przed wywołaniem Meta. Do Mastry trafia wyłącznie finalna transkrypcja. Obecna obsługa załączników audio jedynie zapisuje plik i przekazuje agentowi marker ścieżki, dlatego nie jest odpowiednią ścieżką realtime.

### 3.5. MCP OmniVoice nie należy do ścieżki realtime

STT i TTS są wywoływane deterministycznie przez Voice Companion/Gateway przez WebSocket lub REST. MCP pozostaje opcjonalne dla zadań typu „transkrybuj plik” albo „wygeneruj nagranie”, ponieważ base64 i sterowanie transportem przez model zwiększają narzut oraz ryzyko.

## 4. Kontrakt wejściowy i wyjściowy

### 4.1. Endpoint

```http
POST /voice/v1/turn
Content-Type: application/json
X-Resource-Id: <lokalna-tożsamość-użytkownika>
```

Request:

```json
{
  "conversationId": "uuid",
  "utteranceId": "uuid",
  "transcript": "Sprawdź, czy ostatnie zadanie już się zakończyło",
  "locale": "pl-PL",
  "inputModality": "voice",
  "speech": {
    "enabled": true,
    "maxChars": 320
  }
}
```

Response:

```json
{
  "conversationId": "uuid",
  "utteranceId": "uuid",
  "runId": "uuid",
  "turnId": "uuid",
  "transcript": "Sprawdź, czy ostatnie zadanie już się zakończyło",
  "displayText": "Pełna odpowiedź Meta Agenta w Markdown...",
  "spokenText": "Ostatnie zadanie zakończyło się poprawnie. Pełny wynik jest dostępny w panelu.",
  "shouldSpeak": true,
  "speakKind": "done",
  "requiresUserAction": false,
  "jobRefs": [],
  "artifactRefs": []
}
```

### 4.2. Walidacja

- `conversationId`: wymagany UUID lub inny jednoznacznie walidowany identyfikator wątku;
- `utteranceId`: wymagany, unikalny dla jednej wypowiedzi;
- `transcript`: po `trim()`, niepusty, z ustalonym limitem długości;
- `locale`: w MVP wyłącznie `pl-PL`, z możliwością późniejszego rozszerzenia;
- `resourceId`: pochodzi z zaufanej lokalnej granicy HTTP, nie z promptu;
- brak tożsamości kończy się `401`, nigdy fallbackiem do wspólnego `meta-agent`;
- powtórzony `utteranceId` zwraca zapamiętany wynik bez ponownego uruchomienia narzędzi.

### 4.3. Kody odpowiedzi

| Kod | Znaczenie |
|---|---|
| `200` | turn wykonany albo zwrócony z idempotency cache |
| `400` | błędny lub pusty request |
| `401` | brak poprawnej tożsamości |
| `409` | konflikt turnu w tej samej rozmowie, którego nie można bezpiecznie scalić |
| `422` | transkrypcja nie przechodzi quality gate |
| `503` | Meta Agent albo Voice Gateway niedostępny |
| `504` | kontrolowany timeout turnu |

## 5. Polityka `spokenText`

### 5.1. Limit

- domyślnie 1–3 zdania;
- cel: 120–260 znaków;
- twardy limit MVP: 320 znaków;
- cel czasowy: około 8–18 sekund mowy;
- bez Markdownu, kodu, tabel, list, URL-i i surowych logów.

### 5.2. Co powinno zostać wypowiedziane

- ostateczny wynik albo najważniejsza decyzja;
- błąd, częściowe powodzenie lub blocker;
- pytanie wymagające odpowiedzi użytkownika;
- prośba o approval;
- krótka informacja, gdzie znajduje się pełny wynik;
- prawdziwy status uruchomionego długiego zadania.

### 5.3. Czego nie wolno odczytywać

- wewnętrznych śladów narzędzi i toku rozumowania;
- kodu i wielowierszowych danych;
- pełnych raportów i artefaktów;
- sekretów, tokenów, ścieżek zawierających dane wrażliwe;
- obietnicy późniejszego powiadomienia, jeżeli system nie posiada aktywnego kanału delivery;
- fałszywego sukcesu, jeżeli zadanie zostało tylko przyjęte.

### 5.4. Kolejność projekcji

1. Jeżeli odpowiedź jest krótka i bezpieczna do mówienia, użyj jej po usunięciu Markdownu.
2. Dla znanych stanów zastosuj deterministyczny szablon:
   - `ack`: „Przyjąłem zadanie i rozpocząłem pracę. Pełny status jest w panelu.”
   - `approval`: „Potrzebuję Twojej zgody, zanim wykonam tę operację.”
   - `failed`: „Zadanie nie zostało zakończone. Pełny opis błędu jest w panelu.”
3. Pozostałe długie odpowiedzi przekaż do beznarzędziowego projektora LLM ze schematem Zod.
4. Walidator sprawdza długość, język, brak Markdownu i zachowanie krytycznych stanów.
5. Przy błędzie projektora użyj bezpiecznego fallbacku, a nie pierwszych 320 znaków pełnej odpowiedzi.

Bezpieczny fallback:

> Mam wynik. Pełna odpowiedź jest dostępna tekstowo.

Komenda użytkownika „przeczytaj całość” może jawnie ominąć standardowy limit, ale powinna wymagać osobnego trybu odtwarzania, który nadal da się przerwać.

## 6. Voice Companion

### 6.1. Technologia

Rekomendacja: mała aplikacja tray w Tauri 2.

- frontend może być minimalny lub całkowicie ukryty;
- obsługa mikrofonu, audio i portalu Wayland powinna znajdować się po stronie natywnej;
- konfiguracja w lokalnym pliku aplikacji, bez sekretów w repozytorium;
- komunikacja wyłącznie z `127.0.0.1`.

Na GNOME/Wayland globalny PTT należy oprzeć o portal XDG `GlobalShortcuts`, ponieważ zapewnia osobne zdarzenia aktywacji i dezaktywacji. Zwykły listener przeglądarkowy może być jedynie trybem fallback działającym przy aktywnym oknie.

### 6.2. Maszyna stanów klienta

```text
idle
  ├─ key_down ─────────► listening
  │                        ├─ key_up ─────► transcribing
  │                        └─ error ──────► failed
  ├─ config_open ──────► configuring
  └─ shutdown ─────────► stopped

transcribing
  ├─ transcript_final ─► thinking
  ├─ no_speech ────────► idle
  └─ error ────────────► failed

thinking
  ├─ response ─────────► synthesizing
  ├─ key_down ─────────► listening
  └─ error/timeout ────► failed

synthesizing
  ├─ audio_ready ──────► speaking
  ├─ shouldSpeak=false ► idle
  └─ error ────────────► failed

speaking
  ├─ playback_end ─────► idle
  ├─ key_down ─────────► listening  (barge-in)
  └─ stop_speaking ────► idle
```

### 6.3. Zachowanie PTT

- `key_down`: zatrzymaj aktualne TTS, odtwórz krótki earcon i rozpocznij nagrywanie;
- przytrzymanie klawisza nie może generować kolejnych startów;
- `key_up`: zakończ strumień przez `EOF` i oczekuj wyłącznie na finalną transkrypcję;
- cisza lub bardzo krótki wynik nie tworzą turnu Meta Agenta;
- drugi `key_down` podczas `thinking` rozpoczyna nową wypowiedź, ale nie anuluje automatycznie poprzedniego zadania;
- „przestań mówić” zatrzymuje wyłącznie playback;
- „anuluj zadanie” jest osobnym poleceniem kierowanym do Meta Agenta/orchestration.

## 7. Integracja VoiceStudio/OmniVoice

### 7.1. STT

Domyślna ścieżka MVP:

```text
ws://127.0.0.1:3900/ws/transcribe?model=sherpa-parakeet-tdt-v3
```

Założenia audio:

- PCM signed 16-bit little-endian;
- mono;
- 16 kHz;
- ramki wysyłane na bieżąco;
- `EOF` po zwolnieniu PTT;
- do Meta trafia tylko komunikat `final`.

Nie używać w MVP `POST /v1/audio/transcriptions` do wymuszania modelu lub języka, dopóki wrapper w lokalnej wersji 0.4.1 nie zostanie poprawiony albo zweryfikowany po aktualizacji.

Fallback STT:

- pusty wynik, ewidentna repetycja albo błąd Sherpa → ponowienie na Whisper/faster-whisper;
- nie uruchamiać obu modeli dla każdej wypowiedzi bez dowodu, że poprawia to jakość;
- nie wykonywać automatycznie skutków ubocznych, gdy transkrypcja jest niepewna i polecenie jest destrukcyjne;
- approval Meta Agenta pozostaje obowiązkowy niezależnie od jakości STT.

### 7.2. TTS

MVP:

```http
POST http://127.0.0.1:3900/v1/audio/speech
```

Minimalny payload:

```json
{
  "model": "omnivoice",
  "input": "Krótkie polskie podsumowanie.",
  "language": "pl",
  "response_format": "wav"
}
```

Należy wybrać i przypiąć konkretny profil głosu. Automatyczne klonowanie głosu nie należy do MVP.

WebSocket TTS należy dodać dopiero po benchmarku. Dla krótkiego `spokenText` REST upraszcza timeouty, retry i zatrzymywanie playbacku.

### 7.3. Prewarm

Model TTS ma zauważalny cold start i jest usuwany z VRAM po okresie bezczynności. Wdrożenie powinno przetestować trzy warianty:

1. brak prewarm;
2. lekki health/preload przy uruchomieniu Voice Companion;
3. prewarm po pierwszym `key_down`.

Nie zwiększać stale zajętej pamięci GPU bez pomiaru wpływu na Ollama i pozostałe lokalne modele.

## 8. Zmiany po stronie Mastry

### 8.1. Wydzielenie wspólnego kernela Meta

Obecny `installMetaAgentHarness()` powinien zostać zrefaktoryzowany tak, aby logika wykonania znalazła się w funkcji podobnej do:

```typescript
async function executeMetaTurn(input: ExecuteMetaTurnInput): Promise<HarnessGenerateResult>
```

Funkcja musi zwracać:

- pełny `response`;
- `deliverableText`;
- `runId` i `turnId`;
- referencje artefaktów;
- status zakończenia;
- dane potrzebne do bezpiecznej projekcji głosowej.

Istniejący monkey patch `metaAgent.generate()` oraz nowy endpoint voice muszą korzystać z tego samego kernela. Nie wolno tworzyć drugiej, uproszczonej ścieżki generacji omijającej harness.

### 8.2. Proponowane pliki

Nazwy są robocze i mogą zostać dopasowane do istniejących konwencji repozytorium:

```text
src/mastra/services/meta-turn-executor.ts
src/mastra/services/voice/voice-contracts.ts
src/mastra/services/voice/voice-turn-service.ts
src/mastra/services/voice/speech-summary-projector.ts
src/mastra/services/voice/speech-summary-policy.ts
src/mastra/services/voice/voice-idempotency.ts
src/mastra/services/voice/voice-turn-lock.ts
src/mastra/routes/voice-routes.ts
src/mastra/scripts/check-voice-contracts.ts
src/mastra/scripts/check-speech-summary-policy.ts
src/mastra/scripts/e2e-voice-turn.ts
```

Jeżeli lokalne API routes pozostają definiowane w `src/mastra/index.ts`, plik `voice-routes.ts` powinien eksportować gotową konfigurację rejestrowaną w centralnym entrypoincie.

### 8.3. Request context

Turn głosowy powinien ustawiać w request context co najmniej:

```typescript
{
  channel: 'voice',
  inputModality: 'speech',
  locale: 'pl-PL',
  utteranceId,
  conversationId,
}
```

Kontekst informuje narzędzia i telemetrię o kanale wejścia, ale nie nakazuje głównemu agentowi skrócenia odpowiedzi.

### 8.4. Idempotencja i serializacja

- klucz idempotencji: `resourceId + utteranceId`;
- rekord powstaje przed uruchomieniem Meta Agenta;
- retry po utracie odpowiedzi zwraca istniejący rezultat;
- jednocześnie może być aktywny najwyżej jeden synchroniczny turn dla danego `conversationId`;
- kolejny turn może zostać zakolejkowany albo otrzymać jawny `409`, zależnie od przyjętej polityki;
- idempotency record nie może przechowywać surowego audio;
- retencja rekordów powinna być ograniczona i konfigurowalna.

## 9. Etapy implementacji

### Faza 0 — baseline i zamrożenie kontraktu

Szacowany czas: 0,5–1 dnia.

Zadania:

- przypiąć wykorzystywaną wersję obrazu VoiceStudio zamiast `latest`;
- zapisać aktualną konfigurację modeli i głosu;
- wybrać profil TTS dla języka polskiego;
- przygotować 50–100 polskich wypowiedzi testowych;
- zmierzyć Parakeet i Whisper na tej samej próbce;
- zamrozić request/response `/voice/v1/turn`;
- ustalić klawisz PTT i tryb fallback toggle.

Kryteria wyjścia:

- wybrany domyślny model STT;
- potwierdzony polski profil TTS;
- wersjonowany kontrakt endpointu;
- zapisane pomiary jakości i opóźnień warm/cold.

### Faza 1 — pionowy MVP bez globalnego hotkeya

Szacowany czas: 1–2 dni.

Zadania:

- prosty lokalny klient lub przycisk działający przy aktywnym oknie;
- nagrywanie PCM i połączenie `/ws/transcribe`;
- obsługa finalnej transkrypcji;
- wydzielenie `executeMetaTurn()`;
- implementacja `/voice/v1/turn` przez `generate()`;
- prosta, deterministyczna polityka `spokenText`;
- wywołanie REST TTS i odtworzenie WAV;
- widoczny pełny `displayText` i transkrypcja.

Kryteria wyjścia:

- można przeprowadzić kilka kolejnych tur po polsku;
- Meta zachowuje pamięć tej samej rozmowy;
- pełna odpowiedź nie jest czytana, jeżeli przekracza limit;
- nowa wypowiedź zatrzymuje audio;
- nie powstaje drugi assistant turn z `spokenText`.

### Faza 2 — Native Voice Companion i prawdziwy PTT

Szacowany czas: 2–3 dni.

Zadania:

- utworzyć aplikację tray;
- zintegrować XDG GlobalShortcuts dla GNOME/Wayland;
- zaimplementować `Pressed/Released`;
- dodać wybór mikrofonu i urządzenia wyjściowego;
- dodać earcony i minimalny overlay statusu;
- zaimplementować pełną maszynę stanów;
- dodać bezpieczny reconnect do VoiceStudio i Mastry;
- dodać barge-in zatrzymujący tylko playback.

Kryteria wyjścia:

- PTT działa poza aktywnym oknem aplikacji;
- puszczenie klawisza zawsze kończy nagrywanie;
- brak podwójnych turnów przy autorepeat klawiatury;
- restart VoiceStudio lub Mastry nie wymaga restartu całego systemu;
- odcięcie playbacku następuje natychmiast po `key_down`.

### Faza 3 — bezpieczny Speech Summary Projector

Szacowany czas: 1–2 dni.

Zadania:

- zaimplementować reguły dla `ack`, `approval`, `warning`, `failed`, `done`;
- dodać beznarzędziowy projector dla długiego tekstu;
- użyć schematu Zod dla `spokenText`, `speakKind`, `shouldSpeak` i `requiresUserAction`;
- dodać walidację limitu, języka i braku Markdownu;
- sprawdzić zachowanie negacji, błędów, kwot, dat i identyfikatorów;
- dodać komendę „przeczytaj całość”;
- zapewnić bezpieczny fallback bez drugiego wywołania Meta Agenta.

Kryteria wyjścia:

- podsumowanie nie zmienia statusu sukces/porażka;
- approval i blocker zawsze trafiają do głosu;
- nie są czytane kod, logi ani sekrety;
- błąd projektora nie blokuje zwrócenia pełnego tekstu.

### Faza 4 — hardening Voice Gateway

Szacowany czas: 1–3 dni.

Zadania:

- trwała lub wystarczająco bezpieczna idempotencja `utteranceId`;
- serializacja tur per conversation;
- timeouty osobno dla STT, Meta, projectora i TTS;
- telemetryka z jednym correlation ID;
- bounded retry bez powtarzania side effects;
- redakcja logów i ograniczona retencja;
- testy utraty mikrofonu, serwera, sieci lokalnej i modelu;
- health indicator dla OmniVoice, Mastry, STT i TTS.

Kryteria wyjścia:

- retry klienta nie uruchamia drugi raz narzędzi Meta;
- brak `resourceId` nigdy nie używa wspólnego fallbacku pamięci;
- awaria TTS nie niszczy pełnej odpowiedzi;
- każdy turn można prześledzić po `utteranceId`, `turnId` i `runId`.

### Faza 5 — długie joby i komunikaty asynchroniczne

To etap zależny od gotowości delivery/projections orchestration V2.

Zadania:

- mówić krótki `ack` po prawdziwym utworzeniu joba;
- dodać kanał push/SSE dla `requires_action`, `failed` i `completed`;
- generować `spokenText` z finalnej projekcji/deliverable, nie z surowego eventu;
- deduplikować delivery do klienta;
- nie mówić każdego milestone'u i każdego retry;
- umożliwić użytkownikowi wyciszenie komunikatów zakończeń.

Kryteria wyjścia:

- klient nie musi stale pollować;
- dokładnie jeden komunikat terminalny jest odtwarzany dla joba;
- komunikat nie obiecuje powiadomienia, jeżeli delivery nie jest aktywne;
- pełny rezultat pozostaje w UI/artefakcie.

### Faza 6 — opcjonalna integracja z Meta Front

Meta Front może później przejąć rolę widoku rozmowy i statusów. Nie powinien przejmować mikrofonu globalnego ani logiki STT/TTS.

Warunki rozpoczęcia:

- Meta Front ma pełny kontrakt wyników i artefaktów;
- istnieje push/SSE zamiast samego pollingu;
- jest jasna decyzja o migracji Meta Agent → `front_only`;
- zachowana jest jakość i zakres możliwości obecnego Meta Agenta.

Voice Gateway powinien pozostać stabilny; ewentualna zmiana backendu rozmowy nie może wymagać przepisywania Voice Companion.

## 10. Testy

### 10.1. Polski STT

Zestaw testowy powinien obejmować:

- normalną mowę, szept i szybsze tempo;
- odmianę polskich czasowników i rzeczowników;
- liczby, daty, godziny i kwoty;
- „Mastra”, „Meta Agent”, „n8n”, „MongoDB”, „OmniVoice”, nazwy modeli;
- angielskie terminy w polskim zdaniu;
- krótkie komendy: „stop”, „anuluj”, „tak”, „nie”;
- hałas tła i ciszę;
- nazwiska, ścieżki plików i identyfikatory jobów.

Metryki:

- WER jako wskaźnik pomocniczy;
- skuteczność rozpoznania intencji/komendy;
- liczba pustych i halucynowanych transkrypcji;
- p50/p95 czasu finalizacji po zwolnieniu PTT.

### 10.2. Speech Summary

Przypadki obowiązkowe:

- krótka odpowiedź bez zmian;
- długa odpowiedź techniczna;
- pełny sukces;
- częściowy sukces;
- porażka;
- blocker;
- approval;
- uruchomiony job bez finalnego wyniku;
- odpowiedź zawierająca kod, tabelę, URL i sekret testowy;
- negacja: „nie udało się” nie może stać się „udało się”;
- „przeczytaj całość”;
- błąd albo timeout projektora.

### 10.3. Idempotencja i skutki uboczne

- dwa identyczne requesty z tym samym `utteranceId`;
- utrata połączenia po wykonaniu Meta, przed odpowiedzią HTTP;
- podwójny `key_up`;
- autorepeat `key_down`;
- dwie wypowiedzi w tej samej rozmowie;
- dwie równoległe rozmowy;
- wypowiedź uruchamiająca narzędzie mutujące z approval;
- restart Voice Companion podczas aktywnego turnu.

### 10.4. Audio i UX

- globalny PTT w terminalu, przeglądarce i IDE;
- zmiana urządzenia mikrofonowego;
- odłączenie mikrofonu;
- brak VoiceStudio;
- barge-in podczas TTS;
- TTS zakończony naturalnie;
- brak `spokenText`;
- cold start i warm start;
- praca przy równoczesnym obciążeniu GPU przez Ollama.

### 10.5. Budżety jakościowe

Poniższe wartości są celami do pomiaru, nie wartościami już potwierdzonymi:

| Etap | Cel warm p95 |
|---|---:|
| zatrzymanie playbacku po `key_down` | < 150 ms |
| finalizacja krótkiego STT po `key_up` | < 1 s |
| projekcja krótkiego podsumowania | < 1 s |
| początek TTS po otrzymaniu `spokenText` | < 1,5 s |
| prosta odpowiedź end-to-end po `key_up` | 2–4 s + czas Meta Agenta |

## 11. Bezpieczeństwo, prywatność i licencje

- VoiceStudio i Voice Gateway pozostają na loopback;
- nie wystawiać `/mcp` publicznie;
- nie zapisywać surowego audio domyślnie;
- pliki tymczasowe usuwać po zakończeniu STT;
- logować metadane i czasy, nie pełny waveform;
- cloning głosu wymaga jawnej zgody właściciela głosu;
- approval Meta Agenta pozostaje aktywny dla operacji ryzykownych;
- rozróżnić przerwanie mowy od anulowania pracy;
- przypiąć wersję kontenera zamiast używać ruchomego `latest`;
- aktualizację 0.4.1 → 0.4.2 przeprowadzić osobno, ze smoke testem STT/TTS;
- VoiceStudio jest AGPL-3.0;
- wagi OmniVoice są CC-BY-NC — zastosowanie komercyjne wymaga osobnej weryfikacji;
- Parakeet v3 jest CC-BY-4.0.

## 12. Feature flags i konfiguracja

Proponowane flagi:

```text
FEATURE_VOICE_GATEWAY=false
FEATURE_VOICE_SPEECH_PROJECTOR=false
FEATURE_VOICE_ASYNC_NOTIFICATIONS=false
```

Proponowana konfiguracja środowiskowa:

```text
VOICE_STUDIO_BASE_URL=http://127.0.0.1:3900
VOICE_STT_MODEL=sherpa-parakeet-tdt-v3
VOICE_TTS_MODEL=omnivoice
VOICE_LOCALE=pl-PL
VOICE_TTS_LANGUAGE=pl
VOICE_TTS_PROFILE=<wybrany-profil>
VOICE_SPOKEN_MAX_CHARS=320
VOICE_TURN_TIMEOUT_MS=<po-pomiarach>
VOICE_IDEMPOTENCY_TTL_MS=<po-pomiarach>
```

Nie umieszczać w repozytorium sekretów ani danych sklonowanego głosu.

## 13. Obserwowalność

Każdy turn powinien mieć wspólny kontekst:

```text
resourceId
conversationId
utteranceId
turnId
runId
playbackId
```

Rejestrowane timestampy:

```text
ptt_started_at
ptt_released_at
stt_final_at
meta_started_at
meta_finished_at
summary_finished_at
tts_requested_at
tts_audio_ready_at
playback_started_at
playback_stopped_at
```

Logi muszą rozróżniać:

- cold/warm model;
- brak mowy;
- fallback STT;
- timeout poszczególnego etapu;
- przerwanie playbacku;
- idempotency hit;
- błąd projektora przy zachowanym `displayText`.

## 14. Rollout i rollback

Rollout:

1. uruchomić feature flag tylko dla lokalnego użytkownika testowego;
2. przez pierwsze sesje zachować widoczny transcript przed wysłaniem albo tryb „potwierdź przed wykonaniem”;
3. sprawdzić polskie komendy ryzykowne i approval;
4. włączyć automatyczne wysyłanie dopiero po osiągnięciu akceptowalnej jakości STT;
5. osobno włączyć projector LLM;
6. osobno włączyć powiadomienia async.

Rollback:

- wyłączenie `FEATURE_VOICE_GATEWAY` usuwa wyłącznie kanał głosowy;
- Meta Agent, Meta Front i zwykłe endpointy pozostają bez zmian;
- wyłączenie projectora pozostawia `displayText` i deterministyczny fallback;
- awaria OmniVoice nie może blokować zwykłej rozmowy tekstowej;
- Voice Companion powinien mieć polecenie „disconnect/stop” bez zatrzymywania Mastry.

## 15. Definition of Done

Pierwsza wersja jest gotowa do codziennego użycia, gdy:

- globalny PTT działa stabilnie na obecnym GNOME/Wayland;
- finalna polska transkrypcja trafia do właściwego wątku Meta Agenta;
- Meta używa tego samego harnessu i pamięci co kanał tekstowy;
- pełna odpowiedź jest dostępna tekstowo;
- głos odczytuje maksymalnie 1–3 zdania, chyba że użytkownik zażąda całości;
- `spokenText` nie tworzy dodatkowej wiadomości w pamięci;
- barge-in zatrzymuje TTS bez automatycznego anulowania joba;
- powtórzony `utteranceId` nie powtarza skutków ubocznych;
- brak tożsamości kończy się fail-closed;
- approval nadal chroni operacje ryzykowne;
- awaria STT, projectora albo TTS ma czytelny i bezpieczny fallback;
- testy polskiego STT, summary, idempotencji i audio przechodzą;
- p50/p95 warm i cold są zapisane, a nie zakładane;
- VoiceStudio pozostaje dostępne wyłącznie lokalnie.

## 16. Kolejność prac rekomendowana dla wykonawcy

```text
1. Baseline PL: Parakeet vs Whisper + wybór głosu
2. Kontrakt /voice/v1/turn
3. Wydzielenie executeMetaTurn()
4. Voice endpoint przez metaAgent.generate()
5. Deterministyczny spokenText
6. Minimalny klient PTT przy aktywnym oknie
7. STT WebSocket + TTS REST
8. Test pionowy end-to-end
9. Native companion + XDG GlobalShortcuts
10. Barge-in i maszyna stanów
11. Speech Summary Projector
12. Idempotencja, turn lock i telemetria
13. Testy awarii i optymalizacja cold/warm
14. Async job notifications po gotowości orchestration V2
15. Opcjonalne podłączenie widoku Meta Front
```

## 17. Szacunek prac

| Poziom | Zakres | Szacunek |
|---|---|---:|
| pionowy prototyp | aktywny przycisk, STT, Meta, prosty skrót, TTS | 1–2 dni |
| wygodny lokalny MVP | globalny PTT, tray, barge-in, kontrakt dual-output | 4–7 dni łącznie |
| wersja utwardzona | idempotencja, awarie, telemetryka, testy i optymalizacja | 1–2 tygodnie łącznie |

Szacunki nie obejmują ukończenia całej orchestration V2 ani migracji Meta Frontu. Te prace są niezależne od podstawowej komunikacji głosowej.

