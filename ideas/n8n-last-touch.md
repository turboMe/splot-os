# n8n Last Touch — plan dokończenia autonomii Architecta

Cel: domknąć ścieżkę "koncept → workflow działający i zweryfikowany pierwszym uruchomieniem" tak, żeby agent przechodził cały Golden Path bez ręcznego klikania w dashboard, przy zachowaniu twardych guardraili tam gdzie naprawdę trzeba (krytyczne nody, hardcoded sekrety, score≥80).

Plan jest podzielony na 6 punktów (P1–P6) wynikających z audytu z 2026-05-09. Punkt 7 (dodawanie nowych patternów) świadomie pominięty.

## Kolejność wdrożenia

Zalecana, bo P1 i P2 zmieniają kontrakt aktywacji a inne na nim bazują:

1. **P1** (auto-approve threshold 40 + tryb `auto_low_risk`) — fundament
2. **P3** (tunnel patcher) — łata cichą regresję istniejących workflow
3. **P5** (adopt_workflow) — odblokowuje testy P2/P6 na istniejących workflow
4. **P2** (first-run smoke test) — domyka pętlę "czy faktycznie działa"
5. **P6** (webhook-trigger fallback w teście) — wymaga P3 (świeży tunnel) i P5 (ownership)
6. **P4** (rozszerzony credential registry) — może iść równolegle z dowolnym etapem

Każdy punkt poniżej ma sekcje: **Cel · Zmiany w plikach · Nowe pliki · ENV · Test plan · Ryzyko · Rollback**.

---

## P1 — Auto-approve threshold 40 + tryb `auto_low_risk`

### Cel
Przesunąć próg "review wymaga approval" z 20 na 40 (wartość konfigurowalna ENV). Dodać explicit tryb `mode: 'auto_low_risk'` dla `architect.activate_automation`, który omija node-based blockery (gmail/slack/mongo/postgres/non-GET HTTP) jeśli risk score < 40 i nie ma `securityIssues`. Domyślny tryb `auto` zachowuje stare gates ale na progu 40.

### Zmiany w plikach

#### 1.1 Nowy plik: `src/mastra/tools/architect/risk-thresholds.ts`
Centralizuje progi w jednym miejscu, czyta z ENV z bezpiecznymi defaultami.
```ts
export const RISK_REVIEW_THRESHOLD = clampInt(
  process.env.AUTOMATION_RISK_REVIEW_THRESHOLD,
  40,   // default
  0, 100,
);
export const RISK_BLOCK_THRESHOLD = clampInt(
  process.env.AUTOMATION_RISK_BLOCK_THRESHOLD,
  80,   // default — zostaje
  0, 100,
);
export type RiskVerdict = 'approve' | 'review' | 'block';
export function verdictFromScore(score: number): RiskVerdict {
  if (score >= RISK_BLOCK_THRESHOLD) return 'block';
  if (score >= RISK_REVIEW_THRESHOLD) return 'review';
  return 'approve';
}
function clampInt(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}
```

#### 1.2 `src/mastra/tools/architect/risk-scoring.ts`
- Linia ~234: zamień hardcoded `score >= 80 ? 'block' : score >= 20 ? 'review' : 'approve'` na `verdictFromScore(score)` z nowego modułu.
- Importy: `import { verdictFromScore } from './risk-thresholds.js';`
- Komentarz w description tool zostaje, wartość progowa nie jest tam wymieniona dosłownie.

#### 1.3 `src/mastra/tools/architect/deploy.ts`
- Linia 65: zamień na `const verdict = verdictFromScore(score);`
- Komunikat błędu (linia 71): zamiast hardcoded `(score=${score})` zostaje, ale dodać też wartość progu w message: `score=${score}/${RISK_BLOCK_THRESHOLD}`.
- Linia 76: warunek `if (verdict === 'review' && !context.approvalToken)` zostaje bez zmian — używa już verdict.

#### 1.4 `src/mastra/tools/architect/activate.ts`
- Schema input (linia 17-22): rozszerz enum mode:
  ```ts
  mode: z.enum(['auto', 'auto_low_risk', 'after_approval']).optional().default('auto'),
  ```
- Linia 102: użyj `verdictFromScore(score)`.
- Linia 181 — funkcja `evaluateActivationPolicy` — sygnatura nie zmienia się, ale logika:
  - Linia 189: `if (score >= RISK_REVIEW_THRESHOLD) reasons.push(...)` (40 zamiast 20).
  - Dodaj na początku funkcji: jeśli `mode === 'auto_low_risk'`, zbieraj reasons ale na końcu przepuszczaj jeśli `score < RISK_REVIEW_THRESHOLD`. Tj. zwróć `approvalRequired: false` mimo że są reasons z node-based blockerów. Reasons nadal wracają w odpowiedzi jako `policyNotes` — żeby było widać co było bypassowane.
- Output schema rozszerzyć o nowe pole `bypassedReasons: z.array(z.string()).optional()` żeby audit pokazywał co zostało odpuszczone w trybie auto_low_risk.

  Skeleton zmienionej `evaluateActivationPolicy`:
  ```ts
  function evaluateActivationPolicy(
    workflow: any,
    score: number,
    mode: 'auto' | 'auto_low_risk' | 'after_approval',
  ): ActivationPolicy {
    const reasons: string[] = [];
    // ...zbieranie reasons jak dotąd, ale z nowym progiem...
    if (mode === 'after_approval') reasons.push('activation mode requires approval');
    if (score >= RISK_REVIEW_THRESHOLD) reasons.push(`risk score ${score} >= ${RISK_REVIEW_THRESHOLD}`);
    // ...node-based reasons bez zmian...

    if (mode === 'auto_low_risk' && score < RISK_REVIEW_THRESHOLD) {
      return {
        approvalRequired: false,
        reasons: [],
        bypassedReasons: reasons,
      };
    }
    return { approvalRequired: reasons.length > 0, reasons };
  }
  ```

