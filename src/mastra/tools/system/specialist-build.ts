/**
 * System tool: Provision a new lightweight domain specialist from a SpecialistDossierV1.
 *
 * Umożliwia Meta Agentowi natychmiastowe utworzenie specjalisty domenowego:
 * 1. Opcjonalnie pobiera treść paszportu z Artifact Store (jeśli podano dossierArtifactId).
 * 2. Waliduje dane paszportu (SpecialistDossierSchema).
 * 3. Inicjalizuje bazę wiedzy (Google NotebookLM lub prywatny katalog src/mastra/knowledge/private/<domain>/).
 * 4. Generuje i zapisuje procedury operacyjne SOP w src/mastra/_skills/auto/<skillId>.md.
 * 5. Rejestruje skille w SkillRegistry (hot-reload w pamięci).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  SpecialistDossierSchema,
  type SpecialistDossierV1,
} from '../../schemas/specialist-dossier.js';
import { buildSpecialistFromDossier } from '../../services/specialist-builder.js';
import { getArtifact } from '../../services/artifact-store.js';

export const specialistBuildInputSchema = z.object({
  dossier: z
    .record(z.string(), z.any())
    .optional()
    .describe('Ustrukturyzowany obiekt paszportu specjalisty zgodny ze SpecialistDossierV1'),
  dossierArtifactId: z
    .string()
    .optional()
    .describe('Identyfikator artefaktu typu specialist_dossier w Artifact Store'),
  overridePrivacy: z
    .enum(['public', 'internal_business', 'confidential_strict'])
    .optional()
    .describe('Opcjonalne nadpisanie klasyfikacji poufności (np. po potwierdzeniu przez użytkownika)'),
});

export const specialistBuildTool = createTool({
  id: 'specialistBuildTool',
  description:
    'Buduje i aktywuje nowego specjalistę domenowego na podstawie paszportu SpecialistDossierV1 (tworzy katalogi wiedzy, zapisuje procedury SOP i rejestruje skille bez restartu serwera).',
  inputSchema: specialistBuildInputSchema,
  execute: async (context) => {
    try {
      let rawDossier: any = context.dossier;

      // Jeśli przekazano ID artefaktu, pobierz treść z Artifact Store
      if (!rawDossier && context.dossierArtifactId) {
        const artifact = await getArtifact(context.dossierArtifactId, { includeContent: true });
        if (!artifact || !artifact.content) {
          return {
            success: false,
            error: `Nie znaleziono artefaktu o ID: ${context.dossierArtifactId} lub brak treści.`,
          };
        }
        try {
          rawDossier = JSON.parse(artifact.content);
        } catch {
          return {
            success: false,
            error: `Treść artefaktu ${context.dossierArtifactId} nie jest poprawnym formatem JSON.`,
          };
        }
      }

      if (!rawDossier) {
        return {
          success: false,
          error: 'Wymagane jest podanie obiektu `dossier` lub identyfikatora `dossierArtifactId`.',
        };
      }

      // Opcjonalne nadpisanie prywatności wybrane przez użytkownika
      if (context.overridePrivacy && rawDossier.privacy) {
        rawDossier.privacy.classification = context.overridePrivacy;
        if (context.overridePrivacy !== 'public') {
          rawDossier.privacy.knowledgeBackend = 'local_markdown_doc';
          rawDossier.privacy.modelTier = 'local_ollama_only';
          rawDossier.privacy.localKnowledgePath = `src/mastra/knowledge/private/${rawDossier.domain}`;
        }
      }

      const parseResult = SpecialistDossierSchema.safeParse(rawDossier);
      if (!parseResult.success) {
        return {
          success: false,
          error: `Błąd walidacji paszportu: ${parseResult.error.message}`,
          issues: parseResult.error.issues,
        };
      }

      const buildReport = await buildSpecialistFromDossier(parseResult.data);
      return buildReport;
    } catch (err: any) {
      return {
        success: false,
        error: `Wyjątek podczas budowy specjalisty: ${err.message}`,
      };
    }
  },
});
