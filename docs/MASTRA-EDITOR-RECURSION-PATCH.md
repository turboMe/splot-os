# Dokumentacja łatki: @mastra/editor RangeError Fix & Model Fallback

## 1. Problem: `RangeError: Maximum call stack size exceeded` w `@mastra/editor`

### Objawy
Podczas dłuższych zadań agentów lub w sytuacji, gdy model główny zgłasza błąd (np. błąd formatu wiadomości Gemini) i system uruchamia mechanizm **Model Fallback / Agent Forking**, serwer deweloperski `mastra dev` wyłączał się z błędem:

```text
file:///.../@mastra/editor/dist/index.js:653
        const toolsFn = async ({ requestContext: requestContext2 }) => {
                        ^
RangeError: Maximum call stack size exceeded
```

### Przyczyna źródłowa
W bibliotece `@mastra/editor` (wersja `0.7.24`), w metodzie `applyStoredOverrides`:
```javascript
// Kod przed łatką:
const originalTools = fork.listTools.bind(fork);
const toolsFn = async ({ requestContext: requestContext2 }) => {
  const codeTools = await originalTools({ requestContext: requestContext2 });
  // ...
  return { ...codeTools, ...registryTools, ...mcpTools, ...integrationTools };
};
fork.__setTools(toolsFn);
```
Gdy agent jest wielokrotnie forkowany (np. przy przełączaniu modeli w locie w `Harness`), `fork.listTools` stawał się już opakowaną funkcją `toolsFn`. Kolejne wywołanie owijało `toolsFn` w kolejne `toolsFn`, tworząc łańcuch zagnieżdżonych domknięć. W momencie wywołania `listTools()` dla nowego modelu silnik V8 przepełniał stos wywołań.

---

## 2. Rozwiązanie problemu

### Krok główny: Wyłączenie `MastraEditor` w `src/mastra/index.ts`
Moduł `@mastra/editor` nie jest potrzebny do działania Mastra Studio (czat pod `http://localhost:4111`, lista agentów, podgląd workflows, trace viewer). Te funkcje są natywnie obsługiwane przez `@mastra/server` i `@mastra/core`.

W `src/mastra/index.ts`:
```typescript
export const mastra = new Mastra({
  // ...
  // editor: new MastraEditor(), — WYŁĄCZONE
});
```
Wyłączenie `editor` w konstruktorze `Mastra`:
1. Całkowicie eliminuje przechwytywanie wywołań `mastra.getAgent()` przez niepotrzebny wrapper `@mastra/editor`.
2. Zabezpiecza serwer przed wyciekiem pamięci i `RangeError: Maximum call stack size exceeded`.
3. Zachowuje 100% funkcjonalności Mastra Studio (czat, narzędzia, workflowy).

### Krok uzupełniający: Łatka `@mastra/editor` (`patches/@mastra+editor+0.7.24.patch`)
Dodatkowo w repozytorium zachowano łatkę w `patches/` na wypadek, gdyby w przyszłości pakiet `@mastra/editor` został ponownie włączony.

---

## 3. Co zrobić w przyszłości przy aktualizacji Mastra?

1. Pozostaw `editor` wyłączony w `src/mastra/index.ts`, chyba że pojawi się wyraźna potrzeba korzystania z CMS do edycji promptów w GUI zamiast w kodzie.
2. Gdy zaktualizujesz wersję `@mastra/editor` (np. do `>=0.8.0`), możesz usunąć stary plik łatki z `patches/` jeśli upstream naprawi metodę `applyStoredOverrides`.

---

## 4. Konfiguracja modeli fallback (`model-manifest.ts`)

W pliku `src/mastra/config/model-manifest.ts` zastąpiono niestabilny `gemini-3.7-flash` (który rzucał błędy tur i przeciążeń) sprawdzonymi, stabilnymi modelami:
* **Główny model:** `gemini-3.6-flash` (stabilny szybki flash)
* **Fallback 1:** `deepseek-v4-flash`
* **Fallback 2:** `gemini-3.5-flash` / `deepseek-v4-pro`
