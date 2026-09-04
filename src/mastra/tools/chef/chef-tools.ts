import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import { ChefService } from './chef-service';
import { search as searchRecipeLibrary } from './recipe-library-service';
import {
  scorePairing,
  suggestPartners,
  suggestBridges,
  profileForIngredients,
  buildFlavorPalette,
} from './flavor-service';
import { isFlavorPairingEnabled } from '../../config/chef-flags';
import { getNlmClient } from '../knowledge/notebooklm-client';
import { bookPath, replaceSection, menuBookGaps } from './chef-document-tools';
import type { ChefMenu, ChefRecipe } from './chef-service';
import { CHEF_PIPELINE_STATUSES } from './chef-service';
import { putArtifact } from '../../services/artifact-store.js';

const CHEF_NOTEBOOK_IDS = [
  'chef_master', 'chef_flavor', 'chef_texture', 'chef_classic',
  'chef_modern', 'chef_europe', 'chef_asia', 'chef_americas_mena', 'chef_psychology',
] as const;
type ChefNotebookId = typeof CHEF_NOTEBOOK_IDS[number];

// ─── Existing tools (updated) ─────────────────────────────────────────────────

export const chefStartProjectTool = createTool({
  id: 'chef_start_project',
  description: 'Starts a new menu project for a restaurant or event. Creates a questionnaire with missing fields and contextual questions.',
  inputSchema: z.object({
    name: z.string().describe('The name of the project (e.g., "Summer Menu 2025 – Bistro Roma").'),
    establishmentType: z.string().describe('The establishment type: bistro, fine_dining, upscale, casual, food_truck, hotel, event_catering.'),
    eventType: z.string().optional().describe('The event type (if event_catering): wedding, corporate, cocktail, gala, seasonal, private.'),
    cuisineTypes: z.array(z.string()).optional().describe('List of cuisine types, e.g., ["Italian", "Mediterranean"].'),
    serviceFormat: z.string().optional().describe('The service format: a_la_carte, tasting_menu, prix_fixe, buffet, family_style, stations, canape.'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const result = await chef.createProject({
        name: context.name,
        establishmentType: context.establishmentType,
        eventType: context.eventType,
        cuisineTypes: context.cuisineTypes,
        serviceFormat: context.serviceFormat,
      });
      return {
        success: true,
        project: result.project,
        missingFields: result.missingFields,
        contextualQuestions: result.contextualQuestions,
        defaultSuggestions: result.defaultSuggestions,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefUpdateProfileTool = createTool({
  id: 'chef_update_profile',
  description: 'Updates the questionnaire answers in a menu project. Returns the missing fields and indicates whether the profile is complete.',
  inputSchema: z.object({
    projectId: z.string().describe('The project UUID.'),
    updates: z.record(z.string(), z.any()).describe('The profile fields to update (e.g., { guestProfile: { count: 120 }, seasonality: { targetSeason: "summer" } }).'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const result = await chef.updateProfile(context.projectId, context.updates);
      return {
        success: true,
        project: result.project,
        isComplete: result.isComplete,
        missingFields: result.missingFields,
        contextualQuestions: result.contextualQuestions,
        defaultSuggestions: result.defaultSuggestions,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGenerateMenuTool = createTool({
  id: 'chef_generate_menu',
  description: 'Retrieves the project profile and context from culinary notebooks to enable the agent to generate a menu. After calling this tool, you MUST compose the menu JSON yourself and save it using chef.save_menu.',
  inputSchema: z.object({
    projectId: z.string().describe('The project UUID (must have a complete profile).'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Project ${context.projectId} not found.` };

      if (project.status === 'questionnaire') {
        return { success: false, error: 'The project profile is not complete. Use chef.update_profile to fill in the missing fields.' };
      }

      await chef.updateProjectStatus(context.projectId, 'generating');

      // Determine relevant notebooks
      const profile = project.profile;
      const notebooksToQuery: ChefNotebookId[] = ['chef_master'];

      if (profile.cuisineTypes.some(c => /(francus|włos|italia|śródziem|mediterranean|europe)/i.test(c))) {
        notebooksToQuery.push('chef_europe');
      } else if (profile.cuisineTypes.some(c => /(japon|chin|kore|taj|azj|india|asian|japanese|chinese|thai)/i.test(c))) {
        notebooksToQuery.push('chef_asia');
      } else if (profile.cuisineTypes.some(c => /(meksyk|mexican|bliski|middle.east|nordic|nordyc)/i.test(c))) {
        notebooksToQuery.push('chef_americas_mena');
      }
      notebooksToQuery.push('chef_flavor');

      const cacheKey = `generate:${notebooksToQuery.sort().join(',')}:${profile.establishmentType}:${profile.cuisineTypes.sort().join(',')}:${profile.seasonality?.targetSeason ?? 'all'}`;
      const cached = await chef.getCachedNlmResult(cacheKey);

      let notebookContext = '';
      if (cached) {
        notebookContext = cached;
      } else {
        try {
          const nlm = getNlmClient();
          const menuQuestion = `Design a ${profile.serviceFormat ?? 'a_la_carte'} menu for ${profile.establishmentType}. ` +
            `Cuisine: ${profile.cuisineTypes.join(', ') || 'international'}. ` +
            `Guests: ${profile.guestProfile?.count ?? 'unspecified'}. ` +
            `Season: ${profile.seasonality?.targetSeason ?? 'all year'}. ` +
            (profile.identity?.narrative ? `Narrative: ${profile.identity.narrative}. ` : '') +
            `Provide the section structure, suggested dishes with descriptions, pairings, and texture balance.`;

          const results = await nlm.crossNotebookQuery({
            notebooks: notebooksToQuery.slice(0, 3),
            question: menuQuestion,
          });

          for (const [nb, res] of Object.entries(results) as Array<[string, any]>) {
            if (!res.error) notebookContext += `\n\n### Wiedza z ${nb}:\n${res.answer}`;
          }
          if (notebookContext) await chef.setCachedNlmResult(cacheKey, notebookContext);
        } catch {
          notebookContext = '(Culinary notebooks unavailable — generate based on built-in knowledge.)';
        }
      }

      // ── Auto-inject the chef's OWN repertoire (personal recipe library) ──
      // Always start menu ideation from the chef's style, not from scratch.
      let personalContext = '';
      const repertoireIngredients: string[] = [];
      try {
        const dietaryExclude: string[] = (profile.guestProfile?.dietaryRestrictions ?? []).filter(
          (x): x is string => typeof x === 'string',
        );

        const repertoireQuery = [
          profile.cuisineTypes.join(' '),
          profile.seasonality?.targetSeason ?? '',
          profile.establishmentType ?? '',
          profile.identity?.narrative ?? '',
        ]
          .filter(Boolean)
          .join(' ')
          .trim() || 'menu sezonowe';

        const hits = await searchRecipeLibrary(repertoireQuery, {
          stage: 'menu',
          dietaryExclude,
          limit: 8,
        });

        if (hits.length > 0) {
          for (const h of hits) {
            for (const i of h.ingredients) {
              if (i?.name) repertoireIngredients.push(i.name);
            }
          }
          const lines = hits.map((h) => {
            const ings = h.ingredients
              .map((i) => i?.name)
              .filter(Boolean)
              .slice(0, 8)
              .join(', ');
            return `- [${h.usage}] ${h.name} (${h.category}/${h.type})` +
              `${h.techniques.length ? ` · techniques: ${h.techniques.join(', ')}` : ''}` +
              `${ings ? ` · ingredients: ${ings}` : ''}` +
              `${h.summary ? `\n  ${h.summary}` : ''}`;
          });
          personalContext =
            "CHEF'S REPERTOIRE — inspiration and technical reference from their own recipe library. " +
            "ADAPT (combine/modify) for the project composition and profile; DO NOT copy 1:1 items marked as `adapt`. " +
            "Keep items marked as `locked` exactly as they are if you use them.\n" +
            lines.join('\n');
        }
      } catch {
        // Library not embedded yet or service unavailable — menu generation continues
        // on NotebookLM + built-in knowledge alone.
      }

      // ── Molecular flavor audit (FlavorDB) — gated by CHEF_FLAVOR_PAIRING_ENABLED ──
      // Deterministic, cuisine-aware profile over the chef's candidate palette (the
      // repertoire-hit ingredients). Surfaces dominant aromas / monotony risk + the
      // strongest computed pairs, so the model grounds the draft in compound overlap
      // instead of guessing. Decision-support only — never auto-rejects.
      let flavorAudit: unknown = undefined;
      if (isFlavorPairingEnabled()) {
        try {
          const cuisine = profile.cuisineTypes.join(' ') || undefined;
          // Normalized, deduplicated, capped — keep the pairwise pass cheap. The
          // library stores raw recipe lines ('szczypta zmielonej kolendry',
          // 'kuchnia chińska'), so feeding them to FlavorDB unprocessed wasted
          // roughly half the palette; buildFlavorPalette strips quantities and
          // preparation, drops non-ingredients, and picks the form that resolves.
          const paletteEntries = await buildFlavorPalette(repertoireIngredients, 14);
          const palette = paletteEntries.map((e) => e.name);

          if (palette.length >= 2) {
            const menuProfile = await profileForIngredients(palette);
            // Score all unordered pairs among the palette, keep best + flagged-weak.
            const pairs: Array<{ a: string; b: string; shared: number; jaccard: number; verdict: string; axis: string; rationale: string }> = [];
            for (let i = 0; i < palette.length; i++) {
              for (let j = i + 1; j < palette.length; j++) {
                const s = await scorePairing(palette[i], palette[j], { cuisine });
                if (!s.matched) continue;
                pairs.push({ a: s.a, b: s.b, shared: s.shared, jaccard: s.jaccard, verdict: s.verdict, axis: s.axis, rationale: s.rationale });
              }
            }
            pairs.sort((x, y) => y.shared - x.shared);
            const strongest = pairs.slice(0, 6);
            const weak = pairs.filter((p) => p.verdict === 'weak').slice(0, 4);
            // Bridge suggestions for the weakest flagged pair.
            let bridges: unknown[] = [];
            if (weak[0]) {
              const b = await suggestBridges(weak[0].a, weak[0].b, 4);
              bridges = b.bridges;
            }
            flavorAudit = {
              note: 'Molecular audit (FlavorDB) on the repertoire palette — a compositional suggestion, NOT a verdict. Verify according to domain.md.',
              palette,
              // Named explicitly so the model knows WHICH ingredients carry no
              // chemistry behind them and must be judged qualitatively.
              unresolvedIngredients: paletteEntries.filter((e) => e.entityId === null).map((e) => e.name),
              coverage: menuProfile.coverage,
              dominantDescriptors: menuProfile.dominantDescriptors,
              balanceFlags: menuProfile.balanceFlags,
              strongestPairs: strongest,
              flaggedWeakPairs: weak,
              bridgeSuggestionsForWeakest: bridges,
            };
          }
        } catch {
          // FlavorDB not loaded / service unavailable — skip audit, menu generation continues.
        }
      }

      const nextVersion = await chef.getLatestMenuVersion(context.projectId) + 1;

      const instruction = [
        'Based on the profile, context from notebooks, and the chef repertoire (personalContext), generate a complete menu as JSON:',
        '{ title, narrative, sections: [{ name, dishes: [{ name, description, ingredients[], techniques[], flavorProfile?, textures[], temperature, allergens[], dietaryTags[], pairingWine? }] }] }',
        'First, draw from the chef repertoire (personalContext) — this represents their style; NotebookLM is general knowledge. Adapt the chef\'s recipes rather than copying them 1:1.',
        'Rules: min. 3 textures per dish, light-to-heavy progression, max 2 of the same techniques, parallel dietary paths.',
      ];
      if (flavorAudit) {
        instruction.push(
          'Incorporate flavorAudit (FlavorDB): use strongestPairs as flavor anchors, consider bridgeSuggestions for weak pairs, and introduce contrast between dishes if there is an aroma monotony (balanceFlags). This is quantitative guidance — combine it with domain.md rules, do not treat it as a final verdict.',
        );
      }
      instruction.push(
        `Then call chef.save_menu with projectId="${context.projectId}", version=${nextVersion}, title, narrative, sections.`,
      );

      return {
        success: true,
        projectId: context.projectId,
        nextVersion,
        profile,
        notebookContext,
        personalContext,
        ...(flavorAudit ? { flavorAudit } : {}),
        instruction: instruction.join(' '),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefDraftRecipeTool = createTool({
  id: 'chef_draft_recipe',
  description: 'Generates and saves a recipe card (BOM, mise en place, plating/service) for a dish in the project.',
  inputSchema: z.object({
    projectId: z.string(),
    dishName: z.string(),
    yield: z.object({ amount: z.number(), unit: z.string() }),
    components: z.array(z.object({
      componentName: z.string(),
      ingredients: z.array(z.object({ name: z.string(), quantity: z.number(), unit: z.string(), notes: z.string().optional() })),
      miseEnPlace: z.array(z.object({ order: z.number(), instruction: z.string(), temperature: z.string().optional(), time: z.string().optional() })),
    })),
    serviceSteps: z.array(z.object({ order: z.number(), instruction: z.string(), temperature: z.string().optional(), time: z.string().optional() })),
    allergens: z.array(z.string()).optional(),
    equipmentNeeded: z.array(z.string()).optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const recipe = await chef.saveRecipe({
        projectId: context.projectId,
        dishName: context.dishName,
        yield: context.yield,
        components: context.components,
        serviceSteps: context.serviceSteps,
        allergens: context.allergens,
        equipmentNeeded: context.equipmentNeeded,
      });
      return { success: true, recipeId: recipe.id, dishName: recipe.dishName, message: 'Recipe saved in BOM format.' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSearchRecipeLibraryTool = createTool({
  id: 'chef_search_recipe_library',
  description:
    "Searches the chef's PERSONAL recipe library (their own repertoire) — hybrid (vector + lexical). " +
    "Use BEFORE conceiving a dish or component from scratch: during the MENU phase for dish inspiration, and during the RECIPES phase for components (sauces, purées, broths) with the chef's exact ratios. " +
    "NotebookLM is general knowledge; this library represents the chef's style.",
  inputSchema: z.object({
    query: z.string().describe('Natural query, e.g., "sauce for asparagus", "vegetarian autumn purée", "demi-glace"'),
    category: z.string().optional().describe('Category filter (slug), e.g., "sosy-cieple", "zupy", "puree"'),
    type: z.enum(['component', 'dish']).optional().describe('"component" = a sub-component (sauce/purée/broth), "dish" = full dish'),
    dietaryExclude: z.array(z.string()).optional().describe('Allergens/ingredients to exclude, e.g., ["milk", "gluten"]'),
    stage: z.enum(['menu', 'recipe']).optional().describe('Stage hint: "menu" promotes dishes, "recipe" promotes components'),
    limit: z.number().optional().describe('Number of results (default is 6)'),
  }),
  execute: async (context) => {
    try {
      const results = await searchRecipeLibrary(context.query, {
        category: context.category,
        type: context.type,
        dietaryExclude: context.dietaryExclude,
        stage: context.stage,
        limit: context.limit,
      });
      return {
        success: true,
        count: results.length,
        results,
        note: results.length === 0
          ? "No matches in the chef's library (or the library has not been embedded yet). Compose based on general knowledge."
          : "Chef's repertoire: ADAPT items marked as `adapt`, keep items marked as `locked` faithful. This is a reference for style and ratios.",
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// ─── New tools ────────────────────────────────────────────────────────────────

export const chefGetProjectTool = createTool({
  id: 'chef_get_project',
  description: 'Retrieves menu project details along with the current profile and status.',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Project ${context.projectId} not found.` };
      return { success: true, project };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefListProjectsTool = createTool({
  id: 'chef_list_projects',
  description: 'Returns a list of menu projects with their statuses. Optional filtering by status.',
  inputSchema: z.object({
    status: z.string().optional().describe('Filter by status: questionnaire, review, generating, approved, archived'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    projects: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const projects = await chef.listProjects(
        context.status ? { status: context.status } : undefined,
        context.limit ?? 10,
      );
      return {
        success: true,
        count: projects.length,
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          status: p.status,
          establishmentType: p.profile.establishmentType,
          cuisineTypes: p.profile.cuisineTypes,
          currentMenuId: p.currentMenuId,
          updatedAt: p.updatedAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSaveMenuTool = createTool({
  id: 'chef_save_menu',
  description: 'Saves a menu (manually composed or after iteration) to a project. Versions are auto-incremented.',
  inputSchema: z.object({
    projectId: z.string().describe('Project UUID'),
    title: z.string().describe('Menu title'),
    narrative: z.string().optional().default('').describe('A 2-3 sentence narrative description of the menu'),
    version: z.number().int().optional().describe('Version number (omit to auto-calculate)'),
    sections: z.array(z.object({
      name: z.string(),
      dishes: z.array(z.object({
        name: z.string(),
        description: z.string(),
        ingredients: z.array(z.string()).optional().default([]),
        techniques: z.array(z.string()).optional().default([]),
        flavorProfile: z.object({
          dominant: z.array(z.string()).optional(),
          bridges: z.array(z.string()).optional(),
          family: z.string().optional(),
        }).optional(),
        textures: z.array(z.string()).optional(),
        temperature: z.string().optional(),
        allergens: z.array(z.string()).optional().default([]),
        dietaryTags: z.array(z.string()).optional().default([]),
        pairingWine: z.string().optional(),
        pairingNonAlcoholic: z.string().optional(),
        plateDescription: z.string().optional(),
      })).min(1),
    })).min(1),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menuId: z.string().optional(),
    version: z.number().optional(),
    title: z.string().optional(),
    totalDishes: z.number().optional(),
    sections: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Project ${context.projectId} not found.` };

      const version = context.version ?? (await chef.getLatestMenuVersion(context.projectId) + 1);
      const allDishes = context.sections.flatMap((s: any) => s.dishes ?? []);

      const techniqueDistribution: Record<string, number> = {};
      const allergenMatrix: Record<string, string[]> = {};
      for (const dish of allDishes) {
        for (const t of dish.techniques ?? []) techniqueDistribution[t] = (techniqueDistribution[t] ?? 0) + 1;
        if (dish.allergens?.length) allergenMatrix[dish.name] = dish.allergens;
      }

      const menu = await chef.saveMenu({
        projectId: context.projectId,
        version,
        title: context.title,
        narrative: context.narrative ?? '',
        sections: context.sections as any,
        metadata: {
          totalDishes: allDishes.length,
          techniqueDistribution,
          allergenMatrix,
          temperatureArc: allDishes.map((d: any) => (d as any).temperature ?? 'warm'),
        },
      });

      return {
        success: true,
        menuId: menu.id,
        version: menu.version,
        title: menu.title,
        totalDishes: allDishes.length,
        sections: menu.sections.map(s => ({ name: s.name, dishCount: s.dishes.length })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGetMenuTool = createTool({
  id: 'chef_get_menu',
  description: 'Retrieves a full menu with sections and dishes. Requires menuId (UUID), do not confuse with projectId.',
  inputSchema: z.object({
    menuId: z.string().describe('Menu UUID'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menu: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} not found.` };
      return { success: true, menu };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefIterateMenuTool = createTool({
  id: 'chef_iterate_menu',
  description: 'Returns the existing menu + project profile to enable the agent to apply user feedback and save a new version via chef.save_menu. After calling this tool, you MUST: (1) apply the feedback to the sections, (2) call chef.save_menu with the projectId and updated sections.',
  inputSchema: z.object({
    menuId: z.string().describe('UUID of the menu to modify'),
    feedback: z.string().describe('Description of changes, e.g., "replace the fish at position 5 with something meaty" or "add more vegan options"'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menuId: z.string().optional(),
    projectId: z.string().optional(),
    currentSections: z.any().optional(),
    profile: z.any().optional(),
    feedback: z.string().optional(),
    instruction: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} not found.` };

      const project = await chef.getProject(menu.projectId);
      if (!project) return { success: false, error: `Project ${menu.projectId} not found.` };

      const nextVersion = await chef.getLatestMenuVersion(menu.projectId) + 1;

      return {
        success: true,
        menuId: menu.id,
        projectId: menu.projectId,
        currentSections: menu.sections,
        profile: project.profile,
        feedback: context.feedback,
        instruction: `Apply the following feedback to the menu sections: "${context.feedback}". Maintain: progression (light to heavy), min. 3 textures per dish, max 2 of the same techniques, parallel dietary paths. Then call chef.save_menu with projectId="${menu.projectId}", version=${nextVersion}, title="${menu.title}", narrative, and updated sections.`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGetRecipeTool = createTool({
  id: 'chef_get_recipe',
  description: 'Retrieves a previously saved recipe (BOM) for a dish in the project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project UUID'),
    dishName: z.string().describe('The dish name (case-sensitive)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    recipe: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const recipe = await chef.getRecipe(context.projectId, context.dishName);
      if (!recipe) return { success: false, error: `No recipe found for "${context.dishName}". Use chef.draft_recipe to generate it.` };
      return { success: true, recipe };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefQueryKnowledgeTool = createTool({
  id: 'chef_query_knowledge',
  description: `Queries culinary knowledge bases in NotebookLM. Available notebooks: chef_master (general chef knowledge), chef_flavor (flavor pairing), chef_texture (textures), chef_classic (classical cuisine), chef_modern (modern techniques), chef_europe (European cuisine), chef_asia (Asian cuisine), chef_americas_mena (Americas/Middle East), chef_psychology (guest psychology).`,
  inputSchema: z.object({
    question: z.string().describe('Culinary question (in natural language)'),
    notebooks: z.array(z.enum(CHEF_NOTEBOOK_IDS)).min(1).max(3).describe('List of notebooks to query (max 3)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.record(z.string(), z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      if (context.notebooks.length === 1) {
        const result = await nlm.query({ notebook: context.notebooks[0], question: context.question, timeout: 120 });
        return {
          success: true,
          results: {
            [context.notebooks[0]]: { answer: result.answer, citations: result.citations.slice(0, 5) },
          },
        };
      }
      const results = await nlm.crossNotebookQuery({ notebooks: context.notebooks, question: context.question });
      return {
        success: true,
        results: Object.fromEntries(
          Object.entries(results).map(([nb, res]: [string, any]) => [
            nb,
            res.error ? { error: res.error } : { answer: res.answer, citations: (res.citations ?? []).slice(0, 3) },
          ]),
        ),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSuggestPairingTool = createTool({
  id: 'chef_suggest_pairing',
  description: 'Suggests flavor pairings for the given ingredients using knowledge from chef_flavor and chef_master. Returns complementary and contrasting pairings, and bridge ingredients.',
  inputSchema: z.object({
    ingredients: z.array(z.string().min(1)).min(1).max(10).describe('List of ingredients to pair'),
    cuisineContext: z.string().optional().describe('Cuisine context, e.g., "Japanese", "Asian-Scandinavian fusion"'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    ingredients: z.array(z.string()).optional(),
    results: z.record(z.string(), z.any()).optional(),
    fallback: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const nlm = getNlmClient();
      const sortedIngredients = [...context.ingredients].sort().join(',');
      const cacheKey = `pairing:${sortedIngredients}:${context.cuisineContext ?? ''}`;
      const cached = await chef.getCachedNlmResult(cacheKey);

      if (cached) {
        try {
          return { success: true, ingredients: context.ingredients, results: JSON.parse(cached) };
        } catch { /* fallthrough */ }
      }

      const question = `Suggest flavor pairings for ingredients: ${context.ingredients.join(', ')}.` +
        (context.cuisineContext ? ` Cuisine context: ${context.cuisineContext}.` : '') +
        ` Provide: 1) complementary pairings (same flavor family), 2) contrasting pairings, 3) bridge ingredients linking unrelated elements. Justify via aromatic compound families.`;

      const results = await nlm.crossNotebookQuery({ notebooks: ['chef_flavor', 'chef_master'], question });
      const mapped = Object.fromEntries(
        Object.entries(results).map(([nb, res]: [string, any]) => [
          nb,
          res.error ? { error: res.error } : { answer: res.answer, citations: (res.citations ?? []).slice(0, 3) },
        ]),
      );
      await chef.setCachedNlmResult(cacheKey, JSON.stringify(mapped));
      return { success: true, ingredients: context.ingredients, results: mapped };
    } catch (err: any) {
      return { success: true, ingredients: context.ingredients, fallback: true, note: `Notebooks unavailable: ${err.message}. Use built-in flavor pairing knowledge.` };
    }
  },
});

// ─── FlavorDB quantitative pairing tools (gated by CHEF_FLAVOR_PAIRING_ENABLED) ──
// Decision-support: they COMPUTE shared-compound overlap (cuisine-aware) and EXPLAIN it.
// The model + domain.md make the final call — these never auto-reject a dish. Unresolved
// ingredients degrade to { matched:false } so the model falls back to qualitative rules.

export const chefScorePairingTool = createTool({
  id: 'chef_score_pairing',
  description:
    'Calculates the quantitative pairing score of two ingredients according to FlavorDB (number of shared aromatic compounds, Jaccard index, shared descriptors). Cuisine-aware: Western cuisine rewards HIGH overlap (complementarity), East Asian rewards LOW overlap (contrast, Ahn 2011). Decision-support — supplements, does not replace domain.md rules. Returns matched:false when there is no data (evaluate qualitatively in that case).',
  inputSchema: z.object({
    a: z.string().min(1).describe('First ingredient (PL or EN)'),
    b: z.string().min(1).describe('Second ingredient (PL or EN)'),
    cuisine: z.string().optional().describe('Cuisine context, e.g., "Italian", "Japanese" — switches complementarity/contrast logic'),
  }),
  execute: async (context) => {
    try {
      const result = await scorePairing(context.a, context.b, { cuisine: context.cuisine });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSuggestPairingsTool = createTool({
  id: 'chef_suggest_pairings',
  description:
    'For a single ingredient, returns a ranking of flavor partners (by shared compounds, cuisine-aware) and optionally bridges (bridge ingredients) between two ingredients. Use when composing a dish/component to base combinations on computed overlap instead of guessing. Returns matched:false when FlavorDB data is missing.',
  inputSchema: z.object({
    ingredient: z.string().min(1).describe('Base ingredient to pair'),
    cuisine: z.string().optional().describe('Cuisine context (switches complementarity/contrast)'),
    limit: z.number().int().min(1).max(20).optional().describe('Number of partners to return (default is 8)'),
    bridgeWith: z.string().optional().describe('If provided, also return bridge ingredients linking `ingredient` with `bridgeWith`'),
  }),
  execute: async (context) => {
    try {
      const partners = await suggestPartners(context.ingredient, {
        cuisine: context.cuisine,
        limit: context.limit,
      });
      const bridges = context.bridgeWith
        ? await suggestBridges(context.ingredient, context.bridgeWith, context.limit ?? 5)
        : null;
      return {
        success: true,
        ingredient: context.ingredient,
        axis: partners.axis,
        matched: partners.matched,
        partners: partners.partners,
        bridges: bridges?.bridges ?? [],
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefCheckSeasonalTool = createTool({
  id: 'chef_check_seasonal',
  description: 'Checks seasonality of ingredients for the specified region and month. Omit ingredients (or pass []) to get a general seasonal overview.',
  inputSchema: z.object({
    ingredients: z.array(z.string()).optional().default([]).describe('Ingredients to check (empty = general regional overview)'),
    region: z.string().optional().default('central_europe').describe('Region, e.g., "central_europe", "Mazowsze", "Francja"'),
    month: z.number().int().min(1).max(12).optional().describe('Month 1-12 (default: current month)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    region: z.string().optional(),
    month: z.number().optional(),
    monthName: z.string().optional(),
    answer: z.string().optional(),
    citations: z.array(z.string()).optional(),
    fallback: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const month = context.month ?? new Date().getMonth() + 1;
    const ingredients: string[] = Array.isArray(context.ingredients) ? context.ingredients : [];
    const region = context.region ?? 'central_europe';

    const question = ingredients.length > 0
      ? `Check seasonality of ingredients: ${ingredients.join(', ')} in region ${region} in the month of ${monthNames[month - 1]}. For each, specify if it is in season; if not, suggest a seasonal substitute.`
      : `Provide a general seasonal overview for region ${region} in the month of ${monthNames[month - 1]}: key ingredients in season (vegetables, fruits, fish, meat, herbs) and ingredients to avoid.`;

    try {
      const nlm = getNlmClient();
      const result = await nlm.query({ notebook: 'chef_master', question, timeout: 60 });
      return {
        success: true,
        region,
        month,
        monthName: monthNames[month - 1],
        answer: result.answer,
        citations: result.citations.slice(0, 3),
      };
    } catch (err: any) {
      return {
        success: true,
        region,
        month,
        monthName: monthNames[month - 1],
        fallback: true,
        note: `Notebook chef_master unavailable: ${err.message}. Use built-in seasonality knowledge.`,
      };
    }
  },
});

export const chefAddNoteTool = createTool({
  id: 'chef_add_note',
  description: 'Adds a working chef note — client preferences, discovered pairings, iteration notes, feedback. Notes build a knowledge base reusable in subsequent projects.',
  inputSchema: z.object({
    content: z.string().min(1).describe('Note content'),
    type: z.enum(['preference', 'pairing', 'technique', 'seasonal', 'feedback', 'general']).optional().default('general'),
    topic: z.string().optional().describe('Note topic (e.g., "lamb + rosemary pairing", "client: Jan Kowalski")'),
    projectId: z.string().optional().describe('Project UUID (if the note is associated with a project)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const note = await chef.addNote({
        content: context.content,
        type: context.type,
        topic: context.topic,
        projectId: context.projectId,
      });
      return { success: true, id: note.id, type: note.type, topic: note.topic };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSearchNotesTool = createTool({
  id: 'chef_search_notes',
  description: 'Searches chef notes (semantically or via regex fallback). Use to retrieve client preferences or past discoveries.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query (e.g., "pairing lamb", "preferences Jan Kowalski")'),
    projectId: z.string().optional().describe('Limit to project (optional)'),
    limit: z.number().int().min(1).max(25).optional().default(5),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    notes: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const notes = await chef.searchNotes(context.query, context.projectId, context.limit ?? 5);
      return { success: true, count: notes.length, notes };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefExportMenuTool = createTool({
  id: 'chef_export_menu',
  description: 'Exports a menu to a print-ready format (Markdown or plain text). Returns a formatted document ready for printing or conversion to PDF.',
  inputSchema: z.object({
    menuId: z.string().describe('UUID of the menu to export'),
    format: z.enum(['markdown', 'plain']).optional().default('markdown'),
    includeMetadata: z.boolean().optional().default(false).describe('Include metadata section (techniques, allergens, temperature arc)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    format: z.string().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} not found.` };

      const project = await chef.getProject(menu.projectId);

      if (context.format === 'plain') {
        const lines: string[] = [];
        lines.push(menu.title.toUpperCase());
        if (menu.narrative) lines.push('', menu.narrative);
        lines.push('');
        for (const section of menu.sections) {
          lines.push(`── ${section.name} ──`);
          for (const dish of section.dishes) {
            lines.push(`  ${dish.name}`);
            if (dish.description) lines.push(`    ${dish.description}`);
            if (dish.allergens?.length) lines.push(`    Alergeny: ${dish.allergens.join(', ')}`);
            if (dish.pairingWine) lines.push(`    Wino: ${dish.pairingWine}`);
          }
          lines.push('');
        }
        return { success: true, format: 'plain', content: lines.join('\n') };
      }

      // Markdown
      const md: string[] = [];
      md.push(`# ${menu.title}`);
      if (menu.narrative) md.push('', `*${menu.narrative}*`);
      if (project) md.push('', `**${project.profile.establishmentType}** | Wersja ${menu.version}`);
      md.push('');

      for (const section of menu.sections) {
        md.push(`## ${section.name}`, '');
        for (const dish of section.dishes) {
          md.push(`### ${dish.name}`);
          if (dish.description) md.push(dish.description);
          const tags: string[] = [];
          if (dish.textures?.length) tags.push(`Tekstury: ${dish.textures.join(', ')}`);
          if (dish.temperature) tags.push(`Temp: ${dish.temperature}`);
          if (dish.dietaryTags?.length) tags.push(dish.dietaryTags.join(' | '));
          if (tags.length) md.push(`> ${tags.join(' · ')}`);
          if (dish.allergens?.length) md.push(`> ⚠️ ${dish.allergens.join(', ')}`);
          if (dish.pairingWine) md.push(`> 🍷 ${dish.pairingWine}`);
          if (dish.pairingNonAlcoholic) md.push(`> 🥤 ${dish.pairingNonAlcoholic}`);
          md.push('');
        }
      }

      if (context.includeMetadata && menu.metadata) {
        md.push('---', '## Metadane');
        md.push(`- Łączna liczba dań: ${menu.metadata.totalDishes ?? '?'}`);
        if (menu.metadata.techniqueDistribution) {
          md.push(`- Rozkład technik: ${Object.entries(menu.metadata.techniqueDistribution).map(([k, v]) => `${k}(${v})`).join(', ')}`);
        }
        if (menu.metadata.temperatureArc) {
          md.push(`- Łuk temperatur: ${menu.metadata.temperatureArc.join(' → ')}`);
        }
        if (menu.metadata.allergenMatrix) {
          md.push('- Macierz alergenów:');
          for (const [dish, allergens] of Object.entries(menu.metadata.allergenMatrix)) {
            md.push(`  - ${dish}: ${(allergens as string[]).join(', ')}`);
          }
        }
      }

      return { success: true, format: 'markdown', content: md.join('\n') };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// ─── Render helpers for the Menu Book ─────────────────────────────────────────
// NOTE: rendered labels below (Wersja, Składniki, Mise en place…) are part of the
// deliverable artifact (Polish client-facing Menu Book), so they stay in Polish.

/** Renders menu body (no top-level title) for embedding in a Menu Book section. */
function renderMenuBody(menu: ChefMenu): string {
  const md: string[] = [];
  if (menu.narrative) md.push(`*${menu.narrative}*`, '');
  md.push(`**Wersja ${menu.version}**`, '');
  for (const section of menu.sections) {
    md.push(`### ${section.name}`, '');
    for (const dish of section.dishes) {
      md.push(`#### ${dish.name}`);
      if (dish.description) md.push(dish.description);
      const tags: string[] = [];
      if (dish.textures?.length) tags.push(`Tekstury: ${dish.textures.join(', ')}`);
      if (dish.temperature) tags.push(`Temp: ${dish.temperature}`);
      if (dish.dietaryTags?.length) tags.push(dish.dietaryTags.join(' | '));
      if (tags.length) md.push(`> ${tags.join(' · ')}`);
      if (dish.allergens?.length) md.push(`> ⚠️ ${dish.allergens.join(', ')}`);
      if (dish.pairingWine) md.push(`> 🍷 ${dish.pairingWine}`);
      if (dish.pairingNonAlcoholic) md.push(`> 🥤 ${dish.pairingNonAlcoholic}`);
      md.push('');
    }
  }
  return md.join('\n').trim();
}

/** Renders a recipe card (technical card) into Menu Book Markdown. */
function renderRecipeCard(recipe: ChefRecipe): string {
  const md: string[] = [];
  md.push(`### ${recipe.dishName}`);
  md.push(`**Wydajność:** ${recipe.yield.amount} ${recipe.yield.unit}`);
  if (recipe.allergens?.length) md.push(`**Alergeny:** ${recipe.allergens.join(', ')}`);
  if (recipe.equipmentNeeded?.length) md.push(`**Sprzęt:** ${recipe.equipmentNeeded.join(', ')}`);
  md.push('');
  for (const comp of recipe.components) {
    md.push(`**Komponent: ${comp.componentName}**`, '');
    md.push('Składniki:');
    for (const ing of comp.ingredients) {
      md.push(`- ${ing.quantity} ${ing.unit} ${ing.name}${ing.notes ? ` _(${ing.notes})_` : ''}`);
    }
    if (comp.miseEnPlace?.length) {
      md.push('', 'Mise en place:');
      for (const step of comp.miseEnPlace.sort((a, b) => a.order - b.order)) {
        const extra = [step.temperature, step.time].filter(Boolean).join(', ');
        md.push(`${step.order}. ${step.instruction}${extra ? ` _(${extra})_` : ''}`);
      }
    }
    md.push('');
  }
  if (recipe.serviceSteps?.length) {
    md.push('**Service (montaż na talerzu):**');
    for (const step of recipe.serviceSteps.sort((a, b) => a.order - b.order)) {
      const extra = [step.temperature, step.time].filter(Boolean).join(', ');
      md.push(`${step.order}. ${step.instruction}${extra ? ` _(${extra})_` : ''}`);
    }
    md.push('');
  }
  return md.join('\n').trim();
}

export const chefExportMenuBookTool = createTool({
  id: 'chef_export_menu_book',
  description:
    "Compiles the project's finished menu and technical cards into the Menu Book — fills the `menu` and `recipes` sections. Combines the latest menu (or a given menuId) with the project's recipes. Requires a prior chef_document_init.",
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    menuId: z.string().optional().describe('UUID of a specific menu (defaults to the latest version)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    /** Artifact Store id of the finished book — what the orchestrator commits. */
    artifactId: z.string().optional(),
    menuVersion: z.number().optional(),
    recipeCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();

      // 1. Pick the menu (given or latest)
      let menu: ChefMenu | null = null;
      if (context.menuId) {
        menu = await chef.getMenu(context.menuId);
      } else {
        const menus = await chef.getMenusByProject(context.projectId);
        menu = menus[0] ?? null; // getMenusByProject sorts version: -1
      }
      if (!menu) {
        return { success: false, error: `No menu for project ${context.projectId}. Generate a menu (chef_generate_menu) before compiling the Menu Book.` };
      }

      // 2. Fetch the project's recipes
      const recipes = await chef.getRecipesByProject(context.projectId);

      // 3. Load the Menu Book (must exist)
      const filePath = bookPath(context.projectId);
      let doc: string;
      try {
        doc = await fs.readFile(filePath, 'utf-8');
      } catch {
        return { success: false, error: `Menu Book for project ${context.projectId} does not exist — call chef_document_init.` };
      }

      // 4. Fill the sections (recipesBody fallback stays Polish — artifact content)
      const menuBody = renderMenuBody(menu);
      const recipesBody = recipes.length
        ? recipes.map(renderRecipeCard).join('\n\n')
        : '_(brak receptur — wygeneruj przez chef_draft_recipe)_';

      doc = replaceSection(doc, 'menu', menuBody);
      doc = replaceSection(doc, 'recipes', recipesBody);
      await fs.writeFile(filePath, doc, 'utf-8');

      // The Menu Book is now complete, so this is the moment it becomes a
      // deliverable — register it.
      //
      // Without this the book exists only on disk and in Mongo, where the
      // orchestrator cannot see it. Chef runs were failing with EMPTY output for
      // exactly that reason: 107 activity events, a finished book, and a final
      // response carrying nothing but the framework's completion report, so the
      // attempt committed nothing. Chef owns `artifact_put`, but relying on the
      // model to remember to call it is the fragility that cost designAgent four
      // canaries — the write records itself instead.
      let artifactId: string | undefined;
      try {
        const ref = await putArtifact({
          type: 'menu_book_ref',
          content: doc,
          title: `Menu Book — ${menu.title ?? context.projectId}`,
          summary: `Menu v${menu.version} + ${recipes.length} technical cards.`,
          producedBy: 'chefAgent',
        });
        artifactId = ref.id;
      } catch {
        // The book is written and usable; failing the export because the store
        // is unreachable would throw away finished work.
      }

      return {
        success: true,
        path: filePath,
        artifactId,
        menuVersion: menu.version,
        recipeCount: recipes.length,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// ─── E2: recon → profile synthesis ────────────────────────────────────────────

/**
 * Maps an average main-course price to a price tier.
 * Thresholds (PLN) configurable via env CHEF_PRICE_TIER_PLN="mid,premium,luxury"
 * (3 ascending breakpoints). Default: 35 / 70 / 130.
 *   avg <  t0 → budget
 *   avg <  t1 → mid
 *   avg <  t2 → premium
 *   avg >= t2 → luxury
 */
function priceTierFromAvgMain(avgMain: number): 'budget' | 'mid' | 'premium' | 'luxury' {
  const raw = process.env.CHEF_PRICE_TIER_PLN || '35,70,130';
  const parts = raw.split(',').map((n) => Number(n.trim()));
  const [t0, t1, t2] = parts.length === 3 && parts.every((n) => !isNaN(n)) ? parts : [35, 70, 130];
  if (avgMain < t0) return 'budget';
  if (avgMain < t1) return 'mid';
  if (avgMain < t2) return 'premium';
  return 'luxury';
}

const CurrentMenuAnalysisSchema = z.object({
  menuSource: z.object({
    url: z.string().optional(),
    format: z.enum(['html', 'pdf', 'image', 'unknown']).optional(),
  }).optional(),
  sections: z.array(z.object({
    name: z.string(),
    dishes: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      price: z.number().optional(),
      inferredTechniques: z.array(z.string()).optional(),
      inferredAllergens: z.array(z.string()).optional(),
    })),
  })).optional(),
  pricing: z.object({
    currency: z.string().optional(),
    minMain: z.number().optional(),
    maxMain: z.number().optional(),
    avgMain: z.number().optional(),
  }).optional(),
  styleNotes: z.string().optional().describe('ingredient-led / descriptive / poetic...'),
  difficulty: z.object({
    score: z.number().min(1).max(5).optional(),
    signals: z.array(z.string()).optional(),
  }).optional(),
  cuisineTypes: z.array(z.string()).optional().describe('Inferred by the agent from dishes (run_worker fast)'),
  language: z.string().optional(),
});

const ReputationSchema = z.object({
  rating: z.number().optional(),
  reviewCount: z.number().optional(),
  strengths: z.array(z.object({ theme: z.string(), evidence: z.array(z.any()).optional() })).optional(),
  weaknesses: z.array(z.object({ theme: z.string(), evidence: z.array(z.any()).optional() })).optional(),
  signatureDishes: z.array(z.string()).optional().describe('Dishes praised in reviews (agent-derived)'),
}).optional();

export const chefImportWebsiteProfileTool = createTool({
  id: 'chef_import_website_profile',
  description:
    "Synthesizes recon output (current-menu analysis + optional reputation) into the project profile. Deterministic mapper: avgMain→priceRange.tier (configurable PLN thresholds), writes difficultyTarget (parity ±1 vs current menu), currentMenuRef, cuisineTypes and signatureDishes. Returns missing fields like chef_update_profile. Pass cuisineTypes and signatureDishes already inferred via run_worker(fast).",
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    currentMenuAnalysis: CurrentMenuAnalysisSchema.describe("Researcher Mission A output contract (menu recon)"),
    reputation: ReputationSchema.describe("Researcher Mission B output contract (reputation recon) — optional"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    appliedUpdates: z.record(z.string(), z.any()).optional(),
    missingFields: z.array(z.any()).optional(),
    isComplete: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const cma = context.currentMenuAnalysis || {};
      const rep = context.reputation;

      // Every field of the Mission A contract is optional, so `{}` used to be a
      // valid recon: this returned `success: true` and wrote a `currentMenuRef`
      // holding nothing but a timestamp. That is worse than an error twice over —
      // the profile silently loses its price tier, cuisine and difficulty parity,
      // AND `currentMenuRef` is the very field an operator reads to confirm that
      // recon ran, so the empty write forges its own evidence.
      //
      // Refuse instead. A researcher that found nothing must say so through
      // `gaps[]`, and chef must see a failed import rather than a blank profile.
      const dishesFound = (cma.sections || []).reduce((acc, s) => acc + (s.dishes?.length || 0), 0);
      const hasPricing = typeof cma.pricing?.avgMain === 'number' && !isNaN(cma.pricing.avgMain);
      if (dishesFound === 0 && !hasPricing) {
        return {
          success: false,
          error:
            'currentMenuAnalysis carries neither dishes nor pricing — this is not a menu recon. '
            + 'Re-run Mission A (prompts/research/menu-recon.md) with the deep-read order '
            + '(tavily_extract → firecrawl_scrape → Playwright) and require the sections[].dishes[] '
            + 'contract; if the menu genuinely cannot be read, report it in gaps[] and ask the user '
            + 'rather than importing an empty profile.',
        };
      }

      const updates: Record<string, any> = {};

      // 1. cuisineTypes (agent-derived from dishes)
      if (cma.cuisineTypes?.length) updates.cuisineTypes = cma.cuisineTypes;

      // 2. priceRange from avgMain (deterministic tier)
      const avgMain = cma.pricing?.avgMain;
      if (typeof avgMain === 'number' && !isNaN(avgMain)) {
        updates.priceRange = {
          tier: priceTierFromAvgMain(avgMain),
          avgMainPrice: avgMain,
          ...(cma.pricing?.currency ? { currency: cma.pricing.currency } : {}),
        };
      }

      // 3. difficultyTarget — parity ±1 vs current
      const diffScore = cma.difficulty?.score;
      if (typeof diffScore === 'number') {
        updates.difficultyTarget = {
          score: diffScore,
          rationale: `Parity ±1 vs current menu (difficulty ${diffScore}/5) — same stations/skills, more interesting and more local effects.`,
        };
      }

      // 4. currentMenuRef — snapshot of the source menu
      const dishCount = (cma.sections || []).reduce((acc, s) => acc + (s.dishes?.length || 0), 0);
      updates.currentMenuRef = {
        ...(cma.menuSource?.url ? { url: cma.menuSource.url } : {}),
        ...(cma.menuSource?.format ? { format: cma.menuSource.format } : {}),
        ...(typeof avgMain === 'number' ? { avgMainPrice: avgMain } : {}),
        ...(cma.pricing?.currency ? { currency: cma.pricing.currency } : {}),
        ...(dishCount ? { dishCount } : {}),
        ...(cma.styleNotes ? { styleNotes: cma.styleNotes } : {}),
        ...(typeof diffScore === 'number' ? { difficultyScore: diffScore } : {}),
        capturedAt: new Date(),
      };

      // 5. signatureDishes from positive reputation mentions
      if (rep?.signatureDishes?.length) {
        updates.identity = { signatureDishes: rep.signatureDishes };
      }

      // 6. persist via updateProfile (deepMerge + missingFields recompute)
      const result = await chef.updateProfile(context.projectId, updates);

      return {
        success: true,
        project: result.project,
        appliedUpdates: updates,
        missingFields: result.missingFields,
        isComplete: result.isComplete,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSetProjectStatusTool = createTool({
  id: 'chef_set_project_status',
  description:
    'Sets the project status in the Menu Book pipeline state machine. Call it on every phase transition so the state is resumable and auditable. Allowed pipeline statuses: intake, recon, profile_synthesis, checkpoint_profile, menu_draft, critic_gate, checkpoint_menu, recipes, qa_final, render, done.',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    status: z.enum(CHEF_PIPELINE_STATUSES).describe('New pipeline phase status'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    projectId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Project ${context.projectId} not found.` };

      if (context.status === 'done') {
        const missing = await missingRecipeDishes(chef, context.projectId);
        if (missing.length > 0) {
          const shown = missing.slice(0, 12);
          return {
            success: false,
            projectId: context.projectId,
            error:
              `Cannot mark this project 'done': ${missing.length} dish(es) on the menu have no recipe card. `
              + `Draft one with chef_draft_recipe for each, then set 'done' again. Missing: `
              + shown.join('; ')
              + (missing.length > shown.length ? `; …and ${missing.length - shown.length} more` : ''),
          };
        }

        // Coverage in Mongo is not a finished deliverable. Measured 2026-08-19:
        // a run closed as `done` with all fifteen recipes stored and a 12 KB book
        // whose `recipes` section was empty, because the compile step was never
        // called. The Menu Book IS the product, so it gets its own condition.
        if (!isCompletenessGateDisabled()) {
          const recipeCount = (await chef.getRecipesByProject(context.projectId)).length;
          const gaps = await menuBookGaps(context.projectId, { expectRecipes: recipeCount > 0 });
          if (gaps.length > 0) {
            return {
              success: false,
              projectId: context.projectId,
              error:
                `Cannot mark this project 'done': the Menu Book is not publishable yet. `
                + gaps.join('; ')
                + `. Fill the sections with chef_document_write_section, compile with `
                + `chef_export_menu_book, then set 'done' again.`,
            };
          }
        }
      }

      await chef.updateProjectStatus(context.projectId, context.status);
      return { success: true, projectId: context.projectId, status: context.status };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

/**
 * Dishes on the latest menu that have no recipe card, for the `done` gate.
 *
 * `qa_final` and the Phase-Exit Check were only ever sentences in
 * `prompts/chef/pipeline.md`, so nothing enforced them: measured 2026-08-19,
 * five of the ten most recent `done` projects were incomplete — one carried 63
 * dishes and zero recipes. A completeness rule the model may decline to run is
 * not a gate, so this one lives in the tool.
 *
 * Deliberately narrow: it only ever blocks the LAST transition, and only when a
 * menu with dishes exists. A project with no menu (questionnaire abandoned,
 * consultation-only) closes exactly as before.
 *
 * Set `CHEF_REQUIRE_COMPLETE_BOOK=false` to disable — an owner-level escape
 * hatch, not a model-facing one, so the agent cannot argue its way past it.
 */
/** Owner-level escape hatch for the whole `done` gate (not model-facing). */
function isCompletenessGateDisabled(): boolean {
  return process.env.CHEF_REQUIRE_COMPLETE_BOOK === 'false';
}

async function missingRecipeDishes(chef: ChefService, projectId: string): Promise<string[]> {
  if (isCompletenessGateDisabled()) return [];

  const menus = await chef.getMenusByProject(projectId);
  const latest = menus[0]; // getMenusByProject sorts by version desc
  if (!latest) return [];

  const dishNames = (latest.sections ?? []).flatMap((s) => (s.dishes ?? []).map((d) => d?.name)).filter(Boolean);
  if (dishNames.length === 0) return [];

  const recipes = await chef.getRecipesByProject(projectId);
  const norm = (v: string) => v.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const covered = new Set(recipes.map((r) => norm(r.dishName ?? '')));

  return dishNames.filter((name) => !covered.has(norm(name)));
}
