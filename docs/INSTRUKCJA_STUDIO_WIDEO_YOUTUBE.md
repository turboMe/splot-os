# 🎬 SPLOT OS — Autonomiczne Studio Wideo YouTube (Szybki Start)

Podręcznik operacyjny dla twórcy: jak w kilka minut wyprodukować odcinek na YouTube przy pomocy agentów AI i silnika wideo w **SPLOT OS**.

---

## 🚀 1. Czy silnik wideo działa po uruchomieniu „splot” z Pulpitu?

**TAK.** 
Gdy klikasz ikonę **Splot** na Pulpicie (`Splot.sh`), startuje cały rdzeń SPLOT OS:
- Serwer agentów Mastra (`http://localhost:4111/splot` i `http://localhost:4111`)
- Baza pamięci MongoDB + silnik n8n
- Wszystkie narzędzia wideo (`videoTools`) oraz przepływ `youtubeVideoProductionWorkflow` są **natychmiast załadowane i aktywne**.

> 💡 **Opcjonalny podgląd Remotion na żywo:** Jeśli chcesz podczas montażu oglądać sceny animowane w edytorze przeglądarkowym Remotion Player, możesz w dowolnym momencie wpisać w terminalu:
> ```bash
> cd /projekty/mastra-agentic-environment/agentic-agents/video-engine/remotion
> npm run dev
> ```
> Otworzy się Remotion Studio pod adresem: `http://localhost:3000`.

---

## 📂 2. Gdzie wrzucać swoje nagrania i pliki?

Wszystkie materiały wideo trafiają do katalogu:
`/projekty/mastra-agentic-environment/agentic-agents/video-engine/`

| Co chcesz dodać? | Ścieżka docelowa | Przykład pliku |
| :--- | :--- | :--- |
| **Surowe nagranie wideo (twarz / ekran)** | `videos/<nazwa-projektu>/raw.mp4` | `videos/odcinek-01/raw.mp4` |
| **Same pliki audio (np. z mikrofonu)** | `videos/<nazwa-projektu>/work/audio/` | `videos/odcinek-01/work/audio/master.wav` |
| **Zdjęcia Twojej twarzy (do miniaturek AI)** | `media/library/faces/` | `media/library/faces/patryk_01.jpg` |
| **Własna muzyka / efekty SFX** | `media/library/sfx/` oraz `media/library/music/` | `media/library/sfx/whoosh.wav` |

---

## 🎭 3. Czy da się tworzyć wideo bez twarzy (Faceless / Voiceover)?

**TAK, w 100%!**

Silnik obsługuje dwa główne tryby:
1. **Tryb z Twarzą (Talking Head + Cutaways + Split-Screen):**
   - Twoja kamera jest główną osią wideo.
   - Pomyłki i pauzy są bezstratnie wycinane przez FFmpeg.
   - W kluczowych momentach na ekran wjeżdża graf agentów, animowany terminal lub kod IDE (jako Picture-in-Picture lub pełny ekran).
2. **Tryb Bez Twarzy (Faceless AI / Screen + Graphics):**
   - Wrzucasz nagrany głos (plik `.wav` / `.mp3`) lub nagranie ekranu bez kamery.
   - Całe wideo budowane jest z pełnoekranowych, nowoczesnych scen Remotion TSX (`full-bleed shots`):
     - Animowany graf agentów (`SplotAgentGraphShot`)
     - Konsola terminala wpisująca komendy i logi w czasie rzeczywistym (`SplotTerminalShot`)
     - Ciemne neonowe tła z siatką (`SplotBackdrop`)
     - Plansze z kodem TypeScript i kluczowymi wnioskami.

---

## 🎨 4. Jak operować tłem, napisami, grafami i scenami?

Wszystkie elementy graficzne są zdefiniowane jako komponenty **React / TypeScript** w `remotion/src/lib/splot.tsx` i używają oficjalnego **Brand Template SPLOT OS**:

### 🌟 Paleta barw (w `brand.ts`):
- **Cyber Emerald** (`#00E599`): Aktywne agenty, sukces, zielony neonowy glow.
- **Electric Cobalt** (`#3B82F6`): Przepływy danych, połączenia w grafie, kod.
- **Deep Violet** (`#8B5CF6`): Koordynacja nadrzędna (`metaAgent`), refleksja modeli.
- **Solar Amber** (`#F59E0B`): Ostrzeżenia, bramki akceptacji (`Approval Gates`).
- **Obsidian Dark** (`#07090E`): Głębokie, profesjonalne ciemne tło studia.

