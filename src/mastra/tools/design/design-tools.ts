import { createTool } from '@mastra/core/tools';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { designAssignments, models, type ModelKey } from '../../config/model-manifest.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const googleImageModelAliases = [
  'gemini-image-pro',
  'gemini-image-flash',
  'imagen-4-fast',
  'imagen-4',
  'imagen-4-ultra',
] as const;
const openAiImageModelAliases = [
  'gpt-image-2',
  'gpt-image-1',
] as const;
const imageModelAliases = [
  ...googleImageModelAliases,
  ...openAiImageModelAliases,
] as const;
const elevenLabsTtsModelAliases = [
  'eleven-v3',
  'eleven-multilingual-v2',
  'eleven-turbo-v2.5',
] as const;
const aspectRatioSchema = z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']);
const openAiImageSizeSchema = z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const openAiImageQualitySchema = z.enum(['low', 'medium', 'high', 'auto']);
const openAiImageFormatSchema = z.enum(['png', 'webp', 'jpeg']);
const openAiImageBackgroundSchema = z.enum(['transparent', 'opaque', 'auto']);
const generatedImageSourceSchema = z.enum(['google-gemini', 'google-imagen', 'openai-image']);

type ExecFailure = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

function resolveDesignSkillRoot(): string {
  const candidates = [
    process.env.DESIGN_SKILL_ROOT,
    // Source/dev runtime from repo root.
    join(process.cwd(), 'storage/repos_external/huashu-design'),
    // Mastra deploy output sometimes runs from .mastra/output.
    resolve(process.cwd(), '../../storage/repos_external/huashu-design'),
    // Running commands from the monorepo parent.
    join(process.cwd(), 'agentic-agents/storage/repos_external/huashu-design'),
    // Source TypeScript location: src/mastra/tools/design -> repo root.
    resolve(__dirname, '../../../../storage/repos_external/huashu-design'),
    // Bundled tool location: .mastra/output/tools -> repo root.
    resolve(__dirname, '../../../storage/repos_external/huashu-design'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  const root = candidates.find((candidate) => existsSync(join(candidate, 'SKILL.md')));
  if (!root) {
    throw new Error(`huashu-design source repo not found. Tried: ${candidates.join(', ')}`);
  }
  return root;
}

export function resolveWorkspacePath(pathValue: string): string {
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(process.cwd(), pathValue);
  const skillRoot = resolveDesignSkillRoot();
  if (target === skillRoot || target.startsWith(`${skillRoot}/`)) {
    throw new Error('Refusing to write generated design output into the read-only huashu-design source repo.');
  }
  return target;
}

function parseFetchImagesManifest(stdout: string): Array<{
  path: string;
  license: string;
  author: string;
  sourceUrl: string;
}> {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('[OK] '))
    .map((line) => {
      const withoutPrefix = line.replace(/^\[OK\]\s+/, '');
      const [path = '', license = '', author = '', sourceUrl = ''] = withoutPrefix
        .split('|')
        .map((part) => part.trim());
      return { path, license, author, sourceUrl };
    })
    .filter((entry) => entry.path.length > 0);
}

/** Image extensions a browser will actually render. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif']);

/**
 * The real image type, read from the file's first bytes.
 *
 * Sniffed rather than taken from the URL because the URL is precisely what
 * proved unreliable — see `normalizeFetchedImageNames` below.
 */
function sniffImageExtension(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head.length >= 6 && head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return '.gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (head.length >= 12 && head.subarray(4, 12).toString('latin1') === 'ftypavif') return '.avif';
  const text = head.subarray(0, 256).toString('utf8').trimStart();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return '.svg';
  return null;
}

/**
 * Repair filenames the upstream fetch script mangles.
 *
 * `fetch_images.py` lives in the READ-ONLY huashu-design repo, so this is fixed
 * where we are allowed to fix it: after the download, before the agent is told
 * where the files are. Its naming line is
 *
 *     ext = os.path.splitext(thumb)[1].split("?")[0] or ".jpg"
 *
 * which assumes the thumbnail URL ends in `.jpg` and separates its query with
 * `?`. Wikimedia hands back URLs that do neither, so `splitext` returns
 * everything after the last dot in the HOST and the `.split("?")` never fires.
 * Observed live on the design canary:
 *
 *     coffee_beans_specialty_Congressional_Research_Service_R.org&utm_campaign=imageinfo&utm_content=thumbnail
 *
 * A file with no usable extension: an `<img src>` pointing at it renders as a
 * broken image, and the visual QA step cannot tell that from a design mistake.
 *
 * Returns the manifest with corrected paths, so nothing downstream ever sees the
 * mangled name.
 */
async function normalizeFetchedImageNames(
  images: Array<{ path: string; license: string; author: string; sourceUrl: string }>,
): Promise<Array<{ path: string; license: string; author: string; sourceUrl: string }>> {
  const out: typeof images = [];
  for (const image of images) {
    out.push({ ...image, path: await normalizeOneImageName(image.path) });
  }
  return out;
}

/**
 * Parse a script manifest and repair the names it reports, in one step.
 *
 * Exported so the regression test drives the same pair the tool runs, rather
 * than a reimplementation of it.
 */
export async function repairFetchedImageManifest(stdout: string): Promise<Array<{
  path: string; license: string; author: string; sourceUrl: string;
}>> {
  return normalizeFetchedImageNames(parseFetchImagesManifest(stdout));
}

async function normalizeOneImageName(filePath: string): Promise<string> {
  try {
    const dir = dirname(filePath);
    const name = basename(filePath);

    // Everything from the first query/fragment separator is URL debris, not a name.
    const withoutQuery = name.split(/[?&#]/)[0] ?? name;
    const currentExt = extname(withoutQuery).toLowerCase();
    const stem = IMAGE_EXTENSIONS.has(currentExt)
      ? withoutQuery.slice(0, -currentExt.length)
      : withoutQuery.replace(/\.[^.]*$/, '');

    const handle = await readFile(filePath);
    const sniffed = sniffImageExtension(handle.subarray(0, 512));
    // Keep a already-valid extension when the bytes are unrecognised; only fall
    // back to .jpg when there is nothing else to go on (the upstream default).
    const ext = sniffed ?? (IMAGE_EXTENSIONS.has(currentExt) ? currentExt : '.jpg');
    if (`${stem}${ext}` === name) return filePath;

    // Never clobber a different image that already claims the name.
    let candidate = resolve(dir, `${stem}${ext}`);
    for (let n = 2; existsSync(candidate) && candidate !== filePath; n++) {
      candidate = resolve(dir, `${stem}-${n}${ext}`);
    }
    await copyFile(filePath, candidate);
    await rm(filePath, { force: true });
    return candidate;
  } catch {
    // A rename is a convenience, never a reason to fail a completed download.
    return filePath;
  }
}

function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'brand';
}

function simpleIconsSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return slug || safeSlug(value);
}

async function listFilesFlat(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

type SvglRoute = string | { light?: string; dark?: string };

interface SvglLogo {
  title?: string;
  route?: SvglRoute;
  url?: string;
  brandUrl?: string;
}

function selectSvglRoute(route: SvglRoute | undefined, theme: 'light' | 'dark'): string | null {
  if (!route) return null;
  if (typeof route === 'string') return route;
  return route[theme] ?? route.light ?? route.dark ?? null;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'mastra-design-agent/0.1' },
  });
  if (!response.ok) return null;
  const text = await response.text();
  return text.includes('<svg') ? text : null;
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'mastra-design-agent/0.1' },
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