#### 1.5 `src/mastra/tools/architect/testing/test-workflow.ts`
- Linia 169: `if (riskScore >= 20 && !context.approvalToken)` → `if (riskScore >= RISK_REVIEW_THRESHOLD && !context.approvalToken)`. Import threshold.

#### 1.6 `src/mastra/prompts/automation/base.md`
- Linia 19: zaktualizuj opis: "score >= 80 blokuje deploy. score 40-79 wymaga `system.request_approval`. Próg 40 jest konfigurowalny przez `AUTOMATION_RISK_REVIEW_THRESHOLD`."
- Linia 25 (krok 14): rozszerz: "Aktywuj przez `architect.activate_automation` z `mode: 'auto'` (domyślnie) lub `mode: 'auto_low_risk'` jeśli score<40 i workflow jest read-only/idempotentne (no DB writes, no email, no slack). `auto_low_risk` przepuszcza node-based gates jeśli score jest poniżej progu — zawsze podawaj uzasadnienie w odpowiedzi do użytkownika i licz że bypassed reasons są audytowane."

### Nowe pliki
- `src/mastra/tools/architect/risk-thresholds.ts` (jak wyżej)

### ENV
Dopisz do `.env.example`:
```
# Risk gates dla automatyzacji n8n. score >= REVIEW wymaga approval, >= BLOCK blokuje deploy/activate.
AUTOMATION_RISK_REVIEW_THRESHOLD=40
AUTOMATION_RISK_BLOCK_THRESHOLD=80
```

### Test plan
1. Unit test `risk-thresholds.spec.ts`: clamping, ENV override, verdict boundaries (39→approve, 40→review, 79→review, 80→block).
2. Update istniejących testów `risk-scoring.spec.ts` (jeśli są) — testy używające 20 jako boundary trzeba przepisać na 40.
3. Manual e2e: zbuduj webhook-validate-respond (score ~0), webhook-security-filtered-telegram (score ~15), webhook-lead-to-agentforge-crm (score ~30-40) i sprawdź:
   - Activate `auto` mode dla score=15 z node Telegram → wymaga approval (gmail/slack-like reason).
   - Activate `auto_low_risk` mode dla score=15 z node Telegram → przechodzi, w response `bypassedReasons` zawiera Telegram reason.
   - Activate `auto_low_risk` mode dla score=45 → wymaga approval (próg).
4. Smoke: `architect.deploy_automation` workflow score 25 → idzie bez approvalToken (poprzednio wymagało).

### Ryzyko
- **Średnie**: zmiana threshold globalna może przepuścić workflowy które wcześniej były blokowane. Mitigacja: zmiana jest opt-in przez ENV (default 40 ale można cofnąć do 20). Nowy tryb `auto_low_risk` wymaga jawnego wyboru.
- **Niskie**: zmiana boundary 20→40 może zepsuć test snapshoty jeśli istnieją.

### Rollback
ENV `AUTOMATION_RISK_REVIEW_THRESHOLD=20` przywraca stary próg. Tryb `auto_low_risk` można po prostu nie używać.

---

## P2 — First-run smoke test po activate

### Cel
Po sukcesie aktywacji workflow, automatycznie zweryfikuj że workflow faktycznie wykonuje się raz bez błędu. Wynik audytuj w `automation_events` i wpisuj do `automation_requests.firstRun`. Bez tego "active" znaczy tylko że n8n przyjął flagę, a nie że workflow działa.

Strategia per typ triggera:
- **webhook trigger** → wyślij POST na publiczny URL z mock payloadem (uses N8N_PUBLIC_WEBHOOK_BASE_URL + path), poczekaj na execution, przeanalizuj.
- **schedule trigger** → odczytaj cron, jeśli interwał ≤ 5 min czekaj na naturalne wykonanie (timeout 6 min); jeśli > 5 min, **nie czekaj**, oznacz status `deferred` z polem `nextExpectedAt`.
- **telegram trigger** → status `manual_required`, wygeneruj instrukcje (path do polling, jaki message wysłać).
- **manual trigger / żaden trigger** → status `skipped` z reason.

### Zmiany w plikach

#### 2.1 Nowy plik: `src/mastra/tools/architect/testing/smoke-test.ts`
Eksportuje tool `architect.first_run_smoke` oraz pure function `runFirstRunSmoke()`.

Schema:
```ts
{
  inputs: { automationId: string, workflowId: string, payload?: any, waitMs?: number (default 30000) },
  outputs: {
    status: 'passed' | 'failed' | 'manual_required' | 'deferred' | 'skipped',
    triggerType: string,
    executionId?: string,
    invocationUrl?: string,
    nextExpectedAt?: string,
    findings: TestFinding[],
    message: string,
  }
}
```

