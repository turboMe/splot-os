/**
 * VoiceStudio Mastra Tools (SPLOT OS)
 *
 * Tools enabling Writer Agent and orchestrators to synthesize audiobooks and stories
 * directly via the local VoiceStudio (OmniVoice) Docker service, saving final artifacts
 * directly to /projekty/splot-projects with automated Two-Stage VRAM reclamation (Wariant A).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getVoiceStudioService, PATRYK_VOICES, type VoiceLanguage } from '../../services/voicestudio-service.js';
import { getGpuArbiter } from '../../services/gpu-arbiter.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const audiobookRenderInputSchema = z.object({
  text: z.string().min(1).describe(
    'Treść skryptu w formacie Markdown z nagłówkami rozdziałów "# Rozdział 1: Tytuł" oraz opcjonalnymi znacznikami obsady [voice:Nazwa].',
  ),
  language: z.enum(['pl', 'en', 'both']).default('pl').describe(
    'Język nagrania: "pl" dla głosu polskiego (patryk-polish-voice), "en" dla głosu angielskiego (patryk-english-voice), lub "both" jeśli potrzebne są dwa pliki.',
  ),
  englishText: z.string().optional().describe(
    'Opcjonalny przetłumaczony skrypt po angielsku w przypadku wyboru language: "both". Jeśli nie podano, użyta zostanie treść główna.',
  ),
  title: z.string().optional().describe('Tytuł książki lub opowiadania do metadanych i nazwy pliku.'),
  author: z.string().default('Patryk').describe('Autor / narrator książki (domyślnie Patryk).'),
  projectSlug: z.string().optional().describe(
    'Identyfikator/slug projektu w /projekty/splot-projects/writer-books/<projectSlug>/audio/. Jeśli brak, plik trafi do /projekty/splot-projects/audio/.',
  ),
  format: z.enum(['m4b', 'mp3']).default('m4b').describe('Format wyjściowy: m4b (z rozdziałami i okładką) lub mp3.'),
  bitrate: z.enum(['128k', '192k']).default('128k').describe('Bitrate audio (domyślnie 128k).'),
  loudness: z.enum(['acx', 'podcast', 'ebu_r128', 'off']).default('acx').describe(
    'Normalizacja głośności: acx (Audible/standard audiobooków), podcast, ebu_r128 lub off.',
  ),
  voiceProfileId: z.string().optional().describe(
    'Opcjonalne bezpośrednie ID profilu głosu (np. eab289ea dla PL, c310508f dla EN). Jeśli nie podano, dobierany automatycznie wg parametru language.',
  ),
  postprocessOutput: z.boolean().default(false).describe(
    'Czy przycinać cisze/oddechy agresywną bramką -50 dBFS (Postprocessing). Zawsze domyślnie false, aby zapobiec ucinaniu głosu i zachować naturalne pauzy oraz oddechy.',
  ),
});

const freeVramInputSchema = z.object({
  mode: z.enum(['soft_flush', 'hard_shutdown']).default('soft_flush').describe(
    'Tryb zwolnienia pamięci GPU: "soft_flush" zrzuca model i czyści cache cuBLAS/PyTorch (kontener czeka w gotowości); "hard_shutdown" zatrzymuje kontener Docker, uwalniając 100% VRAM do 0 MiB.',
  ),
});

const statusInputSchema = z.object({});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const voiceStudioRenderAudiobookTool = createTool({
  id: 'voicestudio_render_audiobook',
  description:
    'Renderuje pełny audiobook lub opowiadanie za pośrednictwem lokalnego VoiceStudio (OmniVoice). Generuje plik .m4b/.mp3, przenosi go bezpośrednio do /projekty/splot-projects oraz automatycznie zwalnia VRAM karty RTX (Wariant A). Obsługuje język polski (patryk-polish-voice), angielski (patryk-english-voice) lub oba na raz ("both").',
  inputSchema: audiobookRenderInputSchema,
  execute: async (context) => {
    const service = getVoiceStudioService();
    const gpuArbiter = getGpuArbiter();

    return await gpuArbiter.withGpuLock(
      'voicestudio',
      async () => {
        if (context.language === 'both') {
          const result = await service.generateDualAudiobook(
            context.text,
            context.englishText || context.text,
            {
              projectSlug: context.projectSlug,
              title: context.title,
              author: context.author,
              format: context.format,
              bitrate: context.bitrate,
              loudness: context.loudness,
              postprocessOutput: context.postprocessOutput,
            },
          );

          return {
            success: true,
            mode: 'dual',
            polish: {
              audioPath: result.polish.audioPath,
              filename: result.polish.filename,
              metadataPath: result.polish.metadataPath,
              durationSeconds: result.polish.durationSeconds,
              chaptersCount: result.polish.chaptersCount,
              voice: result.polish.voiceName,
            },
            english: {
              audioPath: result.english.audioPath,
              filename: result.english.filename,
              metadataPath: result.english.metadataPath,
              durationSeconds: result.english.durationSeconds,
              chaptersCount: result.english.chaptersCount,
              voice: result.english.voiceName,
            },
            vramReclaimed: true,
            message: 'Wygenerowano pomyślnie dwa pliki audio (PL + EN) w /projekty/splot-projects oraz wykonano Soft Flush VRAM.',
          };
        }

        const singleResult = await service.generateAudiobook({
          text: context.text,
          language: context.language as VoiceLanguage,
          voiceProfileId: context.voiceProfileId,
          projectSlug: context.projectSlug,
          title: context.title,
          author: context.author,
          format: context.format,
          bitrate: context.bitrate,
          loudness: context.loudness,
          postprocessOutput: context.postprocessOutput,
        });

        return {
          success: true,
          mode: 'single',
          audioPath: singleResult.audioPath,
          filename: singleResult.filename,
          metadataPath: singleResult.metadataPath,
          durationSeconds: singleResult.durationSeconds,
          chaptersCount: singleResult.chaptersCount,
          language: singleResult.language,
          voiceName: singleResult.voiceName,
          voiceProfileId: singleResult.voiceProfileId,
          format: singleResult.format,
          vramReclaimed: singleResult.vramFlushed,
          message: `Wygenerowano plik audio "${singleResult.filename}" w /projekty/splot-projects oraz wykonano Soft Flush VRAM.`,
        };
      },
      { operation: 'render_audiobook', requestedBy: 'voicestudio_render_audiobook' },
    );
  },
});

export const voiceStudioFreeVramTool = createTool({
  id: 'voicestudio_free_vram',
  description:
    'Zarządza zwalnianiem pamięci VRAM VoiceStudio na GPU: "soft_flush" zrzuca wagi modeli; "hard_shutdown" zatrzymuje kontener Docker, uwalniając 100% VRAM (0 MiB).',
  inputSchema: freeVramInputSchema,
  execute: async (context) => {
    const service = getVoiceStudioService();

    if (context.mode === 'hard_shutdown') {
      const res = await service.stopContainer();
      return {
        success: res.success,
        mode: 'hard_shutdown',
        message: res.success
          ? 'Kontener omnivoice został zatrzymany. Pamięć VRAM została zwolniona w 100% (0 MiB).'
          : `Błąd zatrzymania kontenera: ${res.error}`,
      };
    }

    const flushRes = await service.flushVram();
    return {
      success: flushRes.success,
      mode: 'soft_flush',
      vramAfter: flushRes.vramAfter,
      message: flushRes.success
        ? 'Wagi modeli VoiceStudio zostały zrzucone, cache CUDA wyczyszczony (Soft Flush).'
        : `Błąd podczas Soft Flush: ${flushRes.error}`,
    };
  },
});

export const voiceStudioGetStatusTool = createTool({
  id: 'voicestudio_get_status',
  description:
    'Sprawdza stan kontenera VoiceStudio (OmniVoice), dostępność API oraz skonfigurowane profile głosów (patryk-polish-voice i patryk-english-voice).',
  inputSchema: statusInputSchema,
  execute: async () => {
    const service = getVoiceStudioService();
    const running = service.isContainerRunning();
    const health = await service.checkHealth();

    return {
      containerRunning: running,
      apiAvailable: health.available,
      device: health.device || 'unknown',
      version: health.version || 'unknown',
      voices: {
        polish: PATRYK_VOICES.pl,
        english: PATRYK_VOICES.en,
      },
    };
  },
});