function hostnameFromUrl(urlValue: string | undefined): string | null {
  if (!urlValue) return null;
  try {
    return new URL(urlValue).hostname;
  } catch {
    return null;
  }
}

type GeneratedImageSource = z.infer<typeof generatedImageSourceSchema>;

function resolveDesignImageModelAlias(alias: ModelKey): {
  source: GeneratedImageSource;
  apiModelId: string;
  fullModelId: string;
} {
  const modelId = models[alias];
  if (modelId.startsWith('google/')) {
    const apiModelId = modelId.slice('google/'.length);
    return {
      source: apiModelId.startsWith('gemini-') ? 'google-gemini' : 'google-imagen',
      apiModelId,
      fullModelId: modelId,
    };
  }
  if (modelId.startsWith('openai/')) {
    return {
      source: 'openai-image',
      apiModelId: modelId.slice('openai/'.length),
      fullModelId: modelId,
    };
  }
  throw new Error(`design_generate_image supports Google and OpenAI image models only; got ${modelId}`);
}

function resolveElevenLabsModelAlias(alias: ModelKey): string {
  const modelId = models[alias];
  if (!modelId.startsWith('elevenlabs/')) {
    throw new Error(`design_tts currently supports ElevenLabs TTS models only; got ${modelId}`);
  }
  return modelId.slice('elevenlabs/'.length);
}

function mimeTypeForPath(pathValue: string): string {
  const ext = extname(pathValue).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

async function readReferenceImage(pathValue: string): Promise<{ data: string; mimeType: string; path: string }> {
  const path = resolveWorkspacePath(pathValue);
  const data = await readFile(path);
  return {
    data: data.toString('base64'),
    mimeType: mimeTypeForPath(path),
    path,
  };
}

function detectGeneratedImageMime(base64Value: string): string {
  const bytes = Buffer.from(base64Value.slice(0, 32), 'base64');
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return 'image/png';
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/svg+xml') return '.svg';
  return '.png';
}

function normalizeImageBase64(value: string): string {
  const commaIndex = value.indexOf(',');
  if (value.startsWith('data:') && commaIndex >= 0) {
    return value.slice(commaIndex + 1);
  }
  return value;
}

function googleApiHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
    'user-agent': 'mastra-design-agent/0.1',
  };
}

function openAiApiHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': 'mastra-design-agent/0.1',
  };
}

function openAiSizeForAspectRatio(aspectRatio: z.infer<typeof aspectRatioSchema>): z.infer<typeof openAiImageSizeSchema> {
  if (aspectRatio === '3:4' || aspectRatio === '9:16') return '1024x1536';
  if (aspectRatio === '4:3' || aspectRatio === '16:9') return '1536x1024';
  return '1024x1024';
}

function mimeTypeForOpenAiFormat(format: z.infer<typeof openAiImageFormatSchema>): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function replaceExtension(pathValue: string, suffix: string, ext: string): string {
  const dir = dirname(pathValue);
  const base = basename(pathValue, extname(pathValue));
  return join(dir, `${base}${suffix}${ext}`);
}

async function runDesignScript(command: string, args: string[], timeoutMs: number): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | string;
  error?: string;
}> {
  const skillRoot = resolveDesignSkillRoot();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: skillRoot,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    const err = error as ExecFailure;
    return {
      success: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code,
      error: err.message,
    };
  }
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

function durationFromElevenAlignment(rawResponse: unknown): number | null {
  const normalized = (rawResponse as any)?.normalized_alignment ?? (rawResponse as any)?.alignment;
  const endTimes = normalized?.character_end_times_seconds;
  if (!Array.isArray(endTimes) || endTimes.length === 0) return null;
  const duration = Number(endTimes[endTimes.length - 1]);
  return Number.isFinite(duration) ? duration : null;
}

async function synthesizeElevenLabsSpeech(options: {
  text: string;
  outPath: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  withTimestamps: boolean;
  languageCode?: string;
  seed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
  previousText?: string;
  nextText?: string;
  timeoutMs: number;
}): Promise<{
  success: boolean;
  path: string;
  duration: number | null;
  bytes: number;
  textChars: number;
  alignmentPath?: string;
  rawResponse?: unknown;
  error?: string;
}> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      path: options.outPath,
      duration: null,
      bytes: 0,
      textChars: options.text.length,
      error: 'ELEVENLABS_API_KEY is not set; cannot synthesize speech.',
    };
  }

  await mkdir(dirname(options.outPath), { recursive: true });

  const endpoint = options.withTimestamps
    ? `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId)}/with-timestamps`
    : `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId)}`;
  const url = `${endpoint}?output_format=${encodeURIComponent(options.outputFormat)}`;

  const voiceSettings: Record<string, number | boolean> = {};
  if (options.stability !== undefined) voiceSettings.stability = options.stability;
  if (options.similarityBoost !== undefined) voiceSettings.similarity_boost = options.similarityBoost;
  if (options.style !== undefined) voiceSettings.style = options.style;
  if (options.speed !== undefined) voiceSettings.speed = options.speed;
  if (options.useSpeakerBoost !== undefined) voiceSettings.use_speaker_boost = options.useSpeakerBoost;

  const body = {
    text: options.text,
    model_id: options.modelId,
    ...(options.languageCode ? { language_code: options.languageCode } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(Object.keys(voiceSettings).length > 0 ? { voice_settings: voiceSettings } : {}),
    ...(options.previousText ? { previous_text: options.previousText } : {}),
    ...(options.nextText ? { next_text: options.nextText } : {}),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': apiKey,
      'user-agent': 'mastra-design-agent/0.1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      path: options.outPath,
      duration: null,
      bytes: 0,
      textChars: options.text.length,
      error: `ElevenLabs TTS failed with HTTP ${response.status}: ${errorText.slice(0, 500)}`,
    };
  }

  let audio: Buffer;
  let rawResponse: unknown;
  let alignmentPath: string | undefined;
  if (options.withTimestamps) {
    rawResponse = await response.json();
    const audioBase64 = (rawResponse as any)?.audio_base64;
    if (!audioBase64) {
      return {
        success: false,
        path: options.outPath,
        duration: null,
        bytes: 0,
        textChars: options.text.length,
        rawResponse,
        error: 'ElevenLabs timing response did not include audio_base64.',
      };
    }
    audio = Buffer.from(String(audioBase64), 'base64');
    alignmentPath = replaceExtension(options.outPath, '.alignment', '.json');
    await writeFile(alignmentPath, JSON.stringify({
      alignment: (rawResponse as any).alignment,
      normalized_alignment: (rawResponse as any).normalized_alignment,
    }, null, 2));
  } else {
    audio = Buffer.from(await response.arrayBuffer());
  }

  await writeFile(options.outPath, audio);
  const probedDuration = await probeDurationSeconds(options.outPath);
  const alignmentDuration = rawResponse ? durationFromElevenAlignment(rawResponse) : null;
  return {
    success: true,
    path: options.outPath,
    duration: probedDuration ?? alignmentDuration,
    bytes: audio.byteLength,
    textChars: options.text.length,
    alignmentPath,
    rawResponse,
  };
}