Logika:
1. Ownership check (jak w `test-workflow.ts:43-87`) — refuse non-mastra-managed.
2. Pobierz workflow przez `n8n.getWorkflow`.
3. Znajdź trigger node (pierwszy node którego `type` jest w `TRIGGER_TYPES`).
4. Disptach per type:
   - `webhook` / `webhookTrigger`: zbuduj URL `${topology.n8nPublicWebhookBaseUrl}/webhook/${node.parameters.path}` (zwróć w `invocationUrl`), wyślij `triggerWebhook` z mockiem (z `generateMockPayload` jeśli `payload` brak), poczekaj `waitMs / 2` na propagację, pobierz `getExecutions({workflowId, limit: 5})`, znajdź najświeższe wykonanie po `startedAt > now - waitMs`, pobierz `getExecution(id)`, przeanalizuj przez `analyzeExecution`.
   - `scheduleTrigger`: parsuj `node.parameters.rule.interval[0]` (n8n schema), oblicz interval w minutach. Jeśli ≤ 5 min — `await sleep(interval * 60_000 + 30_000)`, potem `getExecutions`. Jeśli > 5 — return `deferred` z `nextExpectedAt = now + interval`.
   - `telegramTrigger`: return `manual_required`, instrukcje: "wyślij wiadomość do bota X komendą Y, potem wywołaj `architect.first_run_smoke` ponownie".
   - inne / brak: return `skipped`.
5. Audit: insert `automation_events` typu `first_run_smoke`, update `automation_requests.firstRun = { status, executionId, at }`.

Wykorzystaj istniejące funkcje:
- `generateMockPayload` z `mock-data.ts`
- `analyzeExecution` z `execution-analyzer.ts`
- `N8nService.triggerWebhook` z `n8n/client.ts`

#### 2.2 `src/mastra/tools/architect/activate.ts`
- Dodaj input field `runSmokeTest?: z.boolean().default(true)`.
- Po sukcesie aktywacji (po linii 156, przed return) — jeśli `context.runSmokeTest !== false`, wywołaj `runFirstRunSmoke({automationId, workflowId})` (importuj pure function).
- Wynik smoke testu dorzuć do response jako `firstRun`. Output schema rozszerzyć o `firstRun: z.any().optional()`.
- **Critical**: smoke test failure NIE deaktywuje workflow automatycznie. Tylko loguje failure i zwraca w odpowiedzi. Decyzja co dalej należy do agenta/użytkownika.

#### 2.3 `src/mastra/agents/automation-architect.ts`
- Dodaj import `firstRunSmokeTool` z `./testing/smoke-test.js` do `tools`.

#### 2.4 `src/mastra/prompts/automation/base.md`
- Po kroku 14 dodaj krok 15: "Sprawdź `firstRun.status` ze zwróconej odpowiedzi `activate_automation`. Jeśli `failed` — uruchom `architect.repair_workflow` z findings, ponów `deploy_automation` (update) i `activate_automation`. Jeśli `deferred` — poinformuj użytkownika kiedy spodziewane pierwsze uruchomienie. Jeśli `manual_required` — daj instrukcje."

### Nowe pliki
- `src/mastra/tools/architect/testing/smoke-test.ts`

### ENV
Brak nowych. Może warto wprowadzić `AUTOMATION_SMOKE_TEST_TIMEOUT_MS` (default 30000).

### Test plan
1. Unit: parsowanie schedule interval (n8n cron format), poprawne liczenie `nextExpectedAt`.
2. E2E happy path: webhook-validate-respond aktywowane → smoke test wysyła POST → execution found → analyzeExecution returns ok → status `passed`.
3. E2E sad path: workflow z błędem (np. unknown node) → execution failed → smoke test zwraca `failed` z findings → ale workflow zostaje aktywny.
4. E2E deferred: schedule trigger co 1h → smoke test zwraca `deferred` natychmiast.
5. Manual: telegram trigger → smoke test zwraca `manual_required` z instrukcjami.

### Ryzyko
- **Średnie**: smoke test może wystrzelić efekt uboczny (POST do prawdziwego webhooka, który np. wyśle Telegram). Mitigacja: w mock payloadach dodać header `X-Mastra-Smoke-Test: true` żeby workflowy mogły opcjonalnie się skipnąć. Pattern builder dla webhook-validate-respond wcześnie sprawdza ten header.
- **Wysokie potencjalnie**: dla `webhook-lead-to-agentforge-crm` pattern smoke test mógłby utworzyć fałszywy lead w CRM. Dlatego smoke test jest **opt-out** (`runSmokeTest: false` w activate input) i Golden Path mówi agentowi: dla high-risk patterns explicit pass `false`.

### Rollback
`activate_automation` z `runSmokeTest: false` zachowuje stare zachowanie. Tool `first_run_smoke` można nie używać.

---

## P3 — `architect.refresh_tunnel_in_workflows` + integracja z tunnel script

### Cel
Po rotacji Cloudflare tunnel URL, zmienić wszystkie wystąpienia starego URL `*.trycloudflare.com` w parameter strings Mastra-managed workflow na nowy URL. Wywoływane automatycznie przez `scripts/n8n-tunnel-up.sh` po wykryciu zmiany.

### Zmiany w plikach

#### 3.1 Nowy plik: `src/mastra/tools/architect/refresh-tunnel.ts`
Eksportuje:
- pure function `refreshTunnelInWorkflows({ oldUrl, newUrl, dryRun }): Promise<RefreshResult>`
- tool `architect.refresh_tunnel_in_workflows` (wraps function)

Logika:
1. Pobierz wszystkie `automation_requests` gdzie `managedBy: 'mastra'`.
2. Dla każdego: `n8n.getWorkflow(n8nWorkflowId)`.
3. Recursive walk po `workflow.nodes[].parameters` szukając stringów zawierających `oldUrl` (jeśli `oldUrl` puste — szukaj generic regex `https://[a-z0-9-]+\.trycloudflare\.com` i podmieniaj na `newUrl`).
4. Jeśli znaleziono zmiany i `!dryRun`: `n8n.updateWorkflow(id, patched)`, audit do `automation_events` typu `tunnel_refresh`.
5. Zwróć: `{ scanned, patched, perWorkflow: [{ workflowId, name, replacements, error? }] }`.

