#!/usr/bin/env tsx
/**
 * (Re)create the two daily job-hunter chains: research at 08:00, drafts 30
 * minutes later.
 *
 * The previous version of this script wrote `nextStep` into Mongo with a raw
 * `$set`. That skipped `createScheduledTask`, and with it the validation that
 * would have rejected a chain step carrying no fire time. Nothing failed at
 * write time; the chain failed a day later, mid-run, in a place where the
 * failure could not be recorded — both schedules ran exactly once and died
 * green. So this goes through the store, like every other caller.
 *
 * Dry run by default — pass --apply to write.
 *
 *   npx tsx src/mastra/scripts/update-job-hunter-schedules.ts
 *   npx tsx src/mastra/scripts/update-job-hunter-schedules.ts --apply
 *
 * NOTE: applying this arms real outreach. The chain's second step creates Gmail
 * drafts. Dedupe (`crm_create_lead` with `skipIfEngaged`) must be in place
 * first, or every morning re-applies to the companies already contacted.
 */
import { getDb, closeDb } from '../lib/mongo.js';
import {
  createScheduledTask,
  SCHEDULED_TASKS_COLLECTION,
  type CreateScheduledTaskInput,
} from '../services/scheduled-task-store.js';

const apply = process.argv.includes('--apply');

/** 30 minutes, measured from the moment the research step finishes. */
const DRAFT_STEP_DELAY_MS = 30 * 60 * 1000;

const chains: CreateScheduledTaskInput[] = [
  {
    cronExpression: '0 8 * * *',
    timezone: 'Atlantic/Reykjavik',
    targetType: 'AGENT',
    targetIdentifier: 'researcherAgent',
    chainName: 'daily-poland-ai-job-hunter',
    stepName: 'scan-and-match-poland',
    idempotencyKey: 'daily-poland-ai-job-scan-8am',
    promptOrInstruction: `Codzienne skanowanie polskiego rynku pracy AI (skill: poland-ai-agentic-job-hunter).
1. Przeskanuj polskie portale (Just Join IT, No Fluff Jobs, Pracuj.pl, LinkedIn public, theprotocol.it, Bulldogjob) oraz firmy z watchlisty Tier A/B pod kątem ról Agentic AI / AI Solutions Engineer.
2. Przeprowadź deduplikację, scoring (0-100), oznacz Strategic Entry oraz wzbogać kontakty rekrutacyjne.
3. Dla ofert zakwalifikowanych ze scorem >= 65 sprawdź w CRM (crm_search_leads po adresie rekrutacyjnym), czy już do nich pisaliśmy:
   - lead ze statusem innym niż research_needed / research_enriched → POMIŃ ofertę, ustaw w JOB_STATE application_status = "applied" i policz ją jako pominiętą,
   - brak leada lub status researchowy → oferta z publicznym emailem trafia do paczki JSON QUALIFIED_JOBS_PAYLOAD dla kroku 2 (marketingAgent).
4. Oferty WYŁĄCZNIE z formularzem portalowym zapisz do pliku oferty-portalowe-[DATA].md z gotowymi Cover Notes.
5. Zapisz pełny rejestr przez write_external_project_file: projectName "poland-ai-job", relativePath "poland-ai-job-opportunities.md" (plik ląduje w /projekty/splot-projects/projects/poland-ai-job/).
6. W podsumowaniu podaj liczbę ofert pominiętych jako "już w CRM".`,
    nextStep: {
      targetType: 'AGENT',
      targetIdentifier: 'marketingAgent',
      stepName: 'draft-and-crm-ingestion-poland',
      delayMs: DRAFT_STEP_DELAY_MS,
      promptOrInstruction: `Przetwarzanie wsadowe ofert rekrutacyjnych i utworzenie draftów w Gmailu oraz wpisów w CRM (skill: career-application-it-gastro).
1. Pobierz paczkę QUALIFIED_JOBS_PAYLOAD z kontekstu poprzedniego kroku (albo z /projekty/splot-projects/projects/poland-ai-job/poland-ai-job-opportunities.md).
2. Dla KAŻDEJ oferty z emailem wywołaj crm_create_lead z segmentem career_it_pl, statusem draft_gotowy ORAZ skipIfEngaged: true.
   - action "skipped" → firma ma już draft lub dostała maila: NIE twórz draftu w Gmailu, dopisz do listy pominiętych.
   - action "created"/"updated" → utwórz draft w Gmailu (konto personal: candidate@example.com) z plikami CV/Cover Letter (PL/EN) i tagiem [Kariera IT - PL], potem crm_record_email_draft.
3. Wyślij podsumowanie na Telegram (utworzone / pominięte z powodem / portalowe) i załącz plik ofert portalowych przez telegram_send_file.`,
    },
  },
  {
    cronExpression: '0 8 * * *',
    timezone: 'Atlantic/Reykjavik',
    targetType: 'AGENT',
    targetIdentifier: 'researcherAgent',
    chainName: 'daily-iceland-job-hunter',
    stepName: 'scan-and-match-iceland',
    idempotencyKey: 'daily-iceland-job-scan-8am',
    promptOrInstruction: `Codzienne skanowanie islandzkiego rynku pracy (skill: iceland-job-hunter).
1. Przeskanuj islandzkie portale (Alfred.is, Tvinna, Storf.is, Starfatorg, HH.is) pod kątem profili: AI Solutions Engineer oraz Hospitality / Gastro.
2. Przeprowadź deduplikację, scoring dopasowania (0-100) oraz wzbogać kontakty rekrutacyjne.
3. Dla ofert zakwalifikowanych ze scorem >= 65 sprawdź w CRM (crm_search_leads po adresie rekrutacyjnym), czy już do nich pisaliśmy:
   - lead ze statusem innym niż research_needed / research_enriched → POMIŃ ofertę, ustaw w JOB_STATE application_status = "applied" i policz ją jako pominiętą,
   - brak leada lub status researchowy → oferta z publicznym emailem trafia do paczki JSON QUALIFIED_JOBS_PAYLOAD dla kroku 2 (marketingAgent).
4. Oferty WYŁĄCZNIE z formularzem portalowym zapisz do pliku oferty-portalowe-[DATA].md z gotowymi Cover Notes w j. angielskim.
5. Zapisz pełny rejestr przez write_external_project_file: projectName "alfred-job", relativePath "alfred-job-opportunities.md" (plik ląduje w /projekty/splot-projects/projects/alfred-job/).
6. W podsumowaniu podaj liczbę ofert pominiętych jako "już w CRM".`,
    nextStep: {
      targetType: 'AGENT',
      targetIdentifier: 'marketingAgent',
      stepName: 'draft-and-crm-ingestion-iceland',
      delayMs: DRAFT_STEP_DELAY_MS,
      promptOrInstruction: `Przetwarzanie wsadowe ofert rekrutacyjnych z Islandii i utworzenie draftów w Gmailu oraz wpisów w CRM (skill: career-application-it-gastro).
1. Pobierz paczkę QUALIFIED_JOBS_PAYLOAD z kontekstu poprzedniego kroku (albo z /projekty/splot-projects/projects/alfred-job/alfred-job-opportunities.md).
2. Dla KAŻDEJ oferty z emailem wywołaj crm_create_lead z segmentem career_it_is lub career_chef_is, statusem draft_gotowy ORAZ skipIfEngaged: true.
   - action "skipped" → firma ma już draft lub dostała maila: NIE twórz draftu w Gmailu, dopisz do listy pominiętych.
   - action "created"/"updated" → utwórz draft w Gmailu (konto personal: candidate@example.com) z odpowiednimi PDF (IT lub Gastro) i tagiem [Career IT - IS] / [Career Chef - IS], potem crm_record_email_draft.
3. Wyślij podsumowanie na Telegram (utworzone / pominięte z powodem / portalowe) i załącz plik ofert portalowych przez telegram_send_file.`,
    },
  },
];