function parseSimpleFrontmatter(value: string): { meta: Record<string, string>; body: string } {
  const match = value.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { meta: {}, body: value };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: value.slice(match[0].length) };
}

function parseNarrationScript(value: string): { meta: Record<string, string>; scenes: Array<{ id: string; raw: string }> } {
  const { meta, body } = parseSimpleFrontmatter(value);
  const scenes: Array<{ id: string; raw: string }> = [];
  const re = /^##\s+([\w-]+)\s*\n([\s\S]*?)(?=^##\s+[\w-]+\s*\n|$(?![\r\n]))/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    scenes.push({ id: match[1], raw: match[2].trim() });
  }
  return { meta, scenes };
}

function splitTextByCues(text: string): Array<{ text: string; cueAfter?: string }> {
  const chunks: Array<{ text: string; cueAfter?: string }> = [];
  const re = /\[\[cue:([\w-]+)\]\]/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index).trim();
    chunks.push({ text: before, cueAfter: match[1] });
    lastIdx = match.index + match[0].length;
  }
  const tail = text.slice(lastIdx).trim();
  chunks.push({ text: tail });
  return chunks.filter((chunk) => chunk.text.length > 0 || chunk.cueAfter);
}

function stripCueMarkers(text: string): string {
  return text.replace(/\[\[cue:[\w-]+\]\]/g, '');
}

function ffmpegConcatLine(pathValue: string): string {
  return `file '${pathValue.replace(/'/g, "'\\''")}'`;
}

async function concatAudioFiles(inputs: string[], output: string): Promise<void> {
  const listFile = `${output}.list`;
  await writeFile(listFile, inputs.map(ffmpegConcatLine).join('\n'));
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-c',
      'copy',
      output,
    ], {
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    await rm(listFile, { force: true });
  }
}

async function makeSilenceMp3(duration: number, output: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=24000:cl=mono',
    '-t',
    String(duration),
    '-q:a',
    '9',
    '-acodec',
    'libmp3lame',
    output,
  ], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const fetchImagesOutputSchema = z.object({
  success: z.boolean(),
  outputDir: z.string(),
  images: z.array(z.object({
    path: z.string(),
    license: z.string(),
    author: z.string(),
    sourceUrl: z.string(),
  })),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.union([z.number(), z.string()]).optional(),
  error: z.string().optional(),
});

export const designFetchImagesTool = createTool({
  id: 'design_fetch_images',
  description:
    'Fetches real content images from Wikimedia Commons using the huashu-design fetch_images.py script. Use for content-essential design images before creating visual directions.',

  inputSchema: z.object({
    query: z.array(z.string().min(1)).min(1).max(12).describe('English Wikimedia Commons search queries. English usually has the best hit rate.'),
    outDir: z.string().default('design-work/assets/img').describe('Output directory for downloaded images. Relative paths resolve from the project root.'),
    count: z.number().int().min(1).max(10).default(2).describe('Images to fetch per query.'),
    width: z.number().int().min(320).max(4096).default(1600).describe('Requested thumbnail width in pixels.'),
    timeoutMs: z.number().int().min(10_000).max(300_000).default(120_000),
  }),

  outputSchema: fetchImagesOutputSchema,

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const script = join(skillRoot, 'scripts', 'fetch_images.py');
    const outDir = resolveWorkspacePath(input.outDir ?? 'design-work/assets/img');
    const count = input.count ?? 2;
    const width = input.width ?? 1600;
    const timeoutMs = input.timeoutMs ?? 120_000;
    await mkdir(outDir, { recursive: true });

    const args = [
      script,
      '--query',
      ...input.query,
      '--out',
      outDir,
      '--count',
      String(count),
      '--width',
      String(width),
    ];

    try {
      const { stdout, stderr } = await execFileAsync('python3', args, {
        cwd: skillRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        success: true,
        outputDir: outDir,
        images: await normalizeFetchedImageNames(parseFetchImagesManifest(stdout)),
        stdout,
        stderr,
      };
    } catch (error) {
      const err = error as ExecFailure;
      return {
        success: false,
        outputDir: outDir,
        // Partial downloads are still real files the agent may use — repair the
        // names of whatever landed before the failure.
        images: await normalizeFetchedImageNames(parseFetchImagesManifest(err.stdout ?? '')),
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: err.code,
        error: err.message,
      };
    }
  },
});

const brandAssetSchema = z.object({
  brand: z.string(),
  success: z.boolean(),
  source: z.enum(['svgl', 'simpleicons', 'favicon']).optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  sourceUrl: z.string().optional(),
  homepage: z.string().optional(),
  error: z.string().optional(),
});