Reuse `replaceInDeep` z `repair-workflow.ts` (przenieś do shared utility `tools/architect/json-utils.ts` jeśli nie ma).

#### 3.2 Nowy plik: `scripts/refresh-tunnel-workflows.ts`
Standalone CLI (not Mastra tool, bo tunnel-up.sh działa przed dev server):
```ts
#!/usr/bin/env bun
// Usage: bun run scripts/refresh-tunnel-workflows.ts <newUrl> [oldUrl]
import 'dotenv/config';
import { refreshTunnelInWorkflows } from '../src/mastra/tools/architect/refresh-tunnel';

const [newUrl, oldUrl] = process.argv.slice(2);
if (!newUrl) { console.error('Usage: refresh-tunnel-workflows <newUrl> [oldUrl]'); process.exit(1); }
const result = await refreshTunnelInWorkflows({ newUrl, oldUrl, dryRun: false });
console.log(JSON.stringify(result, null, 2));
process.exit(result.errors.length === 0 ? 0 : 1);
```

Dodaj do `package.json` scripts: `"refresh-tunnel-workflows": "bun run scripts/refresh-tunnel-workflows.ts"`.

#### 3.3 `scripts/n8n-tunnel-up.sh`
Po linii 144 (sukces recreate n8n), oraz po linii 187 (sukces recreate przez owner-compose), dodaj:
```bash
# Patch already-deployed Mastra-managed workflows
if [ -n "$PREVIOUS_URL" ] && [ "$PREVIOUS_URL" != "$TUNNEL_URL" ]; then
    log "patchuje istniejace Mastra workflowy ze starego $PREVIOUS_URL na $TUNNEL_URL..."
    if (cd "$REPO_ROOT" && bun run scripts/refresh-tunnel-workflows.ts "$TUNNEL_URL" "$PREVIOUS_URL" 2>&1 | tail -5); then
        ok "tunnel refresh w workflowach: ok"
    else
        warn "refresh-tunnel-workflows zglosil bledy — sprawdz log powyzej"
    fi
fi
```

Uwaga: skrypt potrzebuje dostępu do MongoDB (przez `MONGODB_URI` z .env) i n8n (przez `N8N_API_KEY`). Te są w .env który skrypt już zna.

#### 3.4 `src/mastra/agents/automation-architect.ts`
Dodaj `refreshTunnelTool` do tools (żeby agent mógł wywołać manualnie).

### Nowe pliki
- `src/mastra/tools/architect/refresh-tunnel.ts`
- `src/mastra/tools/architect/json-utils.ts` (wyciągnięte `replaceInDeep`)
- `scripts/refresh-tunnel-workflows.ts`

### ENV
Brak nowych. Używa istniejących `MONGODB_URI`, `N8N_BASE_URL`, `N8N_API_KEY`.

### Test plan
1. Unit: `refreshTunnelInWorkflows` dry-run na fixture z dwoma workflowami, jeden ma stary URL w 3 miejscach, drugi nie ma — sprawdź że count jest 3 i tylko pierwszy workflow w `patched`.
2. Integracja: ręcznie zmień `N8N_PUBLIC_WEBHOOK_BASE_URL` w .env na fake URL, deploy fake workflow z HTTP node używającym tego URL. Wywołaj `refresh-tunnel-workflows.ts <prawdziwy_url> <fake_url>`. Sprawdź że workflow w n8n ma podmieniony URL.
3. Tunnel script smoke: zatrzymaj cloudflared, uruchom ponownie żeby wymusić nowy URL, obserwuj czy `tunnel-up.sh` woła refresh i czy faktycznie patchuje.

### Ryzyko
- **Niskie**: false-positive replacement jeśli ktoś świadomie miał inny `*.trycloudflare.com` URL w workflow (np. żeby wskazywać na inny tunel). Mitigacja: jeśli `oldUrl` podane → podmieniaj tylko ten exact match. Generic mode (bez oldUrl) tylko z explicit flagą `--all`.
- **Niskie**: race condition gdy tunnel rotuje a w międzyczasie agent deployuje nowy workflow ze starym URL. Mitigacja: tunnel script kończy refresh ZANIM puszcza `mastra dev`.

### Rollback
Skrypt można usunąć z `n8n-tunnel-up.sh`. Tool `refresh_tunnel_in_workflows` można nie używać.

---

## P4 — Rozszerzony credential registry (Slack, Discord, Postgres, OpenAI, Notion, GitHub, Airtable)

### Cel
Pozwolić architektowi na deployowanie workflowów z popularnymi serwisami bez ręcznego doklejania credential ID. Każdy nowy serwis dostaje: env keys, getter w registry, hint w resolverze, requirement w validatorze, wstrzyknięcie w repair.

### Lista nowych serwisów + ich n8n credential types

| Serwis | n8n credential type | Env keys |
|---|---|---|
| Slack | `slackApi` (token) lub `slackOAuth2Api` | `N8N_CREDENTIAL_SLACK_ID`, `_NAME`, `_TYPE` (default `slackApi`) |
| Discord | `discordWebhookApi` lub `discordBotApi` | `N8N_CREDENTIAL_DISCORD_ID`, `_NAME`, `_TYPE` |
| Postgres | `postgres` | `N8N_CREDENTIAL_POSTGRES_ID`, `_NAME` |
| OpenAI | `openAiApi` | `N8N_CREDENTIAL_OPENAI_ID`, `_NAME` |
| Notion | `notionApi` | `N8N_CREDENTIAL_NOTION_ID`, `_NAME` |
| GitHub | `githubApi` lub `githubOAuth2Api` | `N8N_CREDENTIAL_GITHUB_ID`, `_NAME`, `_TYPE` (default `githubApi`) |
| Airtable | `airtableTokenApi` lub `airtableApi` (legacy) | `N8N_CREDENTIAL_AIRTABLE_ID`, `_NAME`, `_TYPE` (default `airtableTokenApi`) |

