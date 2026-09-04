import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotebookLMClient } from './notebooklm-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STARTER_PACKS_DIR = path.resolve(__dirname, '../../knowledge/starter-packs');

export const knowledgeBootstrapTool = createTool({
  id: 'knowledge_bootstrap_account',
  description: 'Initializes and seeds required Google NotebookLM notebooks from starter packs for content, culinary, and business domains.',
  inputSchema: z.object({
    projectName: z.string().describe('Name of the company or project (e.g. "Flowmint AI", "GastroBridge", "Acme")'),
    packs: z.array(z.enum(['content-strategy', 'chef-culinary', 'business'])).default(['content-strategy', 'chef-culinary', 'business']).describe('Which knowledge packs to bootstrap'),
    language: z.enum(['pl', 'en']).default('pl').describe('Language for onboarding instructions and communication'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    createdNotebooks: z.array(z.object({
      title: z.string(),
      id: z.string(),
      sourcesAdded: z.number(),
    })),
    existingNotebooksKept: z.array(z.string()),
    userInstructions: z.string(),
    summary: z.string(),
  }),
  execute: async ({ projectName, packs, language }) => {
    const client = new NotebookLMClient();
    const createdNotebooks: Array<{ title: string; id: string; sourcesAdded: number }> = [];
    const existingNotebooksKept: string[] = [];

    // 1. Fetch current live notebooks on the account
    let liveNotebooks: Array<{ id: string; title: string }> = [];
    try {
      liveNotebooks = await client.listNotebooks();
    } catch (err) {
      // If client list fails, proceed with empty set
      console.warn('[knowledge_bootstrap_account] Could not list existing notebooks:', (err as Error).message);
    }

    const liveTitlesMap = new Map<string, string>();
    for (const nb of liveNotebooks) {
      liveTitlesMap.set(nb.title.toLowerCase().trim(), nb.id);
    }

    const selectedPacks = packs ?? ['content-strategy', 'chef-culinary', 'business'];

    // 2. Bootstrap Content Strategy Pack
    if (selectedPacks.includes('content-strategy')) {
      const contentPackPath = path.join(STARTER_PACKS_DIR, 'content-strategy.json');
      if (fs.existsSync(contentPackPath)) {
        const contentPack = JSON.parse(fs.readFileSync(contentPackPath, 'utf8'));
        const title = contentPack.notebookTitle || 'content-strategy';
        const existingId = liveTitlesMap.get(title.toLowerCase().trim());

        if (existingId) {
          existingNotebooksKept.push(title);
        } else {
          try {
            const newId = await client.createNotebook(title);
            let sourcesCount = 0;
            if (Array.isArray(contentPack.sources)) {
              for (const src of contentPack.sources) {
                try {
                  if (src.url) {
                    await client.addSource({ notebook: newId, sourceType: 'url', url: src.url });
                    sourcesCount++;
                  } else if (src.summary || src.text) {
                    await client.addSource({ notebook: newId, sourceType: 'text', title: src.title, text: src.summary || src.text });
                    sourcesCount++;
                  }
                  // Small delay to respect API rate limits
                  await new Promise((r) => setTimeout(r, 1500));
                } catch {
                  // Ignore individual source add errors
                }
              }
            }
            createdNotebooks.push({ title, id: newId, sourcesAdded: sourcesCount });
          } catch (e) {
            console.error(`[bootstrap] Failed creating ${title}:`, e);
          }
        }
      }
    }

    // 3. Bootstrap Chef Culinary Pack
    if (selectedPacks.includes('chef-culinary')) {
      const chefPackPath = path.join(STARTER_PACKS_DIR, 'chef-culinary-pack.json');
      if (fs.existsSync(chefPackPath)) {
        const chefPack = JSON.parse(fs.readFileSync(chefPackPath, 'utf8'));
        if (Array.isArray(chefPack.notebooks)) {
          for (const nbDef of chefPack.notebooks) {
            const title = nbDef.title;
            const existingId = liveTitlesMap.get(title.toLowerCase().trim());

            if (existingId) {
              existingNotebooksKept.push(title);
            } else {
              try {
                const newId = await client.createNotebook(title);
                let sourcesCount = 0;
                if (Array.isArray(nbDef.sources)) {
                  for (const src of nbDef.sources) {
                    try {
                      if (src.url) {
                        await client.addSource({ notebook: newId, sourceType: 'url', url: src.url });
                        sourcesCount++;
                      } else if (src.summary || src.text) {
                        await client.addSource({ notebook: newId, sourceType: 'text', title: src.title, text: src.summary || src.text });
                        sourcesCount++;
                      }
                      await new Promise((r) => setTimeout(r, 1500));
                    } catch {
                      // Non-blocking source add error
                    }
                  }
                }
                createdNotebooks.push({ title, id: newId, sourcesAdded: sourcesCount });
              } catch (e) {
                console.error(`[bootstrap] Failed creating chef notebook ${title}:`, e);
              }
            }
          }
        }
      }
    }

    // 4. Bootstrap Business Master Notebook
    let businessInstructions = '';
    if (selectedPacks.includes('business')) {
      const businessPackPath = path.join(STARTER_PACKS_DIR, 'business-starter-pack.json');
      let businessPack: any = {};
      if (fs.existsSync(businessPackPath)) {
        businessPack = JSON.parse(fs.readFileSync(businessPackPath, 'utf8'));
      }
      const businessTitle = `${projectName} - Master Knowledge`;
      const existingId = liveTitlesMap.get(businessTitle.toLowerCase().trim());

      if (existingId) {
        existingNotebooksKept.push(businessTitle);
      } else {
        try {
          const newId = await client.createNotebook(businessTitle);
          createdNotebooks.push({ title: businessTitle, id: newId, sourcesAdded: 0 });
        } catch (e) {
          console.error(`[bootstrap] Failed creating business notebook ${businessTitle}:`, e);
        }
      }

      // Generate localized instructions
      if (language === 'pl') {
        businessInstructions = `Zainicjalizowałem notatnik biznesowy dla Twojego projektu: **${businessTitle}**.\n\nAby agenci (marketingAgent, contentAgent, salesAgent, huntAgent) mogli precyzyjnie reprezentować Twoją ofertę, dodaj do tego notatnika swoje pliki PDF, dokumenty ofertowe, cenniki lub link do strony www.`;
      } else {
        businessInstructions = `I have initialized the business knowledge notebook: **${businessTitle}**.\n\nTo allow the agent fleet to accurately understand your products, services, and pricing, please add your PDF brochures, offer documents, pricing sheets, or website URL directly to this notebook.`;
      }
    }

    const summary = language === 'pl'
      ? `Zakończono konfigurację bazy wiedzy. Utworzono ${createdNotebooks.length} nowych notatników, zachowano ${existingNotebooksKept.length} istniejących.`
      : `Knowledge base bootstrap completed. Created ${createdNotebooks.length} new notebooks, kept ${existingNotebooksKept.length} existing.`;

    return {
      ok: true,
      createdNotebooks,
      existingNotebooksKept,
      userInstructions: businessInstructions,
      summary,
    };
  },
});