### 📝 Jak zlecasz to agentowi w czacie?
Nie musisz pisać kodu ręcznie — wystarczy opisać to naturalnym językiem:

> 💬 **Przykłady promptów do `metaAgent`:**
> - *"Stwórz ujęcie grafu pokazujące jak metaAgent deleguje zadanie do codingAgenta i bazy wiedzy."*
> - *"Wyrenderuj scenę terminala z komendą `splot run deploy` i zielonymi logami sukcesu."*
> - *"Zmień kolor poświaty tła na Cobalt Blue (`#3B82F6`) w ujęciu wprowadzającym."*

Agent `codingAgent` natychmiast utworzy odpowiedni plik TSX w `remotion/src/shots/<projekt>/`, a `filmmakerAgent` wstawi go w odpowiedniej sekundzie filmu.

---

## 🤖 5. Jakie modele są podpięte i co robią w pipeline?

| Zadanie w pipeline | Podpięty Model / Silnik | Źródło / Koszt |
| :--- | :--- | :--- |
| **Transkrypcja i synchronizacja słów** | **Whisper Large v3 Turbo** (lokalny w `/home/linus/omnivoice-data/`) | **100% lokalny, 0 zł, GPU offline** |
| **Odszumianie głosu i mastering** | **RNNoise** (`sh.rnnn` / `cb.rnnn`) + FFmpeg LUFS -14dB | **100% lokalny, 0 zł** |
| **Reżyseria, scenariusz, cięcia i TSX** | **Claude 3.7 Sonnet / Gemini 2.5 Pro / DeepSeek V3** | Klucze API w Twoim `.env` |
| **Generowanie muzyki w tle** | **Google Lyria / Audio API** (lub lokalny katalog Lo-Fi) | Darmowe kredyty Google AI |
| **Miniaturki YouTube (Grafika)** | **GPT Image 2 (DALL-E 3)** ➔ **Google Imagen 3** + referencja twarzy | OpenAI / Google Vertex |
| **Tytuły, SEO i Rozdziały** | **marketingAgent** (Gemini Flash / Claude) | Klucze API |
| **Publikacja na YouTube** | **Google YouTube Data API v3** (z bramką akceptacji) | Google Cloud Console |

---

## ⚡ 6. Instrukcja Krok po Kroku (Jak wyprodukować wideo)

### Krok 1: Wrzucasz nagranie
Nagraj wideo telefonem/aparatem i zapisz np. jako:
`/projekty/mastra-agentic-environment/agentic-agents/video-engine/videos/odcinek-01/raw.mp4`

### Krok 2: Wpisujesz polecenie w SPLOT OS (Czat lub Terminal)
W oknie SPLOT OS (`http://localhost:4111/splot`) wpisujesz:
```text
metaAgent, wyprodukuj wideo dla projektu odcinek-01 z pliku videos/odcinek-01/raw.mp4.
Temat: Jak zbudować własny system agentów AI (SPLOT OS)?
Dodaj animowany graf agentów oraz konsolę CLI w Remotion.
Przygotuj miniaturkę z moją twarzą i ułóż chwytliwe rozdziały na YouTube.
```

### Krok 3: Agent wykonuje pracę w tle
1. Wyciąga audio i robi transkrypcję Whisperem.
2. Wycina pauzy i potknięcia (`master_cut.mp4`).
3. Odszumia głos (RNNoise) i podkłada muzykę z duckingiem.
4. Generuje i kompiluje sceny TSX w 4K60.
5. Generuje 3 wersje miniaturki i metadane SEO (`packaging/metadata.json`).

### Krok 4: Podgląd i Zatwierdzenie publikacji
Agent wyświetla podsumowanie i link do gotowego pliku wideo 4K oraz miniaturki.
Gdy napiszesz **"Zatwierdzam publikację"**, wideo zostanie automatycznie przesłane na Twój kanał YouTube jako **Draft / Unlisted** do ostatecznego wglądu.