### Zmiany w plikach

#### 4.1 `src/mastra/tools/architect/credentials/credential-registry.ts`
Dodaj 7 nowych branchów. Skeleton (powtórzony per serwis):
```ts
if (s === 'slack') {
  const id = process.env.N8N_CREDENTIAL_SLACK_ID;
  const name = process.env.N8N_CREDENTIAL_SLACK_NAME || 'Slack';
  const type = process.env.N8N_CREDENTIAL_SLACK_TYPE || 'slackApi';
  if (id) return { service: 'slack', n8nCredentialType: type, id, name };
}
```

Refaktor opcjonalny: przenieś do data-driven configa (mapa `service → { envPrefix, defaultType }`) — czysto kosmetyczne, ale zmniejsza redundancję.

#### 4.2 `src/mastra/tools/architect/credentials/credential-resolver.ts`
Funkcja `getSetupHint` — dodaj branche dla każdego serwisu z polskim hint message: "Utwórz credential w n8n UI (Slack API). Następnie ustaw `N8N_CREDENTIAL_SLACK_ID` i `N8N_CREDENTIAL_SLACK_NAME` w .env."

#### 4.3 `src/mastra/tools/architect/validation/workflow-validator.ts`
Mapa `credentialRequirements` (linia 263-269) — dorzuć:
```ts
'n8n-nodes-base.slack': { service: 'slack', credentialTypes: ['slackApi', 'slackOAuth2Api'] },
'n8n-nodes-base.discord': { service: 'discord', credentialTypes: ['discordWebhookApi', 'discordBotApi'] },
'n8n-nodes-base.postgres': { service: 'postgres', credentialTypes: ['postgres'] },
'n8n-nodes-base.openAi': { service: 'openai', credentialTypes: ['openAiApi'] },
'n8n-nodes-base.notion': { service: 'notion', credentialTypes: ['notionApi'] },
'n8n-nodes-base.github': { service: 'github', credentialTypes: ['githubApi', 'githubOAuth2Api'] },
'n8n-nodes-base.airtable': { service: 'airtable', credentialTypes: ['airtableTokenApi', 'airtableApi'] },
```

#### 4.4 `src/mastra/tools/architect/testing/repair-workflow.ts`
Dodaj per-node patche analogicznie do telegram/mongo/gmail (linia 154-207). Każdy nowy patch:
```ts
if (node.type === 'n8n-nodes-base.slack' &&
    !node.credentials?.slackApi && !node.credentials?.slackOAuth2Api) {
  const cred = getCredentialFromRegistry('slack');
  if (cred) {
    node.credentials = { ...(node.credentials ?? {}), [cred.n8nCredentialType]: { id: cred.id, name: cred.name } };
    changes.push({ nodeName: node.name, field: `credentials.${cred.n8nCredentialType}`, reason: `Wpiety credential z registry (id=${cred.id}).` });
  }
}
```
Powtórz dla discord, postgres, openai, notion, github, airtable. **DRY refactor zalecany**: wyciągnij `injectCredentialIfMissing(node, serviceKey, possibleTypes[])` i wołaj 10x.

#### 4.5 `src/mastra/tools/architect/validation/node-registry.ts`
Sprawdź czy nowe node types są w `KNOWN_NODE_TYPES` z aktualnymi typeVersions. Jeśli nie — dodaj. Dla nowych node'ów aktualne wersje (n8n latest):
- slack: 2, 2.1, 2.2
- discord: 1, 2
- postgres: 2, 2.1, 2.2, 2.3, 2.4, 2.5
- openAi: 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
- notion: 1, 2, 2.1, 2.2
- github: 1, 1.1
- airtable: 1, 2, 2.1
(Wartości do potwierdzenia w aktualnym n8n — możesz odpytać `GET /types/nodes.json` na n8n REST.)

### ENV
Dopisz do `.env.example`:
```
# n8n credentials — opcjonalne, ustaw jeśli używasz tych serwisów w workflowach
N8N_CREDENTIAL_SLACK_ID=
N8N_CREDENTIAL_SLACK_NAME=Slack
N8N_CREDENTIAL_SLACK_TYPE=slackApi
N8N_CREDENTIAL_DISCORD_ID=
N8N_CREDENTIAL_DISCORD_NAME=Discord
N8N_CREDENTIAL_DISCORD_TYPE=discordWebhookApi
N8N_CREDENTIAL_POSTGRES_ID=
N8N_CREDENTIAL_POSTGRES_NAME=Postgres
N8N_CREDENTIAL_OPENAI_ID=
N8N_CREDENTIAL_OPENAI_NAME=OpenAI
N8N_CREDENTIAL_NOTION_ID=
N8N_CREDENTIAL_NOTION_NAME=Notion
N8N_CREDENTIAL_GITHUB_ID=
N8N_CREDENTIAL_GITHUB_NAME=GitHub
N8N_CREDENTIAL_GITHUB_TYPE=githubApi
N8N_CREDENTIAL_AIRTABLE_ID=
N8N_CREDENTIAL_AIRTABLE_NAME=Airtable
N8N_CREDENTIAL_AIRTABLE_TYPE=airtableTokenApi
```

