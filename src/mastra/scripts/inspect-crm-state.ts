import { getDb } from '../lib/mongo.js';

async function main() {
  const db = await getDb();
  console.log('Database name:', db.databaseName);
  const collections = await db.listCollections().toArray();
  console.log('\nCollections:');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`  - ${col.name}: ${count} documents`);
  }

  // Inspect leads specifically
  const leadsCol = db.collection('leads');
  const leads = await leadsCol.find({}).toArray();
  console.log(`\nTotal leads found: ${leads.length}`);
  for (const lead of leads.slice(0, 10)) {
    console.log(`  * [${lead.segment || 'no-seg'}] ${lead.companyName || lead.contactName || lead.id} (${lead.status}) - ${lead.email || 'no email'}`);
  }
  if (leads.length > 10) {
    console.log(`  ... and ${leads.length - 10} more leads`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error inspecting CRM:', err);
  process.exit(1);
});
