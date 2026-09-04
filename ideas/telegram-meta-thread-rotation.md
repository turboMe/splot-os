# Plan: rotacja wątku w workflow Telegram → Mastra Meta-Agent

Status: plan dla deva
Data: 2026-05-10
Zakres: n8n workflow `Mastra - Telegram Meta-Agent Gateway v3` (ID `ZlDGfs3lbEviEnaz`), instancja `af-n8n` (sqlite: `/home/node/.n8n/database.sqlite`)

## 0. Po co

Obecnie thread Mastra Memory jest stały: `telegram-chat-{chatId}`. Każde wywołanie agenta dociąga do 30 ostatnich wiadomości tego threadu (`lastMessages: 30` w [meta-agent.ts:111](../src/mastra/agents/meta-agent.ts#L111)) + observational memory na poziomie resource. Im dłużej trwa rozmowa, tym większy prompt → wyższe koszty, wolniejsze odpowiedzi.

Cel: ograniczyć narastanie kontekstu **bez utraty długoterminowej pamięci agenta**.

## 1. Decyzje produktowe (zatwierdzone przez użytkownika)

- Hybryda: **rotacja dzienna** (automat) + **`/reset`** (ręczny override w środku dnia).
- `/reset` jest **cichy** — workflow nie odpowiada potwierdzeniem, po prostu nie woła agenta i kończy egzekucję. Świeży kontekst widać dopiero przy następnej wiadomości.
- `resource` zostaje stały (`telegram-chat-{chatId}`) — observational memory nadal akumuluje wiedzę o użytkowniku międzywątkowo.

## 2. Aktualny stan workflow (do zmiany)

Workflow `Mastra - Telegram Meta-Agent Gateway v3` (active) ma 3 nody:

1. **Telegram Trigger** (`telegram_trigger`) — odbiera wiadomość
2. **Ollama Reply** (`ollama_reply`, HTTP POST do `http://localhost:4111/api/agents/meta-agent/generate`) — w `jsonBody` ma na sztywno:
   ```js
   memory: {
     thread:   'telegram-chat-' + $json.message.chat.id,
     resource: 'telegram-chat-' + $json.message.chat.id
   }
   ```
3. **Telegram Send** (`telegram_send`) — odsyła odpowiedź do chatu

Połączenia: `Telegram Trigger` → `Ollama Reply` → `Telegram Send`.

## 3. Docelowy stan workflow

Wstawić **nowy Code node** `Compute Thread ID` między `Telegram Trigger` a `Ollama Reply`. Zmienić `jsonBody` w `Ollama Reply` żeby brał `thread` z output'u nowego node'a.

Nowy graf: `Telegram Trigger` → **`Compute Thread ID`** → `Ollama Reply` → `Telegram Send`.

### 3.1. Nowy node — `Compute Thread ID`

Typ: `n8n-nodes-base.code`, language: `javaScript`, mode: `runOnceForEachItem` **nie** — użyć `runOnceForAllItems` (default), bo trigger Telegrama daje 1 item.

Kod (`functionCode`):

```js
const staticData = $getWorkflowStaticData('global');
const msg = $json.message || {};
const chatId = msg.chat?.id;
const text = (msg.text || msg.caption || '').trim();
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

if (!chatId) {
  return []; // brak chatu → nic dalej
}

staticData.resets = staticData.resets || {};

// Cichy /reset: zapisz znacznik i zakończ — żaden node downstream nie odpali.
if (text === '/reset') {
  staticData.resets[String(chatId)] = Date.now();
  return [];
}

// Reset uznajemy tylko jeśli był ZROBIONY DZIŚ — po północy auto-rotacja sama
// daje świeży wątek, stary stamp ignorujemy (i tak zniknie po następnym /reset).
const resetStamp = staticData.resets[String(chatId)];
const useReset = resetStamp
  && new Date(resetStamp).toISOString().slice(0, 10) === today;

const threadId = `telegram-chat-${chatId}-${today}${useReset ? '-' + resetStamp : ''}`;

return [{ json: { ...$json, _threadId: threadId } }];
```

**Uwagi do implementacji:**
- `$getWorkflowStaticData('global')` jest persistowane w rekordzie workflow w sqlite n8n → przeżywa restart kontenera `af-n8n`.
- Zwrot `[]` z Code node poprawnie short-circuituje — żaden node downstream się nie wykona, Telegram nie dostanie żadnej odpowiedzi (cichy `/reset`).
- `resource` celowo NIE zmieniamy — observational memory ma scope `'resource'` ([meta-agent.ts:115](../src/mastra/agents/meta-agent.ts#L115)) i potrzebuje stałego identyfikatora żeby kompresować wiedzę długoterminowo.

### 3.2. Modyfikacja node'a `Ollama Reply`

W `jsonBody` zmienić **tylko** linię z `thread`. `resource` zostaje stały.

Diff w expressionie:

```diff
- thread:   'telegram-chat-' + $json.message.chat.id,
+ thread:   $json._threadId,
  resource: 'telegram-chat-' + $json.message.chat.id
```

Reszta payloadu (`messages`, `requestContext`, `maxSteps`) bez zmian.

### 3.3. Połączenia

Edytować `connections` workflow:
- `Telegram Trigger` → `Compute Thread ID` (zamiast bezpośrednio do `Ollama Reply`)
- `Compute Thread ID` → `Ollama Reply`
- `Ollama Reply` → `Telegram Send` (bez zmian)

## 4. Jak wdrożyć (krok po kroku)

Zalecana ścieżka — przez UI n8n (`http://localhost:5678` lub przez tunnel cloudflare):

1. Otworzyć workflow `Mastra - Telegram Meta-Agent Gateway v3`.
2. **Deactivate** workflow przed edycją (zapobiega dziwnym stanom przy live triggerze).
3. Dodać Code node `Compute Thread ID` z kodem z sekcji 3.1.
4. Przepiąć połączenie: rozpiąć `Telegram Trigger` → `Ollama Reply`, wpiąć przez nowy node.
5. Edytować `Ollama Reply` — zmienić wyrażenie `thread` zgodnie z 3.2.
6. **Save** + **Activate**.

Alternatywa (skryptowa, gdyby UI był niedostępny): edytować bezpośrednio `nodes` i `connections` workflow w sqlite (`/home/node/.n8n/database.sqlite`, tabela `workflow_entity`, kolumny `nodes` i `connections` jako JSON). Po edycji **trzeba zrestartować kontener** `af-n8n`, bo n8n cache'uje workflow w pamięci.

## 5. Test plan

Po aktywacji wykonać sekwencję w Telegramie do bota:

| # | Wiadomość | Oczekiwane zachowanie |
|---|-----------|----------------------|
| 1 | "cześć, pamiętasz że lubię kawę?" | Agent odpowiada, zakłada nowy wątek `telegram-chat-{id}-2026-05-10` |
| 2 | "co właśnie powiedziałem?" | Agent cytuje wiadomość 1 (kontekst dnia działa) |
| 3 | `/reset` | **Brak odpowiedzi** od bota. W Mastra Studio (zakładka Memory → threads) widać nowy thread `telegram-chat-{id}-2026-05-10-{epoch}` |
| 4 | "co właśnie powiedziałem?" | Agent NIE pamięta wiadomości 1–2 (świeży thread). Może natomiast pamiętać preferencję o kawie, jeśli observational memory ją zapisała (scope: resource) — to jest pożądane |
| 5 | (następnego dnia) cokolwiek | Agent w nowym wątku `telegram-chat-{id}-2026-05-11`, bez pamięci wczorajszych wiadomości surowych |

Weryfikacja po stronie Mastry: przejść do Mastra Studio → Memory → wybrać resource `telegram-chat-{id}` → powinno być widocznych wiele threadów posortowanych po dacie.

## 6. Ryzyka i edge cases

- **Static data resetu rośnie w nieskończoność** — to słownik `chatId → epoch`. Praktycznie 1 wpis na chat, marginalne. Można zignorować.
- **Wiadomości bez tekstu** (zdjęcia, stickery bez `caption`) — kod traktuje je normalnie (text = `''`), idą do agenta jak każda inna. OK.
- **Komenda z prefiksem inna niż `/reset`** (np. `/help`) — przelatuje do agenta, agent ma sobie z tym poradzić. Jeśli kiedyś chcemy dodać więcej komend gateway-side, robimy to w tym samym Code node.
- **Restart `af-n8n`** — static data persistowane w sqlite, przeżywa restart. ✅
- **Wgranie nowej wersji workflow przez import** — static data jest w rekordzie workflow, jeśli ktoś wczyta surowy JSON eksportu **bez** static data, znaczniki resetu zostaną wyzerowane. Niegroźne (po prostu wszyscy zaczynają od dziennego threadu).

## 7. Co NIE wchodzi w zakres

- Nie zmieniamy `lastMessages: 30` ani konfiguracji memory w meta-agencie. Jeśli po wdrożeniu nadal kontekst rośnie za szybko — osobny ticket na zmniejszenie do 10–15.
- Nie ruszamy starszych workflowów `telegram-meta` ani `Mastra - Telegram Meta-Agent Gateway v2` (oba nieaktywne).
- Nie dodajemy potwierdzenia dla `/reset` — świadomie cichy.
- Nie wdrażamy innych komend slash (`/help`, `/status` itd.) — osobna inicjatywa, jeśli będzie potrzeba.