### Test plan
1. Unit per serwis: registry zwraca undefined gdy ENV puste, zwraca poprawny `CredentialRef` gdy ENV ustawione.
2. Validator: workflow z `n8n-nodes-base.slack` bez credential → `missingCredentials` zawiera slack.
3. Repair: workflow z `n8n-nodes-base.slack` bez credential, ENV `N8N_CREDENTIAL_SLACK_ID` ustawione → po `repairWorkflow` node ma `credentials.slackApi.id`.
4. Manualnie utwórz credential Slack w n8n UI, skopiuj ID do .env, deploy webhook → slack pattern (jeśli istnieje, lub ad-hoc), aktywuj, smoke test.

### Ryzyko
- **Niskie**: dodawanie kodu, nic nie psuje istniejącego.
- **Średnie**: typeVersions w `node-registry.ts` mogą szybko się zdezaktualizować. Mitigacja: w validator zostaje warning (nie error) na nieznane typeVersions, więc nie blokuje.

### Rollback
Po prostu usuń env — registry zwróci undefined, agent zgłosi missingCredential jak przed P4.

---

## P5 — `architect.adopt_workflow`

### Cel
Pozwolić agentowi (i operatorowi) "przejąć" istniejący workflow utworzony w n8n UI lub przez inny system pod ownership Mastry, żeby można go było edytować, testować i smoke-testować przez Architect tools.

### Zmiany w plikach

#### 5.1 Nowy plik: `src/mastra/tools/architect/adopt.ts`
```ts
export const adoptWorkflowTool = createTool({
  id: 'architect.adopt_workflow',
  description: 'Adoptuje istniejacy workflow n8n pod ownership Mastry (managedBy=mastra), pozwalajac Architectowi go aktualizowac, testowac i aktywowac. Wymaga jawnej zgody (confirm: true).',
  inputSchema: z.object({
    workflowId: z.string(),
    automationId: z.string().optional(),
    renameWithPrefix: z.boolean().default(false).describe('Jesli true, dorzuca "Mastra - " prefix do nazwy'),
    confirm: z.literal(true).describe('Musi byc true — adoption nadpisuje ownership'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    automationId: z.string().optional(),
    workflowId: z.string(),
    operation: z.enum(['adopted', 'already_managed', 'blocked']),
    previousManagedBy: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    if (!context.confirm) return { success: false, workflowId: context.workflowId, operation: 'blocked', message: 'confirm=true required' };
    const db = await getDb();
    const existing = await db.collection('automation_requests').findOne({ n8nWorkflowId: context.workflowId });
    if (existing?.managedBy === 'mastra') return { success: true, automationId: existing.automationId, workflowId: context.workflowId, operation: 'already_managed', message: 'Already mastra-managed.' };

    const n8n = new N8nService();
    let workflow;
    try { workflow = await n8n.getWorkflow(context.workflowId); }
    catch (err) { return { success: false, workflowId: context.workflowId, operation: 'blocked', message: `Cannot fetch workflow: ${(err as Error).message}` }; }

    const automationId = context.automationId ?? randomUUID();
    let newName = workflow.name;
    if (context.renameWithPrefix && !workflow.name.startsWith('Mastra - ')) {
      newName = `Mastra - ${workflow.name}`;
      await n8n.updateWorkflow(context.workflowId, { ...workflow, name: newName });
    }
    const validation = validateWorkflow(workflow, 'draft');
    const risk = analyzeWorkflow(workflow);

    await db.collection('automation_requests').updateOne(
      { automationId },
      {
        $set: {
          automationId,
          n8nWorkflowId: context.workflowId,
          name: newName,
          status: workflow.active ? 'active' : 'draft_created',
          riskScore: risk.score,
          riskVerdict: verdictFromScore(risk.score),
          managedBy: 'mastra',
          adoptedAt: new Date(),
          previousManagedBy: existing?.managedBy ?? 'unknown',
          lastSnapshot: workflow,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    await db.collection('automation_events').insertOne({ automationId, type: 'adopted', data: { workflowId: context.workflowId, validationOk: validation.valid, riskScore: risk.score, renamed: newName !== workflow.name }, createdAt: new Date() });

    return { success: true, automationId, workflowId: context.workflowId, operation: 'adopted', previousManagedBy: existing?.managedBy, message: `Adopted as ${automationId}. Risk=${risk.score}, validation.valid=${validation.valid}.` };
  },
});
```

#### 5.2 `src/mastra/agents/automation-architect.ts`
Dodaj import `adoptWorkflowTool` do tools.

#### 5.3 `src/mastra/prompts/automation/base.md`
Dodaj sekcję "Adopcja istniejacych workflow":
- "Workflowy stworzone recznie w n8n UI (lub w innym systemie) nie sa zarzadzane przez Mastre i wszystkie write-tools je odrzuca. Aby je zarzadzac uzyj `architect.adopt_workflow` z `confirm: true`. To jednorazowa operacja — wpisuje rekord do `automation_requests` z `managedBy: 'mastra'`. Po adopcji workflow jest gotowy do `update`/`activate`/`test`/`smoke`."
- "Nigdy nie adoptuj workflow ktorego nie rozumiesz (sprawdz przez `n8n.get_workflow`, sprawdz validation, risk score, dopiero adoptuj)."

### Nowe pliki
- `src/mastra/tools/architect/adopt.ts`

### ENV
Brak.