export const designFetchBrandAssetsTool = createTool({
  id: 'design_fetch_brand_assets',
  description:
    'Fetches recognizable brand logo assets for named brands. Tries SVGL search first, then Simple Icons CDN, then Google favicon if a domain can be inferred or provided.',

  inputSchema: z.object({
    brands: z
      .array(z.object({
        name: z.string().min(1).describe('Brand or product name, e.g. Stripe, OpenAI, DJI.'),
        domain: z.string().optional().describe('Optional official domain for favicon fallback, e.g. stripe.com.'),
      }))
      .min(1)
      .max(30),
    outDir: z.string().default('design-work/assets/brand').describe('Output directory for brand assets. Relative paths resolve from the project root.'),
    theme: z.enum(['light', 'dark']).default('light').describe('Preferred SVGL theme when both light and dark logo variants exist.'),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    outputDir: z.string(),
    assets: z.array(brandAssetSchema),
  }),

  execute: async (input) => {
    const outDir = resolveWorkspacePath(input.outDir ?? 'design-work/assets/brand');
    const theme = input.theme ?? 'light';
    const timeoutMs = input.timeoutMs ?? 15_000;
    await mkdir(outDir, { recursive: true });

    const assets: z.infer<typeof brandAssetSchema>[] = [];

    for (const brand of input.brands) {
      const slug = safeSlug(brand.name);
      let discoveredHomepage: string | undefined;

      try {
        const svglSearchUrl = `https://api.svgl.app?search=${encodeURIComponent(brand.name)}`;
        const svglResponse = await fetch(svglSearchUrl, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'mastra-design-agent/0.1' },
        });
        const svglResults = svglResponse.ok ? (await svglResponse.json() as SvglLogo[]) : [];
        const svglMatch = svglResults.find((item) => item.title?.toLowerCase() === brand.name.toLowerCase()) ?? svglResults[0];
        discoveredHomepage = svglMatch?.brandUrl ?? svglMatch?.url;
        const svglRoute = selectSvglRoute(svglMatch?.route, theme);
        if (svglRoute) {
          const svg = await fetchText(svglRoute, timeoutMs);
          if (svg) {
            const path = join(outDir, `${slug}.svg`);
            await writeFile(path, svg, 'utf8');
            assets.push({
              brand: brand.name,
              success: true,
              source: 'svgl',
              path,
              title: svglMatch?.title,
              sourceUrl: svglRoute,
              homepage: svglMatch?.brandUrl ?? svglMatch?.url,
            });
            continue;
          }
        }
      } catch {
        // Fall through to Simple Icons.
      }

      try {
        const simpleIconsUrl = `https://cdn.simpleicons.org/${simpleIconsSlug(brand.name)}`;
        const svg = await fetchText(simpleIconsUrl, timeoutMs);
        if (svg) {
          const path = join(outDir, `${slug}.svg`);
          await writeFile(path, svg, 'utf8');
          assets.push({
            brand: brand.name,
            success: true,
            source: 'simpleicons',
            path,
            sourceUrl: simpleIconsUrl,
            homepage: brand.domain,
          });
          continue;
        }
      } catch {
        // Fall through to favicon.
      }

      try {
        const domain = brand.domain ?? hostnameFromUrl(discoveredHomepage);
        if (domain) {
          const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`;
          const png = await fetchBytes(faviconUrl, timeoutMs);
          if (png && png.byteLength > 0) {
            const path = join(outDir, `${slug}-favicon.png`);
            await writeFile(path, png);
            assets.push({
              brand: brand.name,
              success: true,
              source: 'favicon',
              path,
              sourceUrl: faviconUrl,
              homepage: domain,
            });
            continue;
          }
        }
      } catch {
        // Return a structured miss below.
      }

      assets.push({
        brand: brand.name,
        success: false,
        error: 'No logo found via SVGL, Simple Icons, or favicon fallback. Ask the user for an official asset or use an honest placeholder.',
      });
    }

    return {
      success: assets.every((asset) => asset.success),
      outputDir: outDir,
      assets,
    };
  },
});

const generatedImageSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  source: generatedImageSourceSchema,
  index: z.number(),
});

export const designGenerateImageTool = createTool({
  id: 'design_generate_image',
  description:
    'Generates design-ready bitmap assets using the image model selected in the manifest or input: Google Gemini image, Google Imagen, or OpenAI GPT Image. Use for illustration/product imagery only after real asset search has failed or AI generation is explicitly appropriate.',

  inputSchema: z.object({
    prompt: z.string().min(20).describe('Specific visual prompt. Include subject, composition, style constraints, colors, texture, and negative constraints.'),
    outDir: z.string().default('design-work/assets/generated').describe('Output directory for generated images. Relative paths resolve from the project root.'),
    filePrefix: z.string().default('generated-image').describe('Safe file prefix for generated image files.'),
    model: z.enum(imageModelAliases).optional().describe('Optional explicit image model alias. Defaults to designAssignments.imageGen, or imageGenPhoto when photorealistic=true. Supports Google and OpenAI image aliases from model-manifest.ts.'),
    photorealistic: z.boolean().default(false).describe('When model is omitted, use designAssignments.imageGenPhoto instead of designAssignments.imageGen.'),
    aspectRatio: aspectRatioSchema.default('1:1'),
    count: z.number().int().min(1).max(4).default(1).describe('Number of images. Gemini image models support only 1 per call; Imagen and OpenAI support multiple variants in this wrapper.'),
    referenceImages: z.array(z.string()).max(4).default([]).describe('Optional local reference image paths. Supported only by Gemini image models.'),
    personGeneration: z.enum(['dont_allow', 'allow_adult', 'allow_all']).optional().describe('Imagen person-generation policy. Ignored for Gemini image models.'),
    openAiSize: openAiImageSizeSchema.optional().describe('OpenAI-only size override. When omitted, aspectRatio maps to the nearest OpenAI size.'),
    openAiQuality: openAiImageQualitySchema.default('auto').describe('OpenAI-only quality setting.'),
    openAiOutputFormat: openAiImageFormatSchema.default('png').describe('OpenAI-only output format.'),
    openAiBackground: openAiImageBackgroundSchema.optional().describe('OpenAI-only background setting; transparent requires model/format support.'),
    timeoutMs: z.number().int().min(30_000).max(600_000).default(180_000),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    modelAlias: z.string(),
    modelId: z.string(),
    fullModelId: z.string().optional(),
    source: generatedImageSourceSchema.optional(),
    outputDir: z.string(),
    images: z.array(generatedImageSchema),
    usage: z.object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    }).optional(),
    rawResponse: z.unknown().optional(),
    error: z.string().optional(),
  }),

  execute: async (input) => {
    const outputDir = resolveWorkspacePath(input.outDir ?? 'design-work/assets/generated');
    const timeoutMs = input.timeoutMs ?? 180_000;
    const count = input.count ?? 1;
    const aspectRatio = input.aspectRatio ?? '1:1';
    const referenceImages = input.referenceImages ?? [];
    const photorealistic = input.photorealistic ?? false;
    const modelAlias = (input.model ?? (photorealistic ? designAssignments.imageGenPhoto : designAssignments.imageGen)) as ModelKey;
    let resolvedModel: ReturnType<typeof resolveDesignImageModelAlias>;
    try {
      resolvedModel = resolveDesignImageModelAlias(modelAlias);
    } catch (error) {
      return {
        success: false,
        modelAlias,
        modelId: '',
        outputDir,
        images: [],
        error: (error as Error).message,
      };
    }
    const { apiModelId: modelId, fullModelId, source } = resolvedModel;
    const isGeminiImage = source === 'google-gemini';
    const isImagen = source === 'google-imagen';
    const isOpenAiImage = source === 'openai-image';
    const googleApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const openAiApiKey = process.env.OPENAI_API_KEY;

    if ((isGeminiImage || isImagen) && !googleApiKey) {
      return {
        success: false,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: [],
        error: 'GOOGLE_GENERATIVE_AI_API_KEY is not set; cannot generate images.',
      };
    }
    if (isOpenAiImage && !openAiApiKey) {
      return {
        success: false,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: [],
        error: 'OPENAI_API_KEY is not set; cannot generate images.',
      };
    }
    if (isGeminiImage && count > 1) {
      return {
        success: false,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: [],
        error: 'Gemini image models support count=1 only in this tool. Use an Imagen model for multiple variants.',
      };
    }
    if (!isGeminiImage && referenceImages.length > 0) {
      return {
        success: false,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: [],
        error: 'Reference images are supported only for Gemini image models in this tool. Use gemini-image-pro or remove referenceImages.',
      };
    }

    await mkdir(outputDir, { recursive: true });

    try {
      const url = isOpenAiImage
        ? 'https://api.openai.com/v1/images/generations'
        : isGeminiImage
          ? `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`
          : `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predict`;

      const body = isOpenAiImage
        ? {
            model: modelId,
            prompt: input.prompt,
            n: count,
            size: input.openAiSize ?? openAiSizeForAspectRatio(aspectRatio),
            quality: input.openAiQuality ?? 'auto',
            output_format: input.openAiOutputFormat ?? 'png',
            ...(input.openAiBackground ? { background: input.openAiBackground } : {}),
          }
        : isGeminiImage
          ? {
            generationConfig: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio },
            },
            contents: [
              {
                role: 'user',
                parts: [
                  { text: input.prompt },
                  ...(await Promise.all(referenceImages.map(readReferenceImage))).map((image) => ({
                    inlineData: {
                      mimeType: image.mimeType,
                      data: image.data,
                    },
                  })),
                ],
              },
            ],
          }
          : {
            instances: [{ prompt: input.prompt }],
            parameters: {
              sampleCount: count,
              aspectRatio,
              ...(input.personGeneration ? { personGeneration: input.personGeneration } : {}),
            },
          };

      const response = await fetch(url, {
        method: 'POST',
        headers: isOpenAiImage
          ? openAiApiHeaders(openAiApiKey!)
          : googleApiHeaders(googleApiKey!),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawResponse = await response.json().catch(async () => ({ text: await response.text().catch(() => '') }));
      if (!response.ok) {
        return {
          success: false,
          modelAlias,
          modelId,
          fullModelId,
          source,
          outputDir,
          images: [],
          rawResponse,
          error: `${isOpenAiImage ? 'OpenAI' : 'Google'} image generation failed with HTTP ${response.status}.`,
        };
      }

      const base64Images: Array<{ data: string; mimeType?: string }> = isGeminiImage
        ? ((rawResponse as any).candidates ?? [])
            .flatMap((candidate: any) => candidate?.content?.parts ?? [])
            .filter((part: any) => part?.inlineData?.data)
            .map((part: any) => ({
              data: normalizeImageBase64(String(part.inlineData.data)),
              mimeType: part.inlineData.mimeType ? String(part.inlineData.mimeType) : undefined,
            }))
        : ((rawResponse as any).predictions ?? [])
            .filter((prediction: any) => prediction?.bytesBase64Encoded)
            .map((prediction: any) => ({
              data: normalizeImageBase64(String(prediction.bytesBase64Encoded)),
              mimeType: prediction.mimeType ? String(prediction.mimeType) : undefined,
            }));
      const resolvedBase64Images = isOpenAiImage
        ? ((rawResponse as any).data ?? [])
            .filter((item: any) => item?.b64_json)
            .map((item: any) => ({
              data: normalizeImageBase64(String(item.b64_json)),
              mimeType: item.output_format
                ? mimeTypeForOpenAiFormat(String(item.output_format) as z.infer<typeof openAiImageFormatSchema>)
                : mimeTypeForOpenAiFormat(input.openAiOutputFormat ?? 'png'),
            }))
        : base64Images;

      if (resolvedBase64Images.length === 0) {
        return {
          success: false,
          modelAlias,
          modelId,
          fullModelId,
          source,
          outputDir,
          images: [],
          rawResponse,
          error: `${isOpenAiImage ? 'OpenAI' : 'Google'} returned no image payloads.`,
        };
      }

      const prefix = safeSlug(input.filePrefix ?? 'generated-image');
      const written = [];
      for (const [index, image] of resolvedBase64Images.entries()) {
        const mimeType = image.mimeType ?? detectGeneratedImageMime(image.data);
        const path = join(outputDir, `${prefix}-${String(index + 1).padStart(2, '0')}${extensionForMime(mimeType)}`);
        await writeFile(path, Buffer.from(image.data, 'base64'));
        written.push({
          path,
          mimeType,
          source,
          index: index + 1,
        });
      }

      const usageMetadata = (rawResponse as any).usageMetadata;
      const openAiUsage = (rawResponse as any).usage;
      return {
        success: true,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: written,
        usage: usageMetadata || openAiUsage
          ? {
              promptTokenCount: usageMetadata?.promptTokenCount,
              candidatesTokenCount: usageMetadata?.candidatesTokenCount,
              totalTokenCount: usageMetadata?.totalTokenCount ?? openAiUsage?.total_tokens,
              inputTokens: openAiUsage?.input_tokens,
              outputTokens: openAiUsage?.output_tokens,
            }
          : undefined,
        rawResponse,
      };
    } catch (error) {
      return {
        success: false,
        modelAlias,
        modelId,
        fullModelId,
        source,
        outputDir,
        images: [],
        error: (error as Error).message,
      };
    }
  },
});

const scriptResultBaseSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.union([z.number(), z.string()]).optional(),
  error: z.string().optional(),
});

export const designRenderVideoTool = createTool({
  id: 'design_render_video',
  description:
    'Renders an HTML animation to MP4 using huashu-design scripts/render-video.js (Playwright recordVideo + ffmpeg). Use for non-Stage or default animation export.',

  inputSchema: z.object({
    htmlPath: z.string().min(1),
    durationSec: z.number().min(1).max(1800).default(30),
    width: z.number().int().min(320).max(7680).default(1920),
    height: z.number().int().min(240).max(4320).default(1080),
    trimSec: z.number().min(0).max(60).optional(),
    fontWaitSec: z.number().min(0).max(20).default(1.5),
    readyTimeoutSec: z.number().min(1).max(60).default(8),
    keepChrome: z.boolean().default(false),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    htmlPath: z.string(),
    outputPath: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const htmlPath = resolveWorkspacePath(input.htmlPath);
    const durationSec = input.durationSec ?? 30;
    const width = input.width ?? 1920;
    const height = input.height ?? 1080;
    const fontWaitSec = input.fontWaitSec ?? 1.5;
    const readyTimeoutSec = input.readyTimeoutSec ?? 8;
    const timeoutMs = input.timeoutMs ?? 900_000;
    const outputPath = replaceExtension(htmlPath, '', '.mp4');
    const args = [
      join(skillRoot, 'scripts', 'render-video.js'),
      htmlPath,
      `--duration=${durationSec}`,
      `--width=${width}`,
      `--height=${height}`,
      `--fontwait=${fontWaitSec}`,
      `--readytimeout=${readyTimeoutSec}`,
      ...(input.trimSec !== undefined ? [`--trim=${input.trimSec}`] : []),
      ...(input.keepChrome ? ['--keep-chrome'] : []),
    ];
    const result = await runDesignScript('node', args, timeoutMs);
    return { ...result, htmlPath, outputPath };
  },
});

export const designRenderVideoSeekTool = createTool({
  id: 'design_render_video_seek',
  description:
    'Renders a Stage-clock HTML animation to deterministic native-frame MP4 using huashu-design scripts/render-video-seek.js.',

  inputSchema: z.object({
    htmlPath: z.string().min(1),
    durationSec: z.number().min(1).max(1800).default(30),
    fps: z.number().min(1).max(120).default(60),
    width: z.number().int().min(320).max(7680).default(1920),
    height: z.number().int().min(240).max(4320).default(1080),
    concurrency: z.number().int().min(1).max(16).default(4),
    settleFrames: z.number().int().min(1).max(20).default(2),
    readyTimeoutSec: z.number().min(1).max(60).default(8),
    keepChrome: z.boolean().default(false),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    htmlPath: z.string(),
    outputPath: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const htmlPath = resolveWorkspacePath(input.htmlPath);
    const durationSec = input.durationSec ?? 30;
    const fps = input.fps ?? 60;
    const width = input.width ?? 1920;
    const height = input.height ?? 1080;
    const concurrency = input.concurrency ?? 4;
    const settleFrames = input.settleFrames ?? 2;
    const readyTimeoutSec = input.readyTimeoutSec ?? 8;
    const timeoutMs = input.timeoutMs ?? 900_000;
    const outputPath = replaceExtension(htmlPath, '', '.mp4');
    const args = [
      join(skillRoot, 'scripts', 'render-video-seek.js'),
      htmlPath,
      `--duration=${durationSec}`,
      `--fps=${fps}`,
      `--width=${width}`,
      `--height=${height}`,
      `--concurrency=${concurrency}`,
      `--settle=${settleFrames}`,
      `--readytimeout=${readyTimeoutSec}`,
      ...(input.keepChrome ? ['--keep-chrome'] : []),
    ];
    const result = await runDesignScript('node', args, timeoutMs);
    return { ...result, htmlPath, outputPath };
  },
});

export const designConvertFormatsTool = createTool({
  id: 'design_convert_formats',
  description:
    'Converts an MP4 animation into a 60fps MP4 derivative and optimized GIF using huashu-design scripts/convert-formats.sh.',

  inputSchema: z.object({
    inputMp4: z.string().min(1),
    gifWidth: z.number().int().min(160).max(3840).default(960),
    minterpolate: z.boolean().default(false),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    inputMp4: z.string(),
    mp4_60fps: z.string(),
    gif: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const inputMp4 = resolveWorkspacePath(input.inputMp4);
    const gifWidth = input.gifWidth ?? 960;
    const timeoutMs = input.timeoutMs ?? 900_000;
    const args = [
      join(skillRoot, 'scripts', 'convert-formats.sh'),
      inputMp4,
      String(gifWidth),
      ...(input.minterpolate ? ['--minterpolate'] : []),
    ];
    const result = await runDesignScript('bash', args, timeoutMs);
    return {
      ...result,
      inputMp4,
      mp4_60fps: replaceExtension(inputMp4, '-60fps', '.mp4'),
      gif: replaceExtension(inputMp4, '', '.gif'),
    };
  },
});

export const designAddMusicTool = createTool({
  id: 'design_add_music',
  description:
    'Mixes BGM into an MP4 using huashu-design scripts/add-music.sh. Uses built-in design BGM moods or a custom music path.',

  inputSchema: z.object({
    inputMp4: z.string().min(1),
    mood: z.enum(['tech', 'ad', 'educational', 'educational-alt', 'tutorial', 'tutorial-alt']).default('tech'),
    musicPath: z.string().optional(),
    outPath: z.string().optional(),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    inputMp4: z.string(),
    outputPath: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const inputMp4 = resolveWorkspacePath(input.inputMp4);
    const mood = input.mood ?? 'tech';
    const timeoutMs = input.timeoutMs ?? 600_000;
    const outputPath = input.outPath
      ? resolveWorkspacePath(input.outPath)
      : replaceExtension(inputMp4, '-bgm', '.mp4');
    await mkdir(dirname(outputPath), { recursive: true });
    const args = [
      join(skillRoot, 'scripts', 'add-music.sh'),
      inputMp4,
      `--mood=${mood}`,
      `--out=${outputPath}`,
      ...(input.musicPath ? [`--music=${resolveWorkspacePath(input.musicPath)}`] : []),
    ];
    const result = await runDesignScript('bash', args, timeoutMs);
    return { ...result, inputMp4, outputPath };
  },
});

export const designExportPptxTool = createTool({
  id: 'design_export_pptx',
  description:
    'Exports a multi-file HTML slide deck to editable PPTX using huashu-design scripts/export_deck_pptx.mjs.',

  inputSchema: z.object({
    slidesDir: z.string().min(1),
    outPath: z.string().min(1),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    slidesDir: z.string(),
    outputPath: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const slidesDir = resolveWorkspacePath(input.slidesDir);
    const outputPath = resolveWorkspacePath(input.outPath);
    const timeoutMs = input.timeoutMs ?? 600_000;
    await mkdir(dirname(outputPath), { recursive: true });
    const args = [
      join(skillRoot, 'scripts', 'export_deck_pptx.mjs'),
      '--slides',
      slidesDir,
      '--out',
      outputPath,
    ];
    const result = await runDesignScript('node', args, timeoutMs);
    return { ...result, slidesDir, outputPath };
  },
});

export const designExportPdfTool = createTool({
  id: 'design_export_pdf',
  description:
    'Exports HTML decks to vector PDF. Supports multi-file slide directories and single-file deck_stage HTML using huashu-design PDF scripts.',

  inputSchema: z.object({
    mode: z.enum(['multi-file', 'deck-stage']).default('multi-file'),
    slidesDir: z.string().optional().describe('Required for mode=multi-file. Directory of slide HTML files.'),
    htmlPath: z.string().optional().describe('Required for mode=deck-stage. Single HTML file containing <deck-stage>.'),
    outPath: z.string().min(1),
    width: z.number().int().min(320).max(7680).default(1920),
    height: z.number().int().min(240).max(4320).default(1080),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    mode: z.string(),
    inputPath: z.string(),
    outputPath: z.string(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const mode = input.mode ?? 'multi-file';
    const width = input.width ?? 1920;
    const height = input.height ?? 1080;
    const timeoutMs = input.timeoutMs ?? 600_000;
    const outputPath = resolveWorkspacePath(input.outPath);
    await mkdir(dirname(outputPath), { recursive: true });

    if (mode === 'multi-file') {
      if (!input.slidesDir) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          mode,
          inputPath: '',
          outputPath,
          error: 'slidesDir is required when mode=multi-file.',
        };
      }
      const slidesDir = resolveWorkspacePath(input.slidesDir);
      const args = [
        join(skillRoot, 'scripts', 'export_deck_pdf.mjs'),
        '--slides',
        slidesDir,
        '--out',
        outputPath,
        '--width',
        String(width),
        '--height',
        String(height),
      ];
      const result = await runDesignScript('node', args, timeoutMs);
      return { ...result, mode, inputPath: slidesDir, outputPath };
    }

    if (!input.htmlPath) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        mode,
        inputPath: '',
        outputPath,
        error: 'htmlPath is required when mode=deck-stage.',
      };
    }
    const htmlPath = resolveWorkspacePath(input.htmlPath);
    const args = [
      join(skillRoot, 'scripts', 'export_deck_stage_pdf.mjs'),
      '--html',
      htmlPath,
      '--out',
      outputPath,
      '--width',
      String(width),
      '--height',
      String(height),
    ];
    const result = await runDesignScript('node', args, timeoutMs);
    return { ...result, mode, inputPath: htmlPath, outputPath };
  },
});

export const designGenThumbsTool = createTool({
  id: 'design_gen_thumbs',
  description:
    'Generates JPEG thumbnails for a multi-file HTML deck using huashu-design scripts/gen_deck_thumbs.mjs.',

  inputSchema: z.object({
    slidesDir: z.string().min(1),
    outDir: z.string().default('thumbs'),
    width: z.number().int().min(320).max(4096).default(1600),
    quality: z.number().int().min(1).max(100).default(86),
    canvasWidth: z.number().int().min(320).max(7680).default(1920),
    canvasHeight: z.number().int().min(240).max(4320).default(1080),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  }),

  outputSchema: scriptResultBaseSchema.extend({
    slidesDir: z.string(),
    outputDir: z.string(),
    thumbnails: z.array(z.string()),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const slidesDir = resolveWorkspacePath(input.slidesDir);
    const outputDir = resolveWorkspacePath(input.outDir ?? 'thumbs');
    const width = input.width ?? 1600;
    const quality = input.quality ?? 86;
    const canvasWidth = input.canvasWidth ?? 1920;
    const canvasHeight = input.canvasHeight ?? 1080;
    const timeoutMs = input.timeoutMs ?? 600_000;
    await mkdir(outputDir, { recursive: true });
    const args = [
      join(skillRoot, 'scripts', 'gen_deck_thumbs.mjs'),
      '--slides',
      slidesDir,
      '--out',
      outputDir,
      '--width',
      String(width),
      '--quality',
      String(quality),
      '--canvas-w',
      String(canvasWidth),
      '--canvas-h',
      String(canvasHeight),
    ];
    const result = await runDesignScript('node', args, timeoutMs);
    return {
      ...result,
      slidesDir,
      outputDir,
      thumbnails: await listFilesFlat(outputDir),
    };
  },
});

export const designTtsTool = createTool({
  id: 'design_tts',
  description:
    'Synthesizes narration audio with ElevenLabs and returns the measured duration required by the huashu-design narration timeline contract.',

  inputSchema: z.object({
    text: z.string().min(1),
    outPath: z.string().default('design-work/_narration/voiceover.mp3'),
    voiceId: z.string().optional().describe('ElevenLabs voice ID. Defaults to ELEVENLABS_VOICE_ID or ELEVENLABS_DEFAULT_VOICE_ID.'),
    model: z.enum(elevenLabsTtsModelAliases).default('eleven-multilingual-v2'),
    outputFormat: z.string().default('mp3_44100_128'),
    withTimestamps: z.boolean().default(true).describe('Use ElevenLabs /with-timestamps and save an alignment sidecar JSON.'),
    languageCode: z.string().optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    speed: z.number().min(0.7).max(1.2).optional(),
    useSpeakerBoost: z.boolean().optional(),
    previousText: z.string().optional(),
    nextText: z.string().optional(),
    timeoutMs: z.number().int().min(30_000).max(600_000).default(180_000),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    duration: z.number().nullable(),
    bytes: z.number(),
    textChars: z.number(),
    voiceId: z.string().optional(),
    modelAlias: z.string(),
    modelId: z.string(),
    alignmentPath: z.string().optional(),
    rawResponse: z.unknown().optional(),
    error: z.string().optional(),
  }),

  execute: async (input) => {
    const outPath = resolveWorkspacePath(input.outPath ?? 'design-work/_narration/voiceover.mp3');
    const voiceId = input.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    const modelAlias = input.model ?? 'eleven-multilingual-v2';
    const modelId = resolveElevenLabsModelAlias(modelAlias);
    if (!voiceId) {
      return {
        success: false,
        path: outPath,
        duration: null,
        bytes: 0,
        textChars: input.text.length,
        modelAlias,
        modelId,
        error: 'Missing ElevenLabs voice ID. Pass voiceId or set ELEVENLABS_VOICE_ID.',
      };
    }

    const result = await synthesizeElevenLabsSpeech({
      text: input.text,
      outPath,
      voiceId,
      modelId,
      outputFormat: input.outputFormat ?? 'mp3_44100_128',
      withTimestamps: input.withTimestamps ?? true,
      languageCode: input.languageCode,
      seed: input.seed,
      stability: input.stability,
      similarityBoost: input.similarityBoost,
      style: input.style,
      speed: input.speed,
      useSpeakerBoost: input.useSpeakerBoost,
      previousText: input.previousText,
      nextText: input.nextText,
      timeoutMs: input.timeoutMs ?? 180_000,
    });
    return {
      ...result,
      voiceId,
      modelAlias,
      modelId,
    };
  },
});

export const designNarratePipelineTool = createTool({
  id: 'design_narrate_pipeline',
  description:
    'Builds a narration pipeline from a markdown script: ElevenLabs chunk audio, concatenated voiceover.mp3, and huashu-compatible timeline.json.',

  inputSchema: z.object({
    scriptPath: z.string().min(1).describe('Markdown script with frontmatter, ## scene-id headings, and optional [[cue:id]] markers.'),
    outDir: z.string().default('design-work/_narration'),
    voiceId: z.string().optional().describe('ElevenLabs voice ID. Defaults to frontmatter voice, ELEVENLABS_VOICE_ID, or ELEVENLABS_DEFAULT_VOICE_ID.'),
    model: z.enum(elevenLabsTtsModelAliases).default('eleven-multilingual-v2'),
    outputFormat: z.string().default('mp3_44100_128'),
    gapSec: z.number().min(0).max(10).optional().describe('Silence gap between scenes. Defaults to frontmatter gap or 0.3.'),
    speed: z.number().min(0.7).max(1.2).optional().describe('ElevenLabs voice_settings.speed. Defaults to frontmatter speed or 1.0.'),
    languageCode: z.string().optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    useSpeakerBoost: z.boolean().optional(),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).default(1_800_000),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    scriptPath: z.string(),
    outDir: z.string(),
    voiceoverPath: z.string(),
    timelinePath: z.string(),
    totalDuration: z.number().nullable(),
    sceneCount: z.number(),
    cueCount: z.number(),
    voiceId: z.string().optional(),
    modelAlias: z.string(),
    modelId: z.string(),
    error: z.string().optional(),
  }),

  execute: async (input) => {
    const scriptPath = resolveWorkspacePath(input.scriptPath);
    const outDir = resolveWorkspacePath(input.outDir ?? 'design-work/_narration');
    const audioDir = join(outDir, 'audio');
    const tmpDir = join(outDir, '.tmp');
    const voiceoverPath = join(outDir, 'voiceover.mp3');
    const timelinePath = join(outDir, 'timeline.json');
    const modelAlias = input.model ?? 'eleven-multilingual-v2';
    const modelId = resolveElevenLabsModelAlias(modelAlias);

    try {
      const md = await readFile(scriptPath, 'utf8');
      const { meta, scenes } = parseNarrationScript(md);
      if (scenes.length === 0) {
        return {
          success: false,
          scriptPath,
          outDir,
          voiceoverPath,
          timelinePath,
          totalDuration: null,
          sceneCount: 0,
          cueCount: 0,
          modelAlias,
          modelId,
          error: 'Narration script has no ## scene-id sections.',
        };
      }

      const voiceId = input.voiceId ?? meta.voice ?? process.env.ELEVENLABS_VOICE_ID ?? process.env.ELEVENLABS_DEFAULT_VOICE_ID;
      if (!voiceId) {
        return {
          success: false,
          scriptPath,
          outDir,
          voiceoverPath,
          timelinePath,
          totalDuration: null,
          sceneCount: scenes.length,
          cueCount: 0,
          modelAlias,
          modelId,
          error: 'Missing ElevenLabs voice ID. Pass voiceId, set frontmatter voice, or set ELEVENLABS_VOICE_ID.',
        };
      }

      const timeoutMs = input.timeoutMs ?? 1_800_000;
      const parsedSpeed = meta.speed ? Number.parseFloat(meta.speed) : undefined;
      const speed = input.speed ?? (Number.isFinite(parsedSpeed) ? parsedSpeed : undefined) ?? 1.0;
      const parsedGap = meta.gap ? Number.parseFloat(meta.gap) : undefined;
      const gap = input.gapSec ?? (Number.isFinite(parsedGap) ? parsedGap : undefined) ?? 0.3;

      await mkdir(audioDir, { recursive: true });
      await mkdir(tmpDir, { recursive: true });

      const gapFile = join(tmpDir, 'gap.mp3');
      if (gap > 0) await makeSilenceMp3(gap, gapFile);

      const timeline: any = {
        title: meta.title || basename(scriptPath, extname(scriptPath)),
        voice: voiceId,
        speed,
        gap,
        totalDuration: 0,
        scenes: [],
      };

      let cursor = 0;
      let cueCount = 0;
      const sceneAudioFiles: string[] = [];

      for (const [sceneIndex, scene] of scenes.entries()) {
        const chunks = splitTextByCues(scene.raw);
        const chunkFiles: string[] = [];
        const cueRecords: Array<{ id: string; offset: number }> = [];
        const chunkRecords: Array<{ text: string; start: number; end: number; duration: number }> = [];
        let sceneInternalCursor = 0;

        for (const [chunkIndex, chunk] of chunks.entries()) {
          if (!chunk.text) {
            if (chunk.cueAfter) {
              cueRecords.push({ id: chunk.cueAfter, offset: sceneInternalCursor });
              cueCount += 1;
            }
            continue;
          }

          const chunkPath = join(tmpDir, `${safeSlug(scene.id)}-${chunkIndex}.mp3`);
          const ttsResult = await synthesizeElevenLabsSpeech({
            text: chunk.text,
            outPath: chunkPath,
            voiceId,
            modelId,
            outputFormat: input.outputFormat ?? 'mp3_44100_128',
            withTimestamps: true,
            languageCode: input.languageCode,
            stability: input.stability,
            similarityBoost: input.similarityBoost,
            style: input.style,
            speed,
            useSpeakerBoost: input.useSpeakerBoost,
            previousText: chunks[chunkIndex - 1]?.text,
            nextText: chunks[chunkIndex + 1]?.text,
            timeoutMs,
          });
          if (!ttsResult.success || ttsResult.duration === null) {
            return {
              success: false,
              scriptPath,
              outDir,
              voiceoverPath,
              timelinePath,
              totalDuration: null,
              sceneCount: scenes.length,
              cueCount,
              voiceId,
              modelAlias,
              modelId,
              error: `TTS failed for scene "${scene.id}" chunk ${chunkIndex}: ${ttsResult.error ?? 'duration missing'}`,
            };
          }

          const chunkStart = sceneInternalCursor;
          sceneInternalCursor += ttsResult.duration;
          chunkFiles.push(chunkPath);
          chunkRecords.push({
            text: chunk.text,
            start: chunkStart,
            end: sceneInternalCursor,
            duration: ttsResult.duration,
          });

          if (chunk.cueAfter) {
            cueRecords.push({ id: chunk.cueAfter, offset: sceneInternalCursor });
            cueCount += 1;
          }
        }

        if (chunkFiles.length === 0) {
          return {
            success: false,
            scriptPath,
            outDir,
            voiceoverPath,
            timelinePath,
            totalDuration: null,
            sceneCount: scenes.length,
            cueCount,
            voiceId,
            modelAlias,
            modelId,
            error: `Scene "${scene.id}" produced no speech chunks.`,
          };
        }

        const sceneAudio = join(audioDir, `${safeSlug(scene.id)}.mp3`);
        if (chunkFiles.length === 1) {
          await copyFile(chunkFiles[0], sceneAudio);
        } else {
          await concatAudioFiles(chunkFiles, sceneAudio);
        }
        const sceneDuration = await probeDurationSeconds(sceneAudio);
        if (sceneDuration === null) {
          return {
            success: false,
            scriptPath,
            outDir,
            voiceoverPath,
            timelinePath,
            totalDuration: null,
            sceneCount: scenes.length,
            cueCount,
            voiceId,
            modelAlias,
            modelId,
            error: `ffprobe could not measure scene audio duration for "${scene.id}".`,
          };
        }

        if (sceneIndex > 0 && gap > 0) {
          sceneAudioFiles.push(gapFile);
          cursor += gap;
        }
        sceneAudioFiles.push(sceneAudio);

        timeline.scenes.push({
          id: scene.id,
          start: cursor,
          end: cursor + sceneDuration,
          duration: sceneDuration,
          audio: relative(outDir, sceneAudio),
          text: stripCueMarkers(scene.raw),
          chunks: chunkRecords.map((chunk) => ({
            text: chunk.text,
            start: chunk.start,
            end: chunk.end,
            absoluteStart: cursor + chunk.start,
            absoluteEnd: cursor + chunk.end,
          })),
          cues: cueRecords.map((cue) => ({
            id: cue.id,
            offset: cue.offset,
            absoluteTime: cursor + cue.offset,
          })),
        });

        cursor += sceneDuration;
      }

      await concatAudioFiles(sceneAudioFiles, voiceoverPath);
      const totalDuration = await probeDurationSeconds(voiceoverPath);
      timeline.totalDuration = totalDuration ?? cursor;
      timeline.voiceover = 'voiceover.mp3';
      await writeFile(timelinePath, JSON.stringify(timeline, null, 2));
      await rm(tmpDir, { recursive: true, force: true });

      return {
        success: true,
        scriptPath,
        outDir,
        voiceoverPath,
        timelinePath,
        totalDuration: timeline.totalDuration,
        sceneCount: scenes.length,
        cueCount,
        voiceId,
        modelAlias,
        modelId,
      };
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        success: false,
        scriptPath,
        outDir,
        voiceoverPath,
        timelinePath,
        totalDuration: null,
        sceneCount: 0,
        cueCount: 0,
        modelAlias,
        modelId,
        error: (error as Error).message,
      };
    }
  },
});

const viewportSchema = z.string().regex(/^\d+x\d+$/, 'Viewport must use WIDTHxHEIGHT format, e.g. 1440x900.');

export const designVerifyTool = createTool({
  id: 'design_verify',
  description:
    'Runs huashu-design verify.py to open an HTML design with Playwright, capture screenshots, and report page/console errors.',

  inputSchema: z.object({
    htmlPath: z.string().min(1).describe('Path to the HTML file to verify. Relative paths resolve from the project root.'),
    viewports: z.array(viewportSchema).min(1).max(8).default(['1440x900']).describe('Viewport list in WIDTHxHEIGHT format.'),
    slides: z.number().int().min(0).max(200).default(0).describe('If >0, capture this many deck slides via ArrowRight navigation.'),
    outputDir: z.string().optional().describe('Screenshot output directory. Defaults to screenshots next to the HTML file.'),
    waitMs: z.number().int().min(0).max(30_000).default(2000).describe('Milliseconds to wait after page load before screenshot.'),
    timeoutMs: z.number().int().min(10_000).max(600_000).default(180_000),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    htmlPath: z.string(),
    outputDir: z.string(),
    screenshots: z.array(z.string()),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.union([z.number(), z.string()]).optional(),
    error: z.string().optional(),
  }),

  execute: async (input) => {
    const skillRoot = resolveDesignSkillRoot();
    const script = join(skillRoot, 'scripts', 'verify.py');
    const htmlPath = resolveWorkspacePath(input.htmlPath);
    const viewports = input.viewports ?? ['1440x900'];
    const slides = input.slides ?? 0;
    const waitMs = input.waitMs ?? 2000;
    const timeoutMs = input.timeoutMs ?? 180_000;
    const outputDir = input.outputDir
      ? resolveWorkspacePath(input.outputDir)
      : join(dirname(htmlPath), 'screenshots');
    await mkdir(outputDir, { recursive: true });

    const args = [
      script,
      htmlPath,
      '--viewports',
      viewports.join(','),
      '--slides',
      String(slides),
      '--output',
      outputDir,
      '--wait',
      String(waitMs),
    ];

    try {
      const { stdout, stderr } = await execFileAsync('python3', args, {
        cwd: skillRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        success: true,
        htmlPath,
        outputDir,
        screenshots: await listFilesFlat(outputDir),
        stdout,
        stderr,
      };
    } catch (error) {
      const err = error as ExecFailure;
      return {
        success: false,
        htmlPath,
        outputDir,
        screenshots: await listFilesFlat(outputDir),
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: err.code,
        error: err.message,
      };
    }
  },
});
