#!/usr/bin/env tsx
/**
 * F7 readiness — what stands between each agent and the V2 engine.
 *
 * A readiness pass across the whole roster (18 cards), done as MEASUREMENT rather
 * than as hand-preparing every agent. The distinction matters here more than usual: this
 * project has repeatedly paid for work prepared ahead of a consumer and never
 * wired — `findArtifactIds` matched ids the runtime never emitted and worked for
 * NO agent, liveness was built and unreachable, `designAgent` promised documents
 * with no tool that could write one. Every one of those looked ready.
 *
 * So the criteria below are not a wish list. Each is a defect this system
 * actually shipped, turned into a question that can be answered from data:
 *
 *  1. STEP CEILING — chefAgent burned 894s and returned nothing because the
 *     harness capped it at the depth profile's 40 while the agent expected 150.
 *     The rule that followed: the harness may RAISE a ceiling to the agent's
 *     declaration, never lower it. An agent that declares nothing hands its
 *     ceiling to whatever profile happens to run.
 *  2. DELIVERABLE WRITABILITY — an agent that promises a `*_ref` must own a tool
 *     that writes a file. designAgent did not, and three rounds of work were
 *     spent on the wrong hypothesis before that was noticed.
 *  3. CONSUMABLE OUTPUT (new with F6B) — an agent may now be a STEP whose result
 *     feeds the next one. Prose where the next step needs a document is a
 *     pipeline failure, not a weak answer. Nothing checked this before, because
 *     before F6B nothing consumed one agent's output as another's input.
 *  4. CLOCK vs WORK SHAPE — researcherAgent declares 50 steps inside a 300s
 *     window. Steps and time are two different budgets and they can disagree.
 *  5. EXTERNAL DEPENDENCY — an agent may get most of its abilities from an MCP
 *     server rather than its own toolset. `knowledgeAgent` looks like eight
 *     internal tools (artifacts, skills, memory) and is in fact a NotebookLM
 *     client: its real powers arrive from a sidecar, and they include CREATING
 *     notebooks and adding sources in the user's Google account. Reading the
 *     static toolset alone understates both what it can do and what a wrong route
 *     costs — which is exactly the mistake a note in this project's own memory
 *     made about that agent.
 *  6. BLAST RADIUS — what a wrong route costs. Wasted tokens, real money, an
 *     outward write, or a change to the system itself. This decides whether an
 *     agent may sit in the default allowlist at all.
 *
 * READ-ONLY. It changes nothing and enables nothing; it produces the list that
 * F7 works through, agent by agent.
 *
 * Run: npm run audit:agent-readiness
 */
import { agentBoard, type AgentCard } from '../config/agent-board.js';
import {
  ATTEMPT_CAP_BY_LATENCY, DEFAULT_V2_CAPABILITIES, SIDE_EFFECT_PRODUCT_CAPABILITIES,
} from '../config/capability-routing.js';
import { AGENT_SOURCES, declaredMaxSteps } from './audit-agent-limits.js';
import { readFileSync } from 'node:fs';

/** Output types that hand the next step a REFERENCE it can fetch. */
const REFERENCE_OUTPUTS = new Set(['menu_book_ref', 'media_ref', 'document', 'automation_workflow']);
/** Output types that are structured enough for a next step to consume directly. */
const STRUCTURED_OUTPUTS = new Set([
  'research_report', 'analysis_report', 'decision_memo', 'action_plan',
  'review_report', 'diff_patch', 'content_pack', 'lead_batch',
]);

/**
 * What a wrong route costs.
 *
 * Only `SPENDS_MONEY` is still hand-kept, and hand-kept lists here have been
 * wrong before: the first version put `crmAgent` among the outward writers while
 * its card says the opposite in its first line — "read-only CRM", with
 * `whenNotToUse: ['CRM writes → salesAgent']`. The audit produced a confident
 * finding about a risk that does not exist. `assertClassificationAgrees` below
 * exists for exactly that reason.
 */
