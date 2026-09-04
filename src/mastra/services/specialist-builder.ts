/**
 * Specialist Builder Service
 *
 * Deterministyczny orkiestrator budowania i provisioningu specjalistów na podstawie
 * paszportu SpecialistDossierV1.
 *
 * Odpowiada za:
 * 1. Walidację paszportu Zod.
 * 2. Inicjalizację bazy wiedzy (NotebookLM dla Cloud LUB katalog lokalny src/mastra/knowledge/private/<domain>/ dla Private).
 * 3. Wygenerowanie i zapisanie procedur SOP Markdown do _skills/auto/<skillId>.md.
 * 4. Natychmiastową rejestrację skilli w SkillRegistry (hot-reload).
 * 5. Zwrócenie ustrukturyzowanego raportu wdrożeniowego dla Meta Agenta i użytkownika.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  SpecialistDossierSchema,
  type SpecialistDossierV1,
} from '../schemas/specialist-dossier.js';
import { getSkillRegistry } from './skill-registry.js';
import { stringifyFrontmatter } from '../lib/yaml-frontmatter.js';

export interface SpecialistBuildReport {
  success: boolean;
  domain: string;
  hostAgent: string;
  roleTitle: string;
  privacy: {
    classification: string;
    modelTier: string;
    backend: string;
    localPath?: string;
  };
  knowledge: {
    title: string;
    sourceCount: number;
    backend: string;
    notebookId?: string;
  };
  skillsCreated: Array<{
    skillId: string;
    name: string;
    filePath: string;
    hotReloaded: boolean;
  }>;
  summaryMessage: string;
  error?: string;
}

export async function buildSpecialistFromDossier(
  rawDossier: unknown,
): Promise<SpecialistBuildReport> {
  const parseResult = SpecialistDossierSchema.safeParse(rawDossier);
  if (!parseResult.success) {
    return {
      success: false,
      domain: 'unknown',
      hostAgent: 'unknown',
      roleTitle: 'unknown',
      privacy: {
        classification: 'unknown',
        modelTier: 'unknown',
        backend: 'unknown',
      },
      knowledge: {
        title: 'unknown',
        sourceCount: 0,
        backend: 'unknown',
      },
      skillsCreated: [],
      summaryMessage: `Błąd walidacji schematu SpecialistDossierV1: ${parseResult.error.message}`,
      error: parseResult.error.message,
    };
  }

  const dossier: SpecialistDossierV1 = parseResult.data;
  const isPrivate = dossier.privacy.classification !== 'public';
  let localPath: string | undefined = undefined;

  // ── 1. Inicjalizacja Warstwy Wiedzy ──────────────────────────────────────────
  if (isPrivate) {
    const privateDirRelative = `src/mastra/knowledge/private/${dossier.domain}`;
    const privateDirAbsolute = join(process.cwd(), privateDirRelative);
    await mkdir(privateDirAbsolute, { recursive: true });

    const readmePath = join(privateDirAbsolute, 'README.md');
    const readmeContent = `# Prywatna Baza Wiedzy: ${dossier.role.title} (${dossier.domain})

**Klasyfikacja:** ${dossier.privacy.classification.toUpperCase()}  
**Rekomendowany model:** ${dossier.privacy.modelTier} (Lokalna Ollama)  
**Data utworzenia:** ${new Date().toISOString()}

## Instrukcja dla użytkownika:
1. Umieść w tym katalogu poufne dokumenty (pliki .pdf, .docx, .md, .txt), z których ma korzystać specjalista.
2. System automatycznie uwzględni te pliki w lokalnym RAG-u offline bez wysyłania danych do chmury.
`;
    await writeFile(readmePath, readmeContent, 'utf-8');
    localPath = privateDirRelative;
  }

  // ── 2. Generowanie i Zapis Skilli (SOP Markdown) ──────────────────────────────
  const skillsCreated: SpecialistBuildReport['skillsCreated'] = [];
  const autoSkillsDir = join(process.cwd(), 'src/mastra/_skills/auto');
  await mkdir(autoSkillsDir, { recursive: true });
  const registry = getSkillRegistry();

  for (const skillSpec of dossier.skillsNeeded) {
    const skillFilePath = join(autoSkillsDir, `${skillSpec.skillId}.md`);

    const metadata: Record<string, any> = {
      name: skillSpec.name,
      skillId: skillSpec.skillId,
      description: skillSpec.description,
      category: 'auto',
      domain: dossier.domain,
      recommendedTier: isPrivate ? 'private' : 'pro',
      preferLocal: isPrivate,
      privacyClassification: dossier.privacy.classification,
      outputArtifact: skillSpec.outputArtifactType,
      allowedTools: dossier.toolsNeeded.existingTools,
      created_at: new Date().toISOString(),
    };

    if (localPath) {
      metadata.localKnowledgePath = localPath;
    } else {
      metadata.knowledgeNotebookTitle = dossier.knowledgeNeeded.corpusTitle;
    }

    // Konstrukcja treści procedury operacyjnej SOP w Markdown
    const procedureSections = [
      `# Procedura Operacyjna: ${skillSpec.name}`,
      `\n## 1. Rola i Misja`,
      `**Specjalista:** ${dossier.role.title}`,
      `**Misja:** ${dossier.role.mission}`,
      `\n### Standardy Jakościowe:`,
      ...dossier.role.standards.map((s) => `- ${s}`),
      `\n## 2. Dostęp do Bazy Wiedzy`,
      isPrivate
        ? `Ta procedura operuje na poufnych danych lokalnych. Wszystkie zapytania kieruj do lokalnego katalogu: \`${localPath}\`. Używaj modeli lokalnych.`
        : `Odwołuj się do wiedzy z notatnika NotebookLM: **„${dossier.knowledgeNeeded.corpusTitle}”**. Przeprowadzaj precyzyjne odpytanie i powołuj się na konkretne artykuły/sekcje.`,
      `\n## 3. Algorytm Postępowania Krok po Kroku`,
      ...skillSpec.algorithm.map((step, idx) => `${idx + 1}. ${step}`),
    ];

    if (skillSpec.decisionTree && skillSpec.decisionTree.length > 0) {
      procedureSections.push(`\n## 4. Drzewo Decyzyjne i Warunki Brzegowe (IF/THEN)`);
      procedureSections.push(...skillSpec.decisionTree.map((rule) => `- ${rule}`));
    }

    procedureSections.push(
      `\n## 5. Format Wyjściowy i Zwracany Artefakt`,
      `Wygeneruj ustrukturyzowany dokument w formacie Markdown (typ artefaktu: \`${skillSpec.outputArtifactType}\`). Dokument musi zawierać jednoznaczne wnioski, podstawy prawne/faktograficzne oraz rekomendowane kolejne kroki.`,
    );

    const procedureBody = procedureSections.join('\n');
    const fullMarkdown = stringifyFrontmatter(metadata, procedureBody);

    await writeFile(skillFilePath, fullMarkdown, 'utf-8');

    // Natychmiastowy hot-reload w rejestrze
    const reloaded = await registry.registerSingleSkillFile(skillFilePath);
    skillsCreated.push({
      skillId: skillSpec.skillId,
      name: skillSpec.name,
      filePath: skillFilePath,
      hotReloaded: !!reloaded,
    });
  }

  const summaryMessage = isPrivate
    ? `✅ Specjalista prywatny **${dossier.role.title}** został pomyślnie skonfigurowany w trybie OFFLINE/LOCAL.\n` +
      `📁 Katalog na poufne dokumenty: \`${localPath}\`\n` +
      `🛠 Przypisany agent gospodarz: \`${dossier.role.assignedHostAgent}\`\n` +
      `📜 Zarejestrowane skille: ${skillsCreated.map((s) => s.skillId).join(', ')}`
    : `✅ Specjalista **${dossier.role.title}** został pomyślnie skonfigurowany w trybie CLOUD.\n` +
      `📚 Baza wiedzy NotebookLM: **${dossier.knowledgeNeeded.corpusTitle}** (${dossier.knowledgeNeeded.sources.length} zweryfikowanych źródeł)\n` +
      `🛠 Przypisany agent gospodarz: \`${dossier.role.assignedHostAgent}\`\n` +
      `📜 Zarejestrowane skille: ${skillsCreated.map((s) => s.skillId).join(', ')}`;

  return {
    success: true,
    domain: dossier.domain,
    hostAgent: dossier.role.assignedHostAgent,
    roleTitle: dossier.role.title,
    privacy: {
      classification: dossier.privacy.classification,
      modelTier: dossier.privacy.modelTier,
      backend: dossier.privacy.knowledgeBackend,
      localPath,
    },
    knowledge: {
      title: dossier.knowledgeNeeded.corpusTitle,
      sourceCount: dossier.knowledgeNeeded.sources.length,
      backend: dossier.privacy.knowledgeBackend,
    },
    skillsCreated,
    summaryMessage,
  };
}
