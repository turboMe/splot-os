---
name: remotion-motion-graphics-architect
description: "Ekspert w projektowaniu, kodowaniu i optymalizacji animacji, czołówek, dynamicznych okien twarzy (SmartFaceCam), kinetycznych napisów (KineticCaptions), plansz informacyjnych, infografik i B-rollu w Remotion (React + TypeScript). Używaj zawsze, gdy agent tworzy komponenty wideo, kinetyczną typografię, plansze porównawcze, animacje schematów lub montuje wideo na YouTube w SPLOT OS."
category: design
keywords:
  - remotion
  - react
  - video
  - motion-graphics
  - youtube
  - animation
  - tsx
  - captions
  - facecam
minComplexity: medium
recommendedTier: pro
preferLocal: false
handoffCapable: true
estimatedTokens: 850
outputFormat: typescript
tags: [remotion, react, video, motion-graphics, youtube, animation, tsx, captions, facecam]
license: MIT
user-invocable: true
version: 1
---

# Remotion Motion Graphics Architect (React Video Engine)

Ten skill definiuje reguły, komponenty i wzorce tworzenia deterministycznych, nowoczesnych animacji wideo w Remotion dla YouTube i Social Video w SPLOT OS.

---

## 1. Złote Zasady Remotion (Czego NIE WOLNO, a co NALEŻY robić)

| ❌ Czego NIGDY nie wolno robić | ✅ Co NALEŻY robić w Remotion |
|---|---|
| `setTimeout`, `setInterval`, `Date.now()` | Wszystko wyliczane z `const frame = useCurrentFrame();` i `const { fps } = useVideoConfig();` |
| Tranzycje CSS (`transition: all 0.3s ease`) | `interpolate(frame, [0, 30], [0, 100], { extrapolateRight: 'clamp' })` |
| Animacje CSS `@keyframes` | Funkcja fizyki sprężyn `spring({ frame, fps, config: { damping, mass, stiffness } })` |
| Sztywne szerokości w pikselach bez brandingu | Układy na `<AbsoluteFill>` z `flex`, `grid`, `%` oraz tokeny z `brand.ts` (`COLORS`, `RADIUS`, `SHADOW`) |
| Zewnętrzne linki HTTP do obrazków | Funkcja `staticFile('sciezka/plik.png')` lub wbudowany kod SVG |
| Niekontrolowane wycieki wartości poza zakres | Zawsze `{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }` w `interpolate()` |

---

## 2. Kluczowe Komponenty Systemu (Wbudowane w `src/lib/`)

### A. `SmartFaceCam.tsx` (Dynamiczny moduł wideo twarzy)
Obsługuje płynne przechodzenie kamery pomiędzy układami sceny:
- `fullscreen`: główny widok twarzy z dynamicznym "punch-zoomem" na kluczowych słowach.
- `pip_bottom_right` / `pip_bottom_left`: eleganckie zaokrąglone okienko z cieniem brandowym (`SHADOW.card`) i obwódką w kolorze akcentu.
- `split_left` / `split_right`: podział ekranu (35% twarz, 65% kod, terminal lub grafika).
- `floating_badge`: okrągły avatar w stylu loom/screencast.
- `hidden`: animowany zjazd poza kadr z efektem spring physics.

```tsx
import { SmartFaceCam } from '../../lib';

// Przykład użycia w ujęciu:
<SmartFaceCam
  src="projects/ep-01/camera.mp4"
  layout="pip_bottom_right"
  punchZoom={1.08}
  label="Patryk — SPLOT OS"
/>
```

### B. `KineticCaptions.tsx` (Kinetyczne napisy karaoke z Whisper)
- Synchronizacja klatka-w-klatkę ze słowami z transkrypcji Whisper.
- Style: `kinetic_pill` (podświetlany dymek), `cyber_glow`, `minimal_clean`, `bold_karaoke`.
- Automatyczne parowanie słów-kluczy z emoji (np. `ai` -> 🤖, `sukces` -> 🚀, `kod` -> 💻).

```tsx
import { KineticCaptions } from '../../lib';

<KineticCaptions
  words={transcriptWords}
  style="kinetic_pill"
  chunkSize={4}
  highlightColor={COLORS.accent}
/>
```

### C. `Overlays.tsx` & `Transitions.tsx`
- `<LowerThird name="Patryk" role="Mastra Architect" />`
- `<NotificationToast title="✓ Intent Recognized" message="Delegated to codingMasterAgent" />`
- `<StatCounter value={100} suffix="%" label="Autonomous Coverage" />`
- `<CyberBackdrop glowColor={COLORS.accent} />`

---

## 3. Wzorzec Fizyki i Animacji (Spring Physics)

W Remotion najlepszy, organiczny ruch uzyskuje się za pomocą `spring()`:

```tsx
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

// Płynne wejście elementu (sprężyste pojawienie się)
const scale = spring({
  frame: frame - delayFrames,
  fps,
  config: {
    damping: 14,   // mniejsze = więcej odbić, większe = płynniejsze wyhamowanie
    mass: 0.5,     // lżejsza masa = szybszy start
    stiffness: 110 // sztywność sprężyny
  }
});
```

---

## 4. Standardy Lokalizacji Zasobów

1. **Wszystkie nowe ujęcia TSX tworzymy w**:
   `video-engine/remotion/src/shots/<projekt>/<Komponent>.tsx`
2. **Rejestracja w rejestrze**:
   Po dodaniu nowego ujęcia wywołujemy `node scripts/gen-registry.mjs`.
3. **Pobieranie grafik/zdjęć**:
   Przez `staticFile('projects/<projekt>/grafika.png')` z katalogu `media/`.
