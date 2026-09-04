# Observational Memory w Mastra

Data notatki: 2026-05-07

## Kontekst

Mastra dodala Observational Memory jako warstwe dlugoterminowej pamieci agenta. To nie jest zwykle trzymanie wiekszej liczby wiadomosci w promptcie i nie jest to klasyczny RAG. Mechanizm uzywa background agentow Observer i Reflector, ktore kompresuja starsza historie rozmowy do obserwacji i refleksji.

Oficjalne materialy:

- https://mastra.ai/research/observational-memory
- https://mastra.ai/blog/observational-memory
- https://mastra.ai/blog/changelog-2026-02-04
- https://mastra.ai/blog/changelog-2026-03-23

## Co mamy teraz

W obecnym repo nie mamy wlaczonej Observational Memory.

Mamy:

- zwykla `Memory` Mastry z `lastMessages`:
  - `src/mastra/agents/meta-agent.ts` ma `lastMessages: 30`
  - `src/mastra/agents/marketing-agent.ts` ma `lastMessages: 15`
  - `src/mastra/agents/sales-agent.ts` ma `lastMessages: 15`
  - `src/mastra/agents/analytics-agent.ts` ma `lastMessages: 10`
  - `src/mastra/agents/automation-architect.ts` ma `lastMessages: 20`
- wlasny processor `sharedMemoryOutputProcessor`, ktory zapisuje wybrane decyzje meta-agenta do kolekcji `shared_memory` z TTL 24h
- narzedzia `shared_memory.add_context`, `shared_memory.list_context`, `shared_memory.push_signal`
- globalny storage Mastry na MongoDB przez `MongoDBStore`

Wersja paczki lokalnie:

- `@mastra/memory@1.17.4`

To znaczy, ze technicznie mozemy wlaczyc OM bez duzej przebudowy.

## Co daje Observational Memory

OM utrzymuje trzy warstwy pamieci:

1. Recent messages - ostatnia dokladna historia rozmowy.
2. Observations - skompresowane obserwacje z dluzszej historii.
3. Reflections - dalsze kondensowanie obserwacji, kiedy same obserwacje rosna.

Wedlug dokumentacji i changelogow Mastry:

- `observationalMemory: true` wlacza system recent messages -> observations -> reflections.
- Domyslnym modelem dla OM jest `google/gemini-2.5-flash`.
- Przy konfiguracji obiektowej trzeba jawnie podac model.
- OM wspiera storage: `@mastra/pg`, `@mastra/libsql`, `@mastra/mongodb`.
- OM moze dzialac w `scope: 'thread'` albo eksperymentalnie w `scope: 'resource'`.
- Jest tryb retrieval, ktory pozwala agentowi wracac do surowych wiadomosci stojacych za obserwacjami.
- Sa temporal markers, ktore pomagaja agentowi rozumiec przerwy w rozmowie.

## Czy ma to sens u nas

Tak, ale selektywnie.

Najwiekszy sens:

- `metaAgent`
- przyszly `codingAgent`
- agent do dlugich rozmow operacyjnych
- agent, ktory ma pamietac decyzje projektowe, preferencje i kontekst debugowania

Mniejszy sens:

- `weekly-content`
- `producer-hunt`
- workflowy cronowe
- workflowy, ktore powinny bazowac na aktualnym CRM, RSS, NotebookLM lub Mongo, a nie na historii rozmowy

OM nie powinno zastepowac CRM ani jawnego systemu uczenia o leadach. Jesli uzytkownik powie: "ten kontakt ma nowy status", agent dalej powinien uzyc narzedzia CRM. Observational Memory moze pamietac, ze taka rozmowa byla, ale zrodlem prawdy musi zostac baza CRM.

## Rekomendowany pilot

Wlaczyc OM tylko dla `metaAgent`.

Proponowana konfiguracja startowa:

```ts
memory: new Memory({
  options: {
    lastMessages: 30,
    observationalMemory: {
      model: 'google/gemini-2.5-flash',
      temporalMarkers: true,
      retrieval: { scope: 'thread' },
    },
  },
})
```

Dlaczego tak:

- `scope: 'thread'` jest bezpieczniejszy niz `resource`, bo nie miesza wielu watkow.
- `temporalMarkers: true` pomaga przy powrotach po kilku godzinach/dniach.
- `retrieval: { scope: 'thread' }` pozwala agentowi odzyskac dokladne fragmenty historii, ale tylko z biezacego watku.
- `google/gemini-2.5-flash` jest domyslnym i rekomendowanym lekkim modelem dla OM.

## Modele

Observer i Reflector powinny byc szybkie, tanie i miec duze okno kontekstu.

Rekomendacja:

- pilot: `google/gemini-2.5-flash`
- alternatywa tania: `openai/gpt-5.2-mini`
- alternatywa Anthropic: `anthropic/claude-haiku-4-5`
- lokalnie tylko po testach, bo lokalny model moze gorzej streszczac dluga historie i miec gorsze limity kontekstu

Docelowo mozna dodac routing po liczbie tokenow przez `ModelByInputTokens`, np. mniejszy model dla krotkich obserwacji, mocniejszy dla duzych refleksji.

## Gdzie to skonfigurowac

Najczystsza opcja:

1. Dodac sekcje `memory` do `src/mastra/config/workflow-models.ts`, np.:

```ts
memory: {
  observer: modelPresets.googleFlash,
  reflector: modelPresets.googleFlash,
}
```

2. Albo utworzyc osobny plik:

```txt
src/mastra/config/memory-config.ts
```

3. Utworzyc helper:

```ts
export function createMetaMemory() {
  return new Memory({
    options: {
      lastMessages: 30,
      observationalMemory: {
        model: workflowModels.memory.observer,
        temporalMarkers: true,
        retrieval: { scope: 'thread' },
      },
    },
  });
}
```

4. W `meta-agent.ts` podmienic inline `new Memory(...)` na `createMetaMemory()`.

5. Zostawic `sharedMemoryOutputProcessor`, bo to inny mechanizm:
   - OM = pamiec rozmowy i kontekstu
   - `shared_memory` = jawne decyzje/sygnaly dla innych agentow i workflowow

## Ryzyka

- Dodatkowe koszty i latency background LLM calls.
- Ryzyko blednych obserwacji, jesli model Observer jest slaby.
- Nie mozna traktowac OM jako zrodla prawdy dla CRM.
- W `resource` scope agent moze mieszac kontekst z wielu watkow, dlatego na start lepszy jest `thread`.
- OM wymaga poprawnego `threadId`; bez tego moze rzucac blad.

## Test akceptacyjny pilota

1. Wlaczyc OM tylko dla `metaAgent`.
2. Przeprowadzic dluga rozmowe z minimum kilkoma zadaniami:
   - CRM
   - repo/kod
   - decyzja projektowa
   - przerwa czasowa
3. Wrocic do watku i zapytac agenta o:
   - decyzje z poczatku rozmowy
   - powody podjetej decyzji
   - co bylo ostatnim stanem zadania
4. Sprawdzic w Studio Memory tab, czy pojawily sie obserwacje.
5. Zweryfikowac, czy agent nie wymysla faktow i dalej uzywa CRM jako zrodla prawdy.

## Decyzja

Warto wdrozyc jako pilot dla `metaAgent`, a potem przeniesc na `codingAgent`. Nie wlaczac globalnie dla wszystkich agentow i workflowow.

