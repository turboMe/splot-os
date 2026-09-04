/**
 * Specialist Dossier Schema (V1)
 *
 * Paszport Specjalisty — ustrukturyzowany kontrakt rekonesansu domenowego
 * generowany przez researcherAgent przed przystąpieniem do budowy lub provisioningu.
 */

import { z } from 'zod';

export const SpecialistSourceSchema = z.object({
  url: z.string().url().optional().describe('Zweryfikowany link źródłowy (dla źródeł publicznych)'),
  filePath: z.string().optional().describe('Ścieżka do lokalnego pliku (dla źródeł prywatnych)'),
  title: z.string().min(3).describe('Oficjalny tytuł aktu, dokumentu lub szablonu'),
  type: z.enum([
    'statute',
    'official_guideline',
    'industry_standard',
    'documentation',
    'internal_contract',
    'sample_data',
  ]),
  cadence: z.enum(['static', 'monthly', 'quarterly', 'live']).default('static'),
});

export const PrivacyBoundarySchema = z.object({
  classification: z.enum([
    'public', // Wiedza ogólnodostępna (ustawy, docs)
    'internal_business', // Dane biznesowe firmy
    'confidential_strict', // Ściśle poufne, PII, finanse, umowy
  ]),
  knowledgeBackend: z.enum([
    'notebooklm_cloud', // Google NotebookLM
    'local_vector_rag', // Lokalny RAG bge-m3
    'local_markdown_doc', // Pliki markdown w katalogu lokalnym
    'none',
  ]),
  modelTier: z.enum([
    'cloud_standard', // Modele chmurowe (DeepSeek / Gemini)
    'local_ollama_only', // Modele lokalne Ollama (gemma4 / qwen3.6)
    'hybrid',
  ]),
  localKnowledgePath: z
    .string()
    .optional()
    .describe('Ścieżka do katalogu prywatnego, np. src/mastra/knowledge/private/<domain>'),
});

export const SpecialistSkillSpecSchema = z.object({
  skillId: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Identyfikator skilla (slug, np. rodo-poland-compliance)'),
  name: z.string().min(5).describe('Czytelna nazwa procedury'),
  description: z.string().min(15).describe('Kiedy i w jakich warunkach uruchamiać ten skill'),
  algorithm: z.array(z.string().min(10)).min(3).describe('Ścisły algorytm postępowania krok po kroku'),
  decisionTree: z.array(z.string()).optional().describe('Warunki brzegowe IF/THEN'),
  outputArtifactType: z.string().default('document').describe('Typ generowanego artefaktu'),
});

export const SpecialistDossierSchema = z.object({
  domain: z.string().regex(/^[a-z0-9_]+$/).describe('Identyfikator domeny, np. legal_rodo_poland'),
  role: z.object({
    title: z.string().min(5).describe('Tytuł specjalisty'),
    assignedHostAgent: z.enum([
      'researcherAgent',
      'salesAgent',
      'marketingAgent',
      'analyticsAgent',
      'automationArchitect',
      'codingAgent',
      'writerAgent',
      'chefAgent',
      'contentAgent',
      'huntAgent',
      'designAgent',
      'knowledgeAgent',
    ]),
    mission: z.string().min(20).describe('Główna misja i definicja sukcesu'),
    standards: z.array(z.string()).min(2).describe('Kluczowe kryteria jakościowe i zasady prawne/etyczne'),
  }),
  privacy: PrivacyBoundarySchema,
  knowledgeNeeded: z.object({
    corpusTitle: z.string().min(5).describe('Tytuł bazy wiedzy / notatnika'),
    sources: z.array(SpecialistSourceSchema).default([]),
  }),
  skillsNeeded: z.array(SpecialistSkillSpecSchema).min(1).describe('Wymagane procedury operacyjne SOP'),
  toolsNeeded: z.object({
    existingTools: z.array(z.string()).describe('Wymagane istniejące narzędzia w systemie'),
    missingTools: z
      .array(
        z.object({
          name: z.string(),
          purpose: z.string(),
          targetPlatform: z.enum(['mcp', 'n8n', 'local_tool']),
        }),
      )
      .default([]),
  }),
});

export type SpecialistDossierV1 = z.infer<typeof SpecialistDossierSchema>;
export type PrivacyBoundary = z.infer<typeof PrivacyBoundarySchema>;
export type SpecialistSkillSpec = z.infer<typeof SpecialistSkillSpecSchema>;
export type SpecialistSource = z.infer<typeof SpecialistSourceSchema>;
