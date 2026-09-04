# SPLOT OS Video Production Engine — Podręcznik Operatora i Dokumentacja

> **Silnik wideo SPLOT OS (YouTube Video Production Engine)**  
> Autonomiczny potok postprodukcji wideo dedykowany dla kanału YouTube o tworzeniu systemów agentowych i platformy SPLOT OS. Twórca nagrywa jedynie ujęcie twarzy (*talking head*), a agenci Mastra realizują transkrypcję, cięcia, generowanie animacji kodu/architektury w Remotion TSX, mastering audio (RNNoise), podkład muzyczny (Google Lyria), miniaturkę (GPT Image / Imagen 3) i publikację na YouTube.

---

## 1. Architektura i Przepływ Informacji

```
[Surowe nagranie MP4] (np. videos/ep-01/raw.mp4)
         │
         ▼
 1. video_transcribe (Lokalny Whisper Large v3 Turbo w omnivoice-data)
         │  -> Generuje transcript.json (słowa + timestampy co do milisekundy)
         ▼
 2. filmmakerAgent / video_generate_cuts + video_render_cuts
         │  -> Tworzy cuts.json (usuwa pauzy, pomyłki, false starts)
         │  -> Renderuje bezstratny master_cut.mp4 + edited-transcript.json
         ▼
 3. video_clean_audio & video_mix_audio
         │  -> RNNoise odszumia mowę i normalizuje poziom do -14 LUFS
         │  -> Miksuje SFX z katalogu + podkład muzyczny Google Lyria z duckingiem (-16 dB)
         ▼
 4. codingAgent / video_scaffold_shot (Remotion TSX Engine)
         │  -> Generuje kod scen w TypeScript/React (SplotTerminal, AgentGraph, CodeWalkthrough)
         │  -> Rejestruje sceny w Remotion Studio (brand: Cyber Emerald, Cobalt, Obsidian)
         ▼
 5. video_bake_master
         │  -> Headless render Remotion 4K60fps + kompozycja nakładek/cutawayów z masterem
         ▼
 6. marketingAgent / video_package_metadata + video_generate_thumbnail
         │  -> Generuje tytuły o wysokim CTR, opis z rozdziałami/znacznikami czasu
         │  -> Generuje miniaturkę w formacie 16:9 z referencyjną twarzą Patryka
         ▼
 7. Approval Gate & video_youtube_upload
         │  -> Patryk zatwierdza podgląd wideo i metadanych
         │  -> Upload na YouTube Data API v3 jako Private/Unlisted Draft
```

---

## 2. Podział Narzędzi i Odpowiedzialności Agentów

| Agent w SPLOT OS | Przypisane narzędzia wideo | Zadanie |
| :--- | :--- | :--- |
| **`filmmakerAgent`** | `videoTranscribe`, `videoGenerateCuts`, `videoRenderCuts`, `videoCleanAudio`, `videoMixAudio`, `videoBakeMaster` | Reżyseria, analiza skryptu, kompozycja osi czasu, mastering audio i montaż całości. |
| **`codingAgent` / `codingMasterAgent`** | `videoScaffoldShot`, `videoRenderRemotion` | Generowanie kodu komponentów Remotion TSX w React/TypeScript dla animacji kodu i terminala. |
| **`marketingAgent`** | `videoPackageMetadata`, `videoGenerateThumbnail`, `videoYoutubeUpload` | Przygotowanie strategii pakowania (tytuły, opis, znaczniki czasu), generowanie miniaturki z GPT Image / Imagen 3 oraz upload na YouTube. |
| **`metaAgent`** | `workflow.trigger("youtube-video-production-workflow")` | Globalna orkiestracja, przyjmowanie intencji od użytkownika i uruchamianie deterministycznego potoku. |

---

## 3. Brand Template SPLOT OS (Kluczowe Tokeny)

Wszystkie sceny wideo generowane w Remotion korzystają ze wspólnych tokenów zdefiniowanych w `video-engine/remotion/src/brand.ts`:

