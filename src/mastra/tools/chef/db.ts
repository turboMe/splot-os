/**
 * Chef DB helper — delegates to shared mongo singleton.
 * Kept as separate file so chef-service.ts can import without changing its own imports.
 */
import type { Db } from 'mongodb';
import { getDb as getSharedDb } from '../../lib/mongo';

export async function getDb(): Promise<Db> {
  return getSharedDb();
}

export async function ensureChefIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('chef_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_menus').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_menus').createIndex({ projectId: 1, version: -1 }),
    db.collection('chef_recipes').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_recipes').createIndex({ projectId: 1, dishName: 1 }),
    db.collection('chef_notes').createIndex({ type: 1, topic: 1 }),
    db.collection('chef_notes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true }),
    // Personal recipe library (system-of-record for the chef's own repertoire).
    // Embeddings persist here; retrieval is hybrid (in-memory cosine + $text + RRF).
    db.collection('chef_recipe_library').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_recipe_library').createIndex({ category: 1 }),
    db.collection('chef_recipe_library').createIndex({ type: 1 }),
    db.collection('chef_recipe_library').createIndex({ 'provenance.extractionConfidence': 1 }),
    // Lexical leg of hybrid retrieval — exact-name matches vectors sometimes miss.
    db.collection('chef_recipe_library').createIndex(
      { name: 'text', aliases: 'text', searchKeywords: 'text', 'ingredients.name': 'text' },
      { name: 'recipe_library_text' },
    ),
    // FlavorDB reasoning layer (reference chemistry; never pollutes chef_recipe_library).
    // Loaded once by scripts/load-flavordb.ts; read into a lazy in-memory index by
    // tools/chef/flavor-service.ts. nameEmbedding persists for the cross-lingual resolver.
    db.collection('chef_flavor_ingredients').createIndex({ entityId: 1 }, { unique: true }),
    db.collection('chef_flavor_ingredients').createIndex({ name: 1 }),
    db.collection('chef_flavor_ingredients').createIndex(
      { name: 'text', synonyms: 'text' },
      { name: 'flavor_ingredients_text' },
    ),
    db.collection('chef_flavor_molecules').createIndex({ pubchemId: 1 }, { unique: true }),
    // Cross-lingual chef-name → FlavorDB entity resolution cache (build-flavor-aliases.ts).
    db.collection('chef_flavor_aliases').createIndex({ chefName: 1 }, { unique: true }),
  ]);
}