async function run(): Promise<void> {
  const db = await getDb();
  const collection = db.collection(SCHEDULED_TASKS_COLLECTION);

  for (const chain of chains) {
    const existing = await collection
      .find({ chainName: chain.chainName })
      .project({ taskId: 1, status: 1, chainId: 1, 'schedule.fireAt': 1 })
      .sort({ createdAt: 1 })
      .toArray();

    const live = existing.filter((t) =>
      ['scheduled', 'leased', 'running'].includes(t.status as string));

    console.log(`\n── ${chain.chainName} ──`);
    console.log(`  istniejące wystąpienia: ${existing.length} (żywe: ${live.length})`);
    for (const t of existing) {
      console.log(`    ${t.status} · ${t.taskId} · ${t.schedule?.fireAt?.toISOString?.() ?? '-'}`);
    }

    if (live.length > 0) {
      console.log('  ⚠️  Łańcuch ma żywe wystąpienie — pomijam, żeby nie zdublować harmonogramu.');
      console.log('      Anuluj je najpierw (cancel_scheduled_task) albo usuń ręcznie.');
      continue;
    }

    if (!apply) {
      console.log(`  (dry-run) utworzyłbym: cron "${chain.cronExpression}" ${chain.timezone}`);
      console.log(`            krok 2: ${chain.nextStep?.targetIdentifier} +${(chain.nextStep?.delayMs ?? 0) / 60000} min`);
      continue;
    }

    // Kontynuujemy istniejący chainId zamiast zakładać nowy.
    //
    // `findStoppedRecurrences` pyta PER CHAIN: „czy ten łańcuch ma jeszcze
    // jakieś wystąpienie scheduled/leased/running?". Nowy chainId zostawiłby
    // stary, martwy łańcuch bez następcy na zawsze — a to znaczy alarm o
    // zatrzymanym harmonogramie co godzinę, już nieprawdziwy, przez resztę
    // życia bazy. Fałszywy alarm, którego nie da się wyciszyć, uczy ignorowania
    // kanału; to gorsze niż brak alarmu.
    const previousChainId = existing.find((t) => t.chainId)?.chainId as string | undefined;
    const task = await createScheduledTask(
      previousChainId ? { ...chain, chainId: previousChainId } : chain,
    );
    if (previousChainId) {
      console.log(`  ↳ kontynuuje istniejący chainId ${previousChainId}`);
    }
    console.log(`  ✅ utworzono ${task.taskId} · pierwszy przebieg ${task.schedule.fireAt?.toISOString()}`);
    console.log(`     krok 2: ${chain.nextStep?.targetIdentifier} +${(chain.nextStep?.delayMs ?? 0) / 60000} min po zakończeniu kroku 1`);
  }

  console.log(
    apply
      ? '\nGotowe. Sprawdź zakładkę Scheduler — oba łańcuchy powinny być "scheduled".'
      : '\nDry run. Uruchom z --apply, żeby faktycznie włączyć codzienny harmonogram.',
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