- **Główne kolory:**
  - `Cyber Emerald` (`#00E599`): Główny akcent, sukces, aktywne statusy agentów.
  - `Electric Cobalt` (`#3B82F6`): Logika architektury, Mastra Core.
  - `Deep Violet` (`#8B5CF6`): Subagenci, pamięć semantyczna.
  - `Solar Amber` (`#F59E0B`): Bramki akceptacji (*Approval Gates*).
  - `Obsidian Shell` (`#07090E` / `#0D111A` / `#151C28`): Ciemne tła z głębią i siatką punktową.
- **Typografia:**
  - `Space Grotesk` (700) – tytuły i nagłówki scen.
  - `Inter` / `Geist` (500) – podpisy i tekst UI.
  - `JetBrains Mono` (400, 700) – kod, logi terminala i ścieżki plików.
- **Ruch:**
  - Klatkaż: **60 fps**, rozdzielczość: **4K (3840×2160)**.
  - Easing: `EASINGS.easeOut` (`bezier(0.16, 1, 0.3, 1)`) – płynne, nowoczesne wejścia bez przerysowanego odbijania.

---

## 4. Dostępne Szablony Komponentów Remotion

W `video-engine/remotion/src/lib/splot.tsx` znajdują się gotowe szablony do wykorzystania przez agentów:

1. **`SplotTerminalShot`**:
   - Animowane okno konsoli SPLOT OS z efektem pisania komendy, migającym kursorem, logami w czasie rzeczywistym i statusem wykonania.
2. **`SplotAgentGraphShot`**:
   - Architektoniczny graf 4-kolumnowy prezentujący delegację zadań pomiędzy `metaAgent`, `filmmakerAgent`, `codingAgent` i `marketingAgent`.
3. **`SplotBackdrop`**:
   - Ciemne tło z subtelną radialną poświatą neonową i siatką punktową (grid 40px).

---

## 5. Jak Uruchomić Produkcję Wideo?

### Sposób 1: Przez `metaAgent` (Naturalny język)
Wystarczy wydać polecenie:
```text
metaAgent, uruchom workflow youtube-video-production-workflow dla projektu "ep-01" z plikiem nagrania "videos/ep-01/raw.mp4".
Temat: Architektura agentowa w SPLOT OS i automatyczne tworzenie wideo.
```

### Sposób 2: Przez kod TypeScript / Workflow API
```typescript
import { youtubeVideoProductionWorkflow } from './workflows/youtube-video-production-workflow.js';

const run = await youtubeVideoProductionWorkflow.execute({
  inputData: {
    projectFolder: 'ep-01',
    videoFilePath: '/projekty/mastra-agentic-environment/agentic-agents/video-engine/videos/ep-01/raw.mp4',
    topicTitle: 'Budowa Autonomicznego Systemu Agentów SPLOT OS',
    pauseCompressionStyle: 'tight',
  },
});
```

### Sposób 3: Podgląd na żywo w Remotion Studio
```bash
cd /projekty/mastra-agentic-environment/agentic-agents/video-engine/remotion
npm run dev
# Otwórz przeglądarkę na http://localhost:3000
```

---

## 6. Procedura Bezpieczeństwa i Publikacji (Approval Gate)

Zgodnie z regułami bezpieczeństwa SPLOT OS:
1. **Narzędzie `videoYoutubeUpload` w trybie domyślnym (`dryRun: true`)** przygotowuje deklaratywny plik `publish.json` zawierający tytuł, opis, tagi, miniaturkę i ścieżkę do wideo.
2. Agent **zawsze zatrzymuje się przed finalnym uploadem** i generuje zapytanie o akceptację (`requestApprovalTool`).
3. Po zatwierdzeniu przez Patryka wideo zostaje wysłane jako `unlisted` (lub `private` draft), dając pełną możliwość weryfikacji w panelu YouTube Studio przed publiczną premierą.
