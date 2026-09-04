# Coding Agent MVP

Aktualizacja: 2026-05-08.

Ten dokument opisuje lokalny MVP `codingAgent`: workspace repo, artifact zadania,
ledger zmian i podstawowy rollback.

## Zakres

`codingAgent` pracuje na repo:

```txt
/projekty/mastra-agentic-environment/agentic-agents
```

Repo wymaga Node `v22.20.0` przez `.nvmrc`. Skrypty `dev`, `build`, `start`,
`init-db`, `cron` i checki uruchamiaja komendy przez `scripts/with-node.sh`,
ktory robi `nvm use` przed startem Mastry albo narzedzi `tsx`.

Agent ma agent-specific `codeWorkspace`, a nie globalny terminal meta-agenta.
Workspace udostepnia:

- `find_files`
- `search_content`
- `workspace_search`
- `index_content`
- `view`
- `write_file`
- `execute_command`
- `lsp_inspect`

`write_file` wymaga approval i read-before-write. `execute_command` wykonuje bez
approval tylko lokalne komendy diagnostyczne i weryfikacyjne z allowlisty, np.
`rg`, `git diff`, `npx tsc --noEmit`, `npm run build`. Komendy sieciowe i
destrukcyjne wymagaja approval.

`CODING_SANDBOX_ISOLATION` pozwala wlaczyc natywna izolacje `bwrap` albo
`seatbelt`. Domyslnie MVP uzywa `none`, bo lokalne `bwrap --unshare-net` w tym
srodowisku blokuje nawet `npx tsc --noEmit` bledem `Failed RTM_NEWADDR:
Operation not permitted`. To jest swiadomy kompromis MVP: approval i allowlista
komend sa aktywne, a twardsza izolacja OS wraca w etapie supervisora/blue-green.

LSP jest wlaczony przez `lsp: true` i ma zainstalowane runtime dependencies:

- `typescript-language-server`
- `vscode-jsonrpc`
- `vscode-languageserver-protocol`

## Artifact taska

Kazde zadanie kodowe powinno zaczac sie od:

```txt
coding.create_artifact
```

Artifact jest zapisywany w MongoDB w kolekcji `code_task_artifacts` i zawiera:

- `taskId`
- status
- plan
- `filesRead`
- `filesChanged`
- `commandsRun`
- approvale
- `diffSummary`
- `testResult`
- status rollbacku

Aktualizacja artifactu:

```txt
coding.update_artifact
```

Odczyt artifactu:

```txt
coding.get_artifact
```

## Change Ledger

Przed kazda edycja pliku agent powinien wykonac:

```txt
coding.record_before_change
```

Po zapisie pliku przez `write_file` agent powinien wykonac:

```txt
coding.record_after_change
```

Snapshoty sa zapisywane w MongoDB w kolekcji `code_change_snapshots`. Ledger
trzyma `beforeHash`, `beforeContent`, `afterHash`, `afterContent`, status oraz
opis zmiany.

Limit snapshotu to 2 MB na plik. Ledger blokuje `.git`, `node_modules` i `.env`.

## Rollback i akceptacja

Dostepne narzedzia:

```txt
coding.reject_file
coding.reject_all
coding.accept_file
coding.accept_all
```

Rollback jest bezpieczny hash-based:

1. Narzedzie czyta aktualny plik.
2. Porownuje aktualny hash z `afterHash`.
3. Jesli hashe sa zgodne, odtwarza `beforeContent` albo usuwa plik utworzony
   przez agenta.
4. Jesli hashe sa rozne, snapshot dostaje status `conflict` i narzedzie nie
   nadpisuje zmian uzytkownika.

## Mongo Indexes

`src/mastra/scripts/init-db.ts` i `ensureIndexes()` zakladaja indeksy dla:

- `code_task_artifacts`
- `code_change_snapshots`
- `maintenance_tasks`

Po wdrozeniu zmian warto uruchomic:

```txt
npm run init-db
```

## Minimalny flow agenta

1. Znajdz pliki przez `find_files`, `search_content` albo `workspace_search`.
2. Przeczytaj pliki przez `view`.
3. Utworz artifact przez `coding.create_artifact`.
4. Przed edycja wywolaj `coding.record_before_change`.
5. Zmien plik przez `write_file`.
6. Po edycji wywolaj `coding.record_after_change`.
7. Uruchom `npx tsc --noEmit` albo najtansza sensowna weryfikacje.
8. Zaktualizuj artifact przez `coding.update_artifact`.
9. W finalu podaj `taskId`, pliki, wynik weryfikacji, ryzyka i rollback status.
