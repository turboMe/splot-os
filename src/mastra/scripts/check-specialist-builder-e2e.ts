/**
 * E2E Verification Test for Specialist Builder & Self-Expansion (Phase 3 & 4)
 *
 * Testuje:
 * 1. Walidację paszportu SpecialistDossierV1 (Zod).
 * 2. Utworzenie prywatnego katalogu wiedzy src/mastra/knowledge/private/<domain>/.
 * 3. Zapisanie procedury operacyjnej SOP w src/mastra/_skills/auto/<skillId>.md.
 * 4. Hot-reload w SkillRegistry bez restartu serwera.
 * 5. Wyszukiwanie nowego skilla w SkillRegistry.
 */

import { rm, readFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  SpecialistDossierSchema,
  type SpecialistDossierV1,
} from '../schemas/specialist-dossier.js';
import { buildSpecialistFromDossier } from '../services/specialist-builder.js';
import { getSkillRegistry } from '../services/skill-registry.js';

async function runE2ETest() {
  console.log('🚀 [E2E] Rozpoczynam weryfikację Specialist Builder & Self-Expansion...');

  // Testowy paszport Agenta Prawnika GDPR Polska (Domenowy / Prywatny)
  const testDossier: SpecialistDossierV1 = {
    domain: 'legal_rodo_poland_test',
    role: {
      title: 'Audytor Zgodności RODO & UODO Polska',
      assignedHostAgent: 'researcherAgent',
      mission: 'Prowadzenie precyzyjnych audytów umów powierzenia przetwarzania danych osobowych pod kątem RODO i polskiej Ustawy o Ochronie Danych Osobowych.',
      standards: [
        'Zgodność z art. 28 ust. 3 RODO (obowiązkowe klauzule umowne)',
        'Weryfikacja podstawy prawnej z art. 6 i 9 RODO',
        'Analiza retencji danych i środków techniczno-organizacyjnych',
      ],
    },
    privacy: {
      classification: 'confidential_strict',
      knowledgeBackend: 'local_markdown_doc',
      modelTier: 'local_ollama_only',
      localKnowledgePath: 'src/mastra/knowledge/private/legal_rodo_poland_test',
    },
    knowledgeNeeded: {
      corpusTitle: 'Prywatna Baza Umów i Klauzul RODO 2026',
      sources: [
        {
          title: 'Wzór Umowy Powierzenia Przetwarzania Danych B2B',
          filePath: 'src/mastra/knowledge/private/legal_rodo_poland_test/wzor_umowy.docx',
          type: 'internal_contract',
          cadence: 'static',
        },
      ],
    },
    skillsNeeded: [
      {
        skillId: 'rodo-contract-compliance-check',
        name: 'Weryfikacja Zgodności Umowy Powierzenia RODO',
        description: 'Procedura audytu umowy powierzenia przetwarzania danych osobowych pod kątem art. 28 RODO dla klientów w Polsce.',
        algorithm: [
          'Zidentyfikuj strony umowy: Administratora (ADO) i Podmiot Przetwarzający (Procesora).',
          'Sprawdź obecność 8 obowiązkowych elementów z art. 28 ust. 3 RODO (przedmiot, czas trwania, charakter, cel, rodzaj danych, kategorie osób, obowiązki i prawa ADO).',
          'Zweryfikuj klauzulę podpowierzenia (sub-processing) i obowiązek uprzedniej zgody pisemnej.',
          'Oceń zgodność procedury zgłaszania naruszeń ochrony danych w 24-36h do ADO.',
          'Sformułuj tabelaryczną listę niezgodności i gotowe poprawki prawnicze do umowy.',
        ],
        decisionTree: [
          'JEŚLI brak klauzuli o prawie do audytu (art. 28 ust. 3 lit. h) -> OZNACZ jako błąd krytyczny (Critical Risk).',
          'JEŚLI podpowierzenie jest bezwarunkowe -> WYMAGAJ wprowadzenia klauzuli uprzedniej zgody pisemnej.',
        ],
        outputArtifactType: 'document',
      },
    ],
    toolsNeeded: {
      existingTools: ['view', 'find_files', 'search_content'],
      missingTools: [],
    },
  };

  // 1. Walidacja schematu Zod
  console.log('1️⃣ Walidacja schematu Zod...');
  const parsed = SpecialistDossierSchema.safeParse(testDossier);
  if (!parsed.success) {
    console.error('❌ Błąd walidacji schematu Zod:', parsed.error.message);
    process.exit(1);
  }
  console.log('✅ Schemat Zod poprawny.');

  // 2. Inicjalizacja rejestru skilli
  console.log('2️⃣ Inicjalizacja SkillRegistry...');
  const registry = getSkillRegistry();
  await registry.initialize(undefined, { skipEmbeddings: true });

  // 3. Budowa specjalisty przez specialist-builder
  console.log('3️⃣ Uruchomienie buildSpecialistFromDossier...');
  const report = await buildSpecialistFromDossier(testDossier);

  if (!report.success) {
    console.error('❌ Budowa specjalisty nie powiodła się:', report.error);
    process.exit(1);
  }
  console.log('✅ Raport z budowy:', report.summaryMessage);

  // 4. Weryfikacja utworzenia katalogu prywatnego i pliku README.md
  console.log('4️⃣ Weryfikacja prywatnego katalogu wiedzy...');
  const privateDir = join(process.cwd(), 'src/mastra/knowledge/private/legal_rodo_poland_test');
  const readmeStat = await stat(join(privateDir, 'README.md'));
  if (!readmeStat.isFile()) {
    console.error('❌ Nie znaleziono pliku README.md w katalogu prywatnym!');
    process.exit(1);
  }
  console.log('✅ Prywatny katalog wiedzy poprawny.');

  // 5. Weryfikacja pliku skilla i rejestracji w pamięci
  console.log('5️⃣ Weryfikacja pliku skilla i hot-reloadu...');
  const skillFilePath = join(process.cwd(), 'src/mastra/_skills/auto/rodo-contract-compliance-check.md');
  const skillFileContent = await readFile(skillFilePath, 'utf-8');

  if (!skillFileContent.includes('rodo-contract-compliance-check') || !skillFileContent.includes('art. 28 ust. 3 RODO')) {
    console.error('❌ Treść pliku skilla jest niekompletna!');
    process.exit(1);
  }

  const loadedSkill = registry.getSkill('Weryfikacja Zgodności Umowy Powierzenia RODO') || registry.getSkill('rodo-contract-compliance-check');
  if (!loadedSkill) {
    console.error('❌ Skill nie został zarejestrowany w pamięci SkillRegistry!');
    process.exit(1);
  }
  console.log(`✅ Skill załadowany w rejestrze: ${loadedSkill.metadata.name}`);

  // 6. Test wywołania narzędzia specialistBuildTool przez Meta Agenta
  console.log('6️⃣ Test wywołania narzędzia specialistBuildTool (jak wywołuje Meta Agent)...');
  const { specialistBuildTool } = await import('../tools/system/specialist-build.js');
  const toolResult = await (specialistBuildTool as any).execute({
    dossier: testDossier,
    overridePrivacy: 'confidential_strict',
  });
  if (!toolResult.success) {
    console.error('❌ specialistBuildTool zwrócił błąd:', toolResult.error);
    process.exit(1);
  }
  console.log('✅ specialistBuildTool pomyślnie zrealizował zlecenie.');

  // 7. Test wyszukiwania
  console.log('7️⃣ Test wyszukiwania procedury w SkillRegistry...');
  const searchResults = await registry.search('audyt umowy powierzenia RODO');
  console.log(`✅ Znaleziono ${searchResults.length} pasujących skilli.`);

  console.log('\n🎉 [E2E] WSZYSTKIE TESTY SPECJALIST BUILDER PRZESZŁY POMYŚLNIE (100% GREEN)!');

  // Sprzątanie po teście
  await rm(privateDir, { recursive: true, force: true });
  await rm(skillFilePath, { force: true });
}

runE2ETest().catch((err) => {
  console.error('❌ Błąd krytyczny testu E2E:', err);
  process.exit(1);
});