### Test plan
1. Unit: bez `confirm: true` → blocked. Z confirm i nieistniejacym workflow → blocked z "Cannot fetch". Z confirm i istniejacym → adopted, rekord w Mongo z managedBy=mastra.
2. E2E: utwórz workflow ręcznie w n8n UI, wywołaj `adopt_workflow` z renameWithPrefix=true, sprawdź że nazwa w n8n ma prefix, sprawdź że Mongo ma rekord, potem wywołaj `update_workflow` i sprawdź że nie blokuje (już managedBy=mastra).
3. Edge case: workflow już mastra-managed → operation `already_managed`, zero side effects.

### Ryzyko
- **Średnie**: ktoś może adoptować workflow należący do innego systemu (jarvis) i zacząć go zmieniać. Mitigacja: `confirm: true` jest wymagany, w response zwracane `previousManagedBy` żeby było widać że nadpisaliśmy. Dodatkowo Golden Path mówi "nie adoptuj jeśli nie rozumiesz".
- **Niskie**: race condition jeśli ktoś jednoczesnie adoptuje i edytuje. Mongo upsert jest atomiczny, więc ostatni wygrywa.

### Rollback
Manualnie w Mongo: `db.automation_requests.deleteOne({automationId: 'X'})` cofa adoption.

---

## P6 — Webhook-trigger fallback w `test_workflow real_credentials`

### Cel
Skoro `executeWorkflow` (`/api/v1/workflows/{id}/run`) zwraca 404 na n8n Community, dla workflow z webhook trigger zbuduj URL i wyślij payload przez `triggerWebhook` (publiczny `/webhook/{path}`). Pozwoli to przetestować "real_credentials" bez paid n8n.

### Zmiany w plikach

#### 6.1 `src/mastra/tools/architect/testing/test-workflow.ts`
Linia 199-234 — sekcja `mode === 'real_credentials'`. Po nieudanym `executeWorkflow`:
1. **Przed** istniejącym fallbackiem "fetch latest execution", dodaj webhook-trigger fallback:
   ```ts
   const webhookNode = workflow.nodes?.find((n: any) => n?.type === 'n8n-nodes-base.webhook' || n?.type === 'n8n-nodes-base.webhookTrigger');
   if (webhookNode) {
     const path = webhookNode.parameters?.path;
     const httpMethod = String(webhookNode.parameters?.httpMethod ?? 'POST').toUpperCase();
     const auth = webhookNode.parameters?.authentication ?? 'none';
     if (!path) {
       findings.push({ severity: 'error', message: 'Webhook trigger has empty path — cannot construct test URL.' });
     } else if (auth !== 'none') {
       findings.push({ severity: 'warning', message: `Webhook has authentication=${auth}. Skipping webhook-trigger fallback (cannot inject auth in test). Use manual mode.` });
     } else {
       try {
         const baseUrl = topology.n8nPublicWebhookBaseUrl ?? topology.n8nRestBaseUrl;
         const triggerResult = await n8n.triggerWebhook(path, context.payload ?? mock.payload);
         // n8n returns "execution registered" but not always executionId; need to fetch latest.
         await sleep(1500);
         const recent = await n8n.getExecutions({ workflowId, limit: 3 });
         const newest = recent.find((e: any) => new Date(e.startedAt ?? 0).getTime() > Date.now() - 30_000);
         if (newest) {
           execution = await n8n.getExecution(newest.id).catch(() => null);
           executionId = newest.id;
         }
       } catch (whErr) {
         findings.push({ severity: 'warning', message: `Webhook trigger failed: ${(whErr as Error).message}` });
       }
     }
   }
   ```
2. Jeśli webhookNode + execution nie znalezione, padaj na istniejący fallback "latest execution".

#### 6.2 `src/mastra/tools/architect/testing/test-workflow.ts` — schema
Dodaj input field opcjonalny `webhookOverridePath?: string` (jeśli workflow ma kilka webhook nodów albo path jest dynamiczny, agent może podać explicit).

#### 6.3 `src/mastra/tools/n8n/client.ts`
`triggerWebhook` (linia 50-69) — dodaj support dla httpMethod (currently zawsze POST):
```ts
async triggerWebhook(path: string, data: any, opts?: { method?: string }): Promise<any> {
  const method = (opts?.method ?? 'POST').toUpperCase();
  const url = `${this.baseUrl}/webhook/${path}`;
  // ... fetch z method, dla GET przekaz data jako query string ...
}
```
Optional — jeśli wszystkie webhooki są POST, można pominąć.

### Nowe pliki
Brak.

### ENV
Brak.

### Test plan
1. Unit: dla workflow z webhook trigger path="test-x" auth=none, mock executeWorkflow (rzuca 404), sprawdź że test-workflow woła triggerWebhook z poprawnym path.
2. E2E: deploy webhook-validate-respond (active=true), wywołaj `test_workflow` mode=real_credentials → fallback wysyła POST → execution found → `passed`.
3. Edge: workflow z webhook auth=basicAuth → fallback skip z warning, padaj na latest execution fallback.
4. Edge: workflow ma 2 webhook nodes (rare) → użyj pierwszego, log warning że jest >1.

### Ryzyko
- **Niskie-średnie**: webhook może wywołać side effects (Telegram message, DB write) przy każdym teście. Mitigacja: ten sam mechanizm `X-Mastra-Smoke-Test: true` header co w P2. Pattern builders mogą early-return jeśli widzą ten header.
- **Niskie**: race condition na getExecutions — może zwrócić nie tę execution. Mitigacja: filtrujemy po `startedAt > now - 30s` i `workflowId`. Ryzyko false-match minimalne.

