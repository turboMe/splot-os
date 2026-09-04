# Plan automatycznego czyszczenia logów Playwright MCP

## Opis problemu
Serwer **Playwright MCP** (`@playwright/mcp`), uruchamiany jako sidecar w ramach środowiska agentowego Mastra, domyślnie generuje logi konsoli przeglądarki (`console-*.log`) oraz zrzuty stanu stron (`page-*.yml`) w katalogu `src/mastra/public/.playwright-mcp/`. 

Pliki te:
- Nie są automatycznie rotowane ani usuwane przez serwer Playwright MCP.
- Szybko się kumulują (jeden plik na każdą sesję/nawigację).
- W przypadku długotrwałego (wielomiesięcznego) działania systemu mogą zapełnić dysk lub wyczerpać i-węzły (inodes) w systemie plików.

Aktualnie pliki te zostały dodane do `.gitignore` (aby nie trafiały do repozytorium), lecz wciąż gromadzą się lokalnie.

---

## Proponowane rozwiązania (do wdrożenia w razie zapełniania dysku)

### Opcja A: Czyszczenie podczas startu serwera (Najprostsza i najbardziej bezobsługowa)
Możemy zmodyfikować istniejący skrypt startowy `scripts/with-node.sh` lub dodać krok przed uruchomieniem komendy `mastra dev` / `mastra start` w `package.json`, który usunie logi starsze niż 7 dni.

**Implementacja (dodanie do skryptu startowego):**
```bash
# Wyszukaj i usuń pliki w .playwright-mcp modyfikowane dawniej niż 7 dni temu
if [ -d "src/mastra/public/.playwright-mcp" ]; then
  find src/mastra/public/.playwright-mcp -type f -mtime +7 -delete
fi
```

---

### Opcja B: Cykliczne zadanie w ramach CRON Runnera (W pełni zintegrowane)
Jeżeli system działa w trybie ciągłym bez częstych restartów, usuwanie przy starcie może nie być wystarczające. Lepszym rozwiązaniem jest integracja z wewnętrznym mechanizmem zadań cyklicznych w projekcie.

Możemy rozszerzyć skrypt `src/mastra/scripts/cron-runner.ts` o zadanie codziennego czyszczenia starych plików:

```typescript
import { promises as fs } from 'fs';
import { join } from 'path';

async function cleanPlaywrightLogs(maxAgeDays = 7) {
  const logDir = join(process.cwd(), 'src/mastra/public/.playwright-mcp');
  
  try {
    const files = await fs.readdir(logDir);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = join(logDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    // Katalog może nie istnieć przy pierwszym uruchomieniu
    console.log('Playwright logs directory cleanup skipped or not found');
  }
}
```

---

## Kryteria wdrożenia
Wdrożyć jedno z powyższych rozwiązań, kiedy katalog `src/mastra/public/.playwright-mcp/` zacznie przekraczać rozmiar **500 MB** lub liczba plików w nim zgromadzonych przekroczy **5000 sztuk**.