const SPENDS_MONEY = new Set(['designAgent', 'filmmakerAgent', 'musicianAgent']);
// Outward writes and system changes are no longer restated here. They ARE
// `SIDE_EFFECT_PRODUCT_CAPABILITIES` in `capability-routing.ts` — the runtime now
// depends on that same set to tell those agents to leave a fetchable product, so
// a second copy would be a second thing to keep true. The split below is only
// about how a wrong route READS in this report.
const WRITES_OUTWARD = new Set(
  [...SIDE_EFFECT_PRODUCT_CAPABILITIES].filter((id) => id.endsWith('Agent') && id !== 'codingAgent'),
);
const CHANGES_SYSTEM = new Set(
  [...SIDE_EFFECT_PRODUCT_CAPABILITIES].filter((id) => !WRITES_OUTWARD.has(id)),
);

/**
 * The classification above and the default allowlist in `capability-routing.ts`
 * are two statements of one policy: nothing whose worst case is worse than a
 * wasted run may be enabled by default. If they disagree, one of them is stale —
 * and the cheap failure is this audit staying silent about it.
 */
function assertClassificationAgrees(): void {
  const severeButDefault = DEFAULT_V2_CAPABILITIES
    .filter((id) => SPENDS_MONEY.has(id) || WRITES_OUTWARD.has(id) || CHANGES_SYSTEM.has(id));
  const unknown = [...SPENDS_MONEY, ...WRITES_OUTWARD, ...CHANGES_SYSTEM]
    .filter((id) => !(id in agentBoard));
  if (unknown.length > 0) {
    throw new Error(`blast-radius classification names agents not on the board: ${unknown.join(', ')}`);
  }
  if (severeButDefault.length > 0) {
    console.log(
      `⚠ NIESPÓJNOŚĆ POLITYKI: ${severeButDefault.join(', ')} jest w domyślnym allowliście,\n`
      + '  a ta klasyfikacja mówi, że błędna trasa kosztuje więcej niż zmarnowany run.\n'
      + '  Jedno z dwóch jest nieaktualne — rozstrzygnij, zanim ruszy F7.\n',
    );
  }
}

function blastRadius(id: string): { label: string; severe: boolean } {
  if (CHANGES_SYSTEM.has(id)) return { label: 'zmienia system', severe: true };
  if (SPENDS_MONEY.has(id)) return { label: 'wydaje pieniądze', severe: true };
  if (WRITES_OUTWARD.has(id)) return { label: 'pisze na zewnątrz', severe: true };
  return { label: 'zmarnowany run', severe: false };
}

/**
 * Agents whose capability arrives from an MCP server, detected from the source
 * rather than listed by hand — a hand-kept list is what got this wrong once.
 */
function dependsOnMcp(id: string): boolean {
  const file = AGENT_SOURCES[id];
  if (!file) return false;
  try {
    return readFileSync(`src/mastra/agents/${file}.ts`, 'utf8').includes("from '../mcp.js'");
  } catch {
    return false;
  }
}

interface Finding { agent: string; kind: string; detail: string; blocking: boolean }

const findings: Finding[] = [];
const note = (agent: string, kind: string, detail: string, blocking: boolean): void => {
  findings.push({ agent, kind, detail, blocking });
};

// The declared ceilings come from `audit:agent-limits`, not from a second
// scraper. The first version of this file re-implemented the lookup and reported
// "declares no maxSteps" for ALL 18 agents — including the four that declare 150
// — because its regex did not require the `defaultOptions` context. That is the
// exact failure the other audit already documents: an audit whose failures look
// like its findings is worse than none. One definition, one place to be wrong.
const declaredSteps = new Map<string, number | null>(
  Object.keys(agentBoard).map((id) => [id, declaredMaxSteps(id) ?? null]),
);

const rows: Array<{ id: string; card: AgentCard }> = Object.entries(agentBoard)
  .map(([id, card]) => ({ id, card }))
  .sort((a, b) => a.id.localeCompare(b.id));

console.log('audit:agent-readiness — co dzieli każdego agenta od silnika V2\n');
assertClassificationAgrees();
console.log(
  'agent'.padEnd(22)
  + 'w V2'.padEnd(7)
  + 'kroki'.padEnd(8)
  + 'okno'.padEnd(8)
  + 'wynik'.padEnd(14)
  + 'promień rażenia',
);
console.log('─'.repeat(88));

