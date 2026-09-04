import { closeDb } from '../lib/mongo.js';
import { scorePairing, suggestPartners } from '../tools/chef/flavor-service.js';

async function main() {
  for (const [a, b, cuisine] of [
    ['tomato', 'basil', 'italian'],
    ['tomato', 'basil', 'japanese'],
    ['beef', 'mushroom', 'french'],
    ['beef', 'banana', 'european'],
  ] as Array<[string, string, string]>) {
    const s = await scorePairing(a, b, { cuisine });
    console.log(`${a}+${b} [${cuisine}] matched=${s.matched} shared=${s.shared} jaccard=${s.jaccard.toFixed(3)} verdict=${s.verdict} axis=${s.axis}`);
  }
  const p = await suggestPartners('lamb', { cuisine: 'mediterranean', limit: 5 });
  console.log('lamb partners:', p.matched, p.partners.map((x) => `${x.name}(${x.shared})`).join(', '));
}
main().catch((e) => console.error(e)).finally(closeDb);