### Rollback
Usunięcie nowego bloku — fallback wraca do "latest execution".

---

## Cross-cutting

### `.env.example` — pełen patch (skumulowane z P1 + P4)
```
# Risk gates (P1)
AUTOMATION_RISK_REVIEW_THRESHOLD=40
AUTOMATION_RISK_BLOCK_THRESHOLD=80

# Smoke test (P2)
AUTOMATION_SMOKE_TEST_TIMEOUT_MS=30000

# Extended credentials (P4) — wszystko opcjonalne
N8N_CREDENTIAL_SLACK_ID=
N8N_CREDENTIAL_SLACK_NAME=Slack
N8N_CREDENTIAL_SLACK_TYPE=slackApi
N8N_CREDENTIAL_DISCORD_ID=
N8N_CREDENTIAL_DISCORD_NAME=Discord
N8N_CREDENTIAL_DISCORD_TYPE=discordWebhookApi
N8N_CREDENTIAL_POSTGRES_ID=
N8N_CREDENTIAL_POSTGRES_NAME=Postgres
N8N_CREDENTIAL_OPENAI_ID=
N8N_CREDENTIAL_OPENAI_NAME=OpenAI
N8N_CREDENTIAL_NOTION_ID=
N8N_CREDENTIAL_NOTION_NAME=Notion
N8N_CREDENTIAL_GITHUB_ID=
N8N_CREDENTIAL_GITHUB_NAME=GitHub
N8N_CREDENTIAL_GITHUB_TYPE=githubApi
N8N_CREDENTIAL_AIRTABLE_ID=
N8N_CREDENTIAL_AIRTABLE_NAME=Airtable
N8N_CREDENTIAL_AIRTABLE_TYPE=airtableTokenApi
```

### Mongo schema — nowe pola
- `automation_requests.firstRun` (P2): `{ status, executionId?, at, triggerType }`
- `automation_requests.adoptedAt` (P5): Date
- `automation_requests.previousManagedBy` (P5): string
- `automation_events` typy do dodania: `first_run_smoke`, `tunnel_refresh`, `adopted`

Brak migracji wymaganej (Mongo schemaless, indeksy nie są dotknięte).

### Audit jako single source of truth
Po wdrożeniu wszystkich punktów `automation_events` powinien zawierać event types: `test_run`, `repair_attempt`, `first_run_smoke`, `tunnel_refresh`, `adopted`. Warto rozważyć dashboard w Studio który pokazuje per `automationId` timeline tych zdarzeń (poza scope tego planu, ale następny krok).

### Aktualizacja `prompts/automation/base.md` — finalna wersja Golden Path
Po wdrożeniu wszystkich punktów Golden Path rozrasta się z 14 do ~17 kroków:
- 14 → activate (z `mode: 'auto_low_risk'` jeśli low-risk)
- 15 (NOWY) → przeczytaj `firstRun` z odpowiedzi, jeśli `failed` → repair → ponow deploy → ponow activate (`runSmokeTest: true`)
- 16 (NOWY) → jeśli `firstRun.status === 'deferred'` → poinformuj uzytkownika kiedy pierwszy run, opcjonalnie dodaj scheduled check
- 17 (NOWY) → jesli `firstRun.status === 'manual_required'` → wygeneruj instrukcje, daj uzytkownikowi sygnal kiedy ma wywolac trigger

Plus dodaj sekcję "Adopcja" (z P5) i "Tunnel refresh" (informacyjna, P3 jest auto).

---

## Effort estimate

| Punkt | Effort | Risk | Order |
|---|---|---|---|
| P1 | 4h (głównie threshold + tryb + testy) | Średni | 1 |
| P3 | 6h (tool + standalone script + integracja shell) | Niski | 2 |
| P5 | 3h (jednoplik tool + golden path) | Średni | 3 |
| P2 | 8h (smoke test wymaga obsługi 3 typów triggerów + edge cases) | Średni-wysoki | 4 |
| P6 | 3h (refactor jednej sekcji test-workflow) | Niski | 5 |
| P4 | 5h (powtarzalne, ale 7 serwisów × 4 miejsca zmian) | Niski | 6 (równolegle) |

**Razem: ~29h (3-4 dni roboczych jednego dewelopera).** Z testami end-to-end zarezerwuj dodatkowy dzień.

## Definition of Done

- [ ] `architect.deploy_automation` workflow z risk_score=30 deployuje się bez approvalToken (P1)
- [ ] `architect.activate_automation { mode: 'auto_low_risk', score<40 }` aktywuje workflow z Telegram node bez approvala, response zawiera `bypassedReasons` (P1)
- [ ] `bun run scripts/refresh-tunnel-workflows.ts <new> <old>` patchuje workflow w n8n; integracja z `n8n-tunnel-up.sh` działa po rotacji (P3)
- [ ] `architect.adopt_workflow {workflowId, confirm: true}` adoptuje workflow utworzony ręcznie (P5)
- [ ] `architect.activate_automation` automatycznie woła smoke test, dla webhook workflow zwraca `firstRun.status === 'passed'` z `executionId` (P2)
- [ ] `architect.test_workflow real_credentials` na webhook workflow działa bez `executeWorkflow` (P6)
- [ ] Workflow z `n8n-nodes-base.slack` deployuje się i ma `credentials.slackApi.id` po `repair_workflow` (P4)
- [ ] Pełen e2e: koncept "monitoruj RSS Engadget i wysyłaj summary do #news na Slacku" → architect przechodzi cały Golden Path bez human approval (po skonfigurowaniu Slack credential w env), workflow jest aktywny i ma firstRun.passed