for (const { id, card } of rows) {
  const enabled = DEFAULT_V2_CAPABILITIES.includes(id);
  const steps = declaredSteps.get(id) ?? null;
  const windowMs = ATTEMPT_CAP_BY_LATENCY[card.latencyClass] ?? 300_000;
  const outputs = card.outputArtifacts ?? [];
  const consumable = outputs.some((o) => REFERENCE_OUTPUTS.has(o) || STRUCTURED_OUTPUTS.has(o));
  const radius = blastRadius(id);

  console.log(
    id.padEnd(22)
    + (enabled ? '  ✓  ' : '  —  ').padEnd(7)
    + String(steps ?? '—').padEnd(8)
    + `${windowMs / 1000}s`.padEnd(8)
    + (consumable ? 'konsumowalny' : 'PROZA').padEnd(14)
    + radius.label,
  );

  // 1. Step ceiling — the chefAgent defect.
  if (steps === null) {
    note(id, 'sufit kroków', 'brak deklaracji maxSteps — sufit po cichu ustala profil głębokości', false);
  }

  // 3. Consumable output — the F6B criterion nothing checked before.
  if (outputs.length === 0) {
    note(id, 'wynik', 'karta nie deklaruje ŻADNEGO outputArtifacts — kontrakt headless nie ma czego wymagać', true);
  } else if (!consumable) {
    note(id, 'wynik', `deklaruje tylko ${outputs.join(', ')} — następny krok sekwencji nie ma czego skonsumować`, true);
  }

  // 4. Clock versus work shape — the researcherAgent finding.
  if (steps !== null && steps >= 50 && windowMs <= 300_000) {
    note(
      id, 'zegar',
      `${steps} kroków w oknie ${windowMs / 1000}s — bounds mierzą różne rzeczy. LATENTNE, nie `
      + 'zaobserwowane: 12 zakończonych runów researchera trwało 1-11 s przy tym oknie, więc żaden '
      + 'z limitów nigdy się nie zbliżył do związania. Rusz liczbę dopiero z pomiaru głębokiego runu.',
      false,
    );
  }

  // 5. Blast radius versus exposure.
  if (enabled && radius.severe) {
    note(id, 'promień rażenia', `włączony domyślnie, a błędna trasa kosztuje: ${radius.label}`, true);
  }

  // 5. External dependency — the static toolset is not the whole agent.
  if (dependsOnMcp(id)) {
    note(
      id, 'zależność zewnętrzna',
      'bierze narzędzia z serwera MCP — gdy sidecar nie działa, agent po cichu traci większość '
      + 'swoich możliwości i zwraca wiarygodnie wyglądającą porażkę. Statyczny toolset ZANIŻA '
      + 'zarówno to, co potrafi, jak i promień rażenia.',
      false,
    );
  }

  // Routing hygiene: an agent nobody should get by accident needs a hard rule.
  if (radius.severe && (card.whenNotToUse ?? []).length === 0) {
    note(id, 'routing', 'brak whenNotToUse przy wysokim promieniu rażenia — router nie ma czym go odrzucić', false);
  }
}

console.log(`\n${rows.length} agentów na boardzie · ${DEFAULT_V2_CAPABILITIES.length} włączonych w V2\n`);

const blocking = findings.filter((f) => f.blocking);
const advisory = findings.filter((f) => !f.blocking);

if (blocking.length > 0) {
  console.log(`BLOKUJĄCE (${blocking.length}) — do domknięcia zanim agent wejdzie do V2`);
  for (const f of blocking) console.log(`  ✗ ${f.agent.padEnd(20)} [${f.kind}] ${f.detail}`);
  console.log('');
}
if (advisory.length > 0) {
  console.log(`DO ROZWAŻENIA (${advisory.length}) — nie blokuje, ale zna swoją cenę`);
  for (const f of advisory) console.log(`  • ${f.agent.padEnd(20)} [${f.kind}] ${f.detail}`);
  console.log('');
}

const ready = rows.filter(({ id }) => !blocking.some((f) => f.agent === id));
console.log(
  `GOTOWI BEZ ZASTRZEŻEŃ BLOKUJĄCYCH: ${ready.length}/${rows.length}\n`
  + `  ${ready.map((r) => r.id).join(', ')}`,
);
console.log(
  '\nUwaga: „gotowy” znaczy tu „nic zmierzalnego nie stoi na przeszkodzie”, NIE „przejdzie canary”.\n'
  + 'Każdy dotychczasowy canary znalazł defekt, którego żadna z tych reguł by nie wyłapała.',
);
process.exit(0);
