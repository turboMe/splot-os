import 'dotenv/config';
const { getDb } = await import('../lib/mongo.js');
const { queryAgentEvents } = await import('../lib/agent-event-log.js');
const db = await getDb();

// Latest chef project (the live run's project).
const proj = await db.collection('chef_projects').find({}).sort({ updatedAt: -1 }).limit(1).toArray();
const p = proj[0];
console.log(`[observe] project: ${p?.businessName ?? p?.name ?? '?'} | status=${p?.status} | updatedAt=${p?.updatedAt}`);

// Phase transitions emitted so far (last 2h) — CHEF ONLY (filter by agentId to
// avoid mixing concurrent runs from other agents / the dashboard).
const since = new Date(Date.now() - 2 * 3600_000);
const tr = await queryAgentEvents({ type: 'pipeline_phase_transition', agentId: 'chefAgent', since, limit: 50 });
console.log(`[observe] phase transitions (${tr.length}): ` +
  tr.map((e) => (e as { data?: { phase?: string } }).data?.phase).join(' → '));

const iv = await queryAgentEvents({ type: 'pipeline_reflector_intervention', agentId: 'chefAgent', since, limit: 50 });
console.log(`[observe] reflector interventions: ${iv.length}`);
for (const e of iv.slice(0, 5)) console.log(`   • ${JSON.stringify((e as { data?: unknown }).data)}`);

// Recipe / menu progress from DB.
if (p?.id) {
  const recipes = await db.collection('chef_recipes').countDocuments({ projectId: p.id }).catch(() => -1);
  const menus = await db.collection('chef_menus').countDocuments({ projectId: p.id }).catch(() => -1);
  console.log(`[observe] menus=${menus} recipes=${recipes}`);
}
process.exit(0);
