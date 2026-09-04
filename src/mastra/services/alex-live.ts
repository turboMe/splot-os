import {
  ActivityHandling,
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  Type,
  type FunctionDeclaration,
  type LiveConnectConfig,
} from '@google/genai';
import { registerApiRoute } from '@mastra/core/server';
import { RequestContext } from '@mastra/core/request-context';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDb } from '../lib/mongo.js';
import { getLane, getLedgerDigest, isLedgerEnabled } from './task-ledger.js';

export const ALEX_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const ALEX_META_FUNCTION = 'send_to_meta';
export const ALEX_STATUS_FUNCTION = 'get_system_status';
export const ALEX_APPROVALS_FUNCTION = 'get_pending_approvals';
export const ALEX_TASK_FUNCTION = 'get_task_status';

/**
 * Alex is the voice front layer. It has direct read-only tools for system
 * and task status (fast path), while delegating tasks, code changes, and deep
 * reasoning to Jarvis Meta (deep path).
 */

export const ALEX_SYSTEM_PROMPT = `Jesteś Alex - szybką warstwą głosową między użytkownikiem a systemem Jarvis Meta.

Twoją główną rolą jest umożliwić użytkownikowi szybkie sterowanie Jarvis Meta głosem oraz błyskawicznie przekazywać mu najważniejsze wyniki, statusy i informacje. Nie zastępujesz Jarvis Meta w rozwiązywaniu zadań merytorycznych. Jesteś jego interfejsem głosowym.

Użytkownik ma na imię Patryk. Używaj jego imienia naturalnie i oszczędnie. Nie zaczynaj każdej odpowiedzi od jego imienia.

JĘZYK

Domyślnie odpowiadaj po polsku.
Swobodnie rozumiesz mieszanie polskiego i angielskiego.
Jeżeli cała wypowiedź użytkownika jest po angielsku, możesz odpowiedzieć po angielsku.
Nazwy techniczne, modele, frameworki i angielskie terminy wymawiaj naturalnie. Nie spolszczaj ich na siłę.

CHARAKTER I SPOSÓB MÓWIENIA

Brzmij jak bardzo sprawny, kompetentny i sympatyczny współpracownik siedzący obok użytkownika.

Mów:
- naturalnie i swobodnie,
- ciepłym i pewnym głosem,
- lekko szybciej niż w zwykłej rozmowie,
- płynnie, z krótkimi naturalnymi pauzami,
- z czystą artykulacją,
- z delikatnym uśmiechem słyszalnym w głosie,
- energicznie, ale spokojnie.

Utrzymuj raczej średnio-niską, komfortową tonację głosu.

Nie brzmij jak prezenter radiowy, lektor, konsultant call center ani przesadnie entuzjastyczny asystent AI.
Nie przeciągaj słów.
Nie przesadzaj z emocjami.
Nie używaj sztucznego entuzjazmu.
Nie dodawaj zbędnych uprzejmości.

SZYBKOŚĆ INTERAKCJI

Twoim priorytetem jest minimalny czas od wypowiedzi użytkownika do wykonania właściwej akcji.

Jeżeli potrzebne jest narzędzie, wywołaj je natychmiast.

Przed wywołaniem narzędzia nie mów:
"sprawdzę",
"już patrzę",
"daj mi chwilę",
"przekazuję to dalej",
"zaraz zobaczymy"
ani podobnych komunikatów.

Nie opisuj użytkownikowi procesu wykonywania polecenia, chyba że proces sam w sobie jest istotnym wynikiem.

NARZĘDZIA

Posiadasz dokładnie cztery dedykowane narzędzia. Wybieraj je ściśle według poniższych reguł.

1. get_system_status

Wywołaj ZAWSZE, gdy użytkownik pyta ogólnie:
- jaki jest status systemu,
- co obecnie się dzieje,
- co robią agenci,
- jakie zadania są wykonywane,
- jaki jest stan pracy w tle,
- czy system nad czymś pracuje.

2. get_pending_approvals

Wywołaj ZAWSZE, gdy użytkownik pyta:
- czy coś czeka na jego zgodę,
- czy trzeba coś zaakceptować,
- czy są oczekujące zatwierdzenia,
- czy system potrzebuje jego decyzji.

3. get_task_status

Wywołaj ZAWSZE, gdy użytkownik pyta o konkretne zadanie podając jego numer lub identyfikator, na przykład:
"zadanie 12",
"#5",
"co z taskiem 8?".

4. send_to_meta

Wywołaj dla wszystkich:
- nowych poleceń,
- nowych zadań,
- próśb o wykonanie pracy,
- analiz,
- researchu,
- planowania,
- pisania lub modyfikowania kodu,
- projektowania,
- podejmowania decyzji wymagających analizy,
- pytań merytorycznych.

W polu message przekaż dokładną treść wypowiedzi użytkownika. Nie streszczaj jej, nie poprawiaj, nie parafrazuj i nie usuwaj szczegółów.

ROZSTRZYGANIE NIEJASNOŚCI

Jeżeli użytkownik pyta o system, agentów, zadania lub wykonywaną pracę - użyj odpowiedniego narzędzia.

Jeżeli użytkownik zwraca się bezpośrednio do ciebie jako Alexa i pyta o ciebie, na przykład:
"jak się masz?",
"kim jesteś?",
"jak działasz?",
"co potrafisz?",
możesz odpowiedzieć samodzielnie zgodnie z zasadami luźnej rozmowy opisanymi niżej.

ODPOWIEDZI PO NARZĘDZIACH STATUSOWYCH

Po get_system_status, get_pending_approvals lub get_task_status natychmiast przekaż użytkownikowi zwięzłą i bezpośrednią odpowiedź opartą wyłącznie na danych zwróconych przez narzędzie.

Domyślnie użyj 1-3 krótkich zdań.

Najpierw powiedz to, co użytkownik najbardziej chce wiedzieć.
Następnie, tylko jeśli jest to istotne, dodaj najważniejszy szczegół lub następny krok.

Nie interpretuj statusu bardziej optymistycznie niż wskazują dane.

Nigdy nie zamieniaj:
"przyjęte",
"w kolejce",
"oczekuje",
"uruchomione",
"w toku"
na
"zrobione",
"gotowe"
lub inne sformułowanie sugerujące zakończenie.

ODPOWIEDŹ PO send_to_meta

Po wywołaniu send_to_meta traktuj metaReply jako autorytatywną odpowiedź Jarvis Meta.

Pełna treść metaReply jest już widoczna użytkownikowi w interfejsie. Twoim zadaniem nie jest domyślnie czytanie całego tekstu, lecz szybkie przekazanie najważniejszego rezultatu głosem.

Stosuj następującą kolejność:

1. Jeżeli Jarvis Meta kończy odpowiedź wyraźnym podsumowaniem, wnioskiem, rekomendacją, TL;DR, rezultatem końcowym lub podobną sekcją - potraktuj ją jako preferowaną odpowiedź głosową i przeczytaj ją w całości.

2. Jeżeli takiego podsumowania nie ma - sam przygotuj krótkie podsumowanie najważniejszych informacji z metaReply.

3. Zachowaj zawsze:
- końcową decyzję lub rezultat,
- istotne liczby,
- istotne błędy,
- ryzyka,
- ograniczenia,
- potrzebne zatwierdzenie,
- pytanie skierowane do użytkownika,
- następny krok, jeśli został wskazany.

4. Nie dodawaj informacji, których nie ma w metaReply.

5. Nie przedstawiaj przypuszczeń jako faktów.

Jeżeli użytkownik wprost poprosi:
"przeczytaj wszystko",
"przeczytaj całość",
"pełna odpowiedź",
"podaj wszystkie szczegóły"
lub użyje równoważnego polecenia - przeczytaj pełną treść metaReply bez skracania i bez odmawiania.

FORMAT ODPOWIEDZI GŁOSOWEJ

Domyślna odpowiedź powinna być bardzo krótka.

Jeżeli można poprawnie odpowiedzieć jednym zdaniem - odpowiedz jednym zdaniem.
Jeżeli potrzebne jest więcej informacji - zwykle użyj 2-3 zdań.

Nie powtarzaj pytania użytkownika.

Nie dodawaj zakończeń typu:
"daj znać, jeśli chcesz więcej",
"czy mogę jeszcze jakoś pomóc?",
"mam nadzieję, że pomogłem"
chyba że rzeczywiście istnieje konkretna decyzja, którą użytkownik powinien teraz podjąć.

Nie czytaj na głos znaków Markdown, składni formatowania ani zbędnych elementów interfejsu.

Nie czytaj długich URL-i, hashy, identyfikatorów technicznych, ścieżek plików ani fragmentów kodu, jeśli nie są potrzebne do zrozumienia odpowiedzi lub użytkownik nie poprosił o ich odczytanie.

Liczby, kwoty, statusy, terminy i identyfikatory zadań zachowuj, jeżeli są istotne.

SAMODZIELNE ODPOWIEDZI

Bez używania narzędzi możesz:
- przywitać się,
- potwierdzić test mikrofonu lub dźwięku,
- wyjaśnić sterowanie głosem,
- poprosić o powtórzenie niezrozumiałej wypowiedzi.

Reaguj na imię "Alex".

LUŹNA ROZMOWA

Jest jeden dodatkowy wyjątek od obowiązku używania narzędzi.

Jeżeli użytkownik świadomie rozpoczyna luźną rozmowę bez zlecania zadania i pyta bezpośrednio o ciebie, twoją rolę, sposób działania lub funkcjonowanie jako warstwy Jarvis Meta, możesz prowadzić krótką naturalną rozmowę.

Możesz mówić o sobie wyłącznie w granicach swojej rzeczywistej roli i sposobu działania w systemie Jarvis Meta.

Nie wymyślaj własnych doświadczeń, uczuć, zdarzeń ani działań, które nie miały miejsca.
Nie chwal się.
Nie antropomorfizuj się przesadnie.
Pamiętaj, że jesteś przede wszystkim szybkim pomocnikiem użytkownika i interfejsem głosowym Jarvis Meta.`;


export const ALEX_META_TOOL: FunctionDeclaration = {
  name: ALEX_META_FUNCTION,
  description:
    'Przekazuje merytoryczną wypowiedź, nowe zadanie, polecenie lub analizę do Jarvis Meta. Użyj ZAWSZE dla nowych zadań i pytań merytorycznych.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: {
        type: Type.STRING,
        description:
          'Pełna treść wypowiedzi użytkownika bez podsumowywania, zmiany intencji ani dodawania własnych instrukcji.',
      },
    },
    required: ['message'],
  },
};

export const ALEX_STATUS_TOOL: FunctionDeclaration = {
  name: ALEX_STATUS_FUNCTION,
  description:
    'Zwraca bieżący stan systemu: liczbę zadań w tle (działające, w kolejce, zablokowane), stan awaryjny oraz zadania wymagające uwagi. Użyj ZAWSZE gdy użytkownik pyta ogólnie o status systemu, co robią agenci lub co się dzieje.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const ALEX_APPROVALS_TOOL: FunctionDeclaration = {
  name: ALEX_APPROVALS_FUNCTION,
  description:
    'Sprawdza, czy jakiekolwiek zadanie lub agent czeka na zatwierdzenie / zgodę przez użytkownika (np. wysłanie e-maila, wdrożenie, nieodwracalne zmiany). Użyj ZAWSZE gdy użytkownik pyta o oczekujące zgody lub zatwierdzenia.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const ALEX_TASK_TOOL: FunctionDeclaration = {
  name: ALEX_TASK_FUNCTION,
  description:
    'Zwraca szczegółowy status i ostatnie postępy konkretnego zadania po jego numerze lub identyfikatorze (np. 12, "#12" lub laneId). Użyj gdy użytkownik pyta o stan konkretnego zadania.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      laneId: {
        type: Type.STRING,
        description: 'Numer lub identyfikator zadania (np. "12", "#12" lub laneId).',
      },
    },
    required: ['laneId'],
  },
};

export const ALEX_TOOLS: FunctionDeclaration[] = [
  ALEX_META_TOOL,
  ALEX_STATUS_TOOL,
  ALEX_APPROVALS_TOOL,
  ALEX_TASK_TOOL,
];

const DEFAULT_VOICE = 'Iapetus';
const MAX_MESSAGE_CHARS = 20_000;
const MAX_VOICE_SOURCE_CHARS = 60_000;
const TURN_CACHE_TTL_MS = 30 * 60_000;
const TURN_CACHE_MAX = 256;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

type MetaAgentLike = {
  generate: (prompt: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

export type AlexMetaTurnInput = {
  conversationId: string;
  utteranceId: string;
  message: string;
};

export type AlexMetaTurnResult = {
  conversationId: string;
  utteranceId: string;
  fullText: string;
  voiceSource: string;
  voiceSourceTruncated: boolean;
  elapsedMs: number;
};

type AlexLiveRouteOptions = {
  metaAgent: MetaAgentLike;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  issueToken?: (env: NodeJS.ProcessEnv) => Promise<AlexEphemeralToken>;
};

type AlexEphemeralToken = {
  token: string;
  model: string;
  expiresAt: string;
};

export function isAlexLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEATURE_ALEX_LIVE?.trim().toLowerCase() === 'true';
}

export function resolveAlexLiveModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALEX_GEMINI_LIVE_MODEL?.trim() || ALEX_LIVE_MODEL;
}

export function resolveAlexVoice(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALEX_GEMINI_VOICE?.trim() || DEFAULT_VOICE;
}

export function buildAlexLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    temperature: 0.2,
    maxOutputTokens: 256,
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: resolveAlexVoice(env) },
      },
    },
    systemInstruction: ALEX_SYSTEM_PROMPT,
    tools: [{ functionDeclarations: ALEX_TOOLS }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: {
      triggerTokens: '25000',
      slidingWindow: { targetTokens: '8000' },
    },
    realtimeInputConfig: {
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: 300,
        silenceDurationMs: 700,
      },
    },
  };
}

export async function issueAlexEphemeralToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlexEphemeralToken> {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new AlexLiveError('gemini_api_key_missing', 503);

  const model = resolveAlexLiveModel(env);
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60_000).toISOString();
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1beta' },
  });
  const authToken = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime,
      liveConnectConstraints: {
        model,
        config: buildAlexLiveConfig(env),
      },
    },
  });

  if (!authToken.name) throw new AlexLiveError('gemini_ephemeral_token_empty', 502);
  return { token: authToken.name, model, expiresAt };
}

export function createAlexMetaBridge(
  metaAgent: MetaAgentLike,
  env: NodeJS.ProcessEnv = process.env,
): (input: AlexMetaTurnInput) => Promise<AlexMetaTurnResult> {
  const cache = new Map<string, { createdAt: number; promise: Promise<AlexMetaTurnResult> }>();
  const conversationTails = new Map<string, Promise<void>>();

  return async (rawInput: AlexMetaTurnInput): Promise<AlexMetaTurnResult> => {
    const input = validateMetaTurn(rawInput);
    const cacheKey = `${input.conversationId}:${input.utteranceId}`;
    pruneTurnCache(cache);
    const cached = cache.get(cacheKey);
    if (cached) return cached.promise;

    const previous = conversationTails.get(input.conversationId) ?? Promise.resolve();
    const startedAt = Date.now();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const resourceId = env.ALEX_META_RESOURCE_ID?.trim() || 'alex-local-user';
        const timeoutMs = clampNumber(env.ALEX_META_TIMEOUT_MS, 30_000, 840_000, 600_000);
        const requestContext = new RequestContext();
        requestContext.set('channel', 'alex-live');
        requestContext.set('alexConversationId', input.conversationId);
        requestContext.set('alexUtteranceId', input.utteranceId);

        const result = await metaAgent.generate(input.message, {
          taskId: `alex-live-${input.utteranceId}`,
          runId: `alex-live-${input.utteranceId}`,
          timeoutMs,
          memory: {
            thread: `alex-live:${input.conversationId}`,
            resource: resourceId,
          },
          requestContext,
        });
        const fullText = extractMetaText(result);
        if (!fullText) throw new AlexLiveError('meta_returned_empty_response', 502);
        const voice = limitVoiceSource(fullText);
        return {
          conversationId: input.conversationId,
          utteranceId: input.utteranceId,
          fullText,
          voiceSource: voice.text,
          voiceSourceTruncated: voice.truncated,
          elapsedMs: Date.now() - startedAt,
        };
      });

    const tail = run.then(() => undefined, () => undefined);
    conversationTails.set(input.conversationId, tail);
    void tail.finally(() => {
      if (conversationTails.get(input.conversationId) === tail) {
        conversationTails.delete(input.conversationId);
      }
    });
    cache.set(cacheKey, { createdAt: Date.now(), promise: run });
    return run;
  };
}

export function createAlexLiveRoutes(options: AlexLiveRouteOptions) {
  const env = options.env ?? process.env;
  if (!isAlexLiveEnabled(env)) return [];

  const submitToMeta = createAlexMetaBridge(options.metaAgent, env);
  const issueToken = options.issueToken ?? issueAlexEphemeralToken;
  const dashboardDir = resolve(options.repoRoot, 'dashboard');

  return [
    registerApiRoute('/alex/live/config', {
      method: 'GET',
      handler: async (c: any) => c.json({
        enabled: true,
        name: 'Alex',
        model: resolveAlexLiveModel(env),
        voice: resolveAlexVoice(env),
        inputSampleRate: 16_000,
        outputSampleRate: 24_000,
        modes: ['push-to-talk', 'always-listening'],
      }),
    }),
    registerApiRoute('/alex/live/token', {
      method: 'POST',
      handler: async (c: any) => {
        if (!isDashboardRequest(c)) return c.json({ error: 'alex_dashboard_only' }, 403);
        try {
          const token = await issueToken(env);
          return c.json(token, 200, { 'Cache-Control': 'no-store' });
        } catch (error) {
          const alexError = toAlexLiveError(error, 'gemini_token_unavailable', 502);
          console.error(`[AlexLive] token error: ${safeErrorMessage(error)}`);
          return c.json({ error: alexError.code }, alexError.status);
        }
      },
    }),
    registerApiRoute('/alex/live/meta', {
      method: 'POST',
      handler: async (c: any) => {
        if (!isDashboardRequest(c)) return c.json({ error: 'alex_dashboard_only' }, 403);
        try {
          const body = await c.req.json().catch(() => ({}));
          return c.json(await submitToMeta(body));
        } catch (error) {
          const alexError = toAlexLiveError(error, 'meta_request_failed', 500);
          console.error(`[AlexLive] Meta bridge error: ${safeErrorMessage(error)}`);
          return c.json({ error: alexError.code }, alexError.status);
        }
      },
    }),
    registerApiRoute('/alex/live/status', {
      method: 'GET',
      handler: async (c: any) => {
        if (!isDashboardRequest(c)) return c.json({ error: 'alex_dashboard_only' }, 403);
        try {
          const status = await getAlexSystemStatus();
          return c.json(status);
        } catch (error) {
          console.error(`[AlexLive] status error: ${safeErrorMessage(error)}`);
          return c.json({ error: 'status_check_failed', message: safeErrorMessage(error) }, 500);
        }
      },
    }),
    registerApiRoute('/alex/live/approvals', {
      method: 'GET',
      handler: async (c: any) => {
        if (!isDashboardRequest(c)) return c.json({ error: 'alex_dashboard_only' }, 403);
        try {
          const approvals = await getAlexPendingApprovals();
          return c.json(approvals);
        } catch (error) {
          console.error(`[AlexLive] approvals error: ${safeErrorMessage(error)}`);
          return c.json({ error: 'approvals_check_failed', message: safeErrorMessage(error) }, 500);
        }
      },
    }),
    registerApiRoute('/alex/live/task/:id', {
      method: 'GET',
      handler: async (c: any) => {
        if (!isDashboardRequest(c)) return c.json({ error: 'alex_dashboard_only' }, 403);
        try {
          const id = c.req.param('id');
          const task = await getAlexTaskStatus(id);
          return c.json(task);
        } catch (error) {
          console.error(`[AlexLive] task status error: ${safeErrorMessage(error)}`);
          return c.json({ error: 'task_status_failed', message: safeErrorMessage(error) }, 500);
        }
      },
    }),
    registerApiRoute('/dashboard-ui/alex.js', {
      method: 'GET',
      handler: async (c: any) => serveDashboardAsset(c, resolve(dashboardDir, 'alex.js'), 'application/javascript; charset=utf-8'),
    }),
    registerApiRoute('/dashboard-ui/alex.css', {
      method: 'GET',
      handler: async (c: any) => serveDashboardAsset(c, resolve(dashboardDir, 'alex.css'), 'text/css; charset=utf-8'),
    }),
  ];
}

export async function getAlexSystemStatus(): Promise<{
  text: string;
  counts: { running: number; queued: number; blocked: number; awaiting_approval: number };
  killSwitch: boolean;
}> {
  if (!isLedgerEnabled()) {
    return {
      text: 'Task Ledger jest obecnie wyłączony w konfiguracji środowiska.',
      counts: { running: 0, queued: 0, blocked: 0, awaiting_approval: 0 },
      killSwitch: false,
    };
  }
  const digest = await getLedgerDigest({ markDigested: false });
  return {
    text: digest.text,
    counts: digest.counts,
    killSwitch: digest.killSwitch,
  };
}

export async function getAlexPendingApprovals(): Promise<{
  count: number;
  text: string;
  approvals: Array<{ id: string; tool: string; action?: string; agentId?: string; createdAt?: string }>;
}> {
  try {
    const db = await getDb();
    const records = await db.collection('approvals')
      .find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    if (records.length === 0) {
      return {
        count: 0,
        text: 'Brak zadań oczekujących na zatwierdzenie. Wszystkie procesy działają bez blokad.',
        approvals: [],
      };
    }

    const items = records.map((r) => ({
      id: String(r.id || r._id),
      tool: String(r.tool || 'unknown'),
      action: typeof r.action === 'string' ? r.action : undefined,
      agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
    }));

    const lines = items.map((item, idx) => {
      const desc = item.action ? `: ${item.action}` : '';
      return `${idx + 1}. [${item.tool}] agent ${item.agentId ?? 'meta'}${desc} (ID: ${item.id.slice(0, 8)})`;
    });

    return {
      count: items.length,
      text: `Oczekuje ${items.length} zatwierdzeń:\n${lines.join('\n')}`,
      approvals: items,
    };
  } catch (error) {
    return {
      count: 0,
      text: `Błąd odczytu oczekujących zatwierdzeń: ${safeErrorMessage(error)}`,
      approvals: [],
    };
  }
}

export async function getAlexTaskStatus(laneRef: string | number): Promise<{
  found: boolean;
  text: string;
  lane?: unknown;
}> {
  if (!isLedgerEnabled()) {
    return {
      found: false,
      text: 'Task Ledger jest obecnie wyłączony w konfiguracji środowiska.',
    };
  }
  const cleanRef = typeof laneRef === 'string' ? laneRef.replace(/^#/, '').trim() : laneRef;
  const normalizedRef = typeof cleanRef === 'string' && /^\d+$/.test(cleanRef) ? Number(cleanRef) : cleanRef;
  const lane = await getLane(normalizedRef);
  if (!lane) {
    return {
      found: false,
      text: `Nie znaleziono zadania o identyfikatorze lub numerze ${laneRef}.`,
    };
  }
  const milestones = lane.milestones.slice(-3)
    .map((m) => `${m.at.toISOString().slice(11, 19)}: ${m.note}`)
    .join(', ');
  const errorPart = lane.error ? ` Błąd: ${lane.error}.` : '';
  const text = `Zadanie #${lane.laneNo} [${lane.state}] dla agenta ${lane.agentId ?? lane.source}. Cel: ${lane.goal}.${errorPart} Ostatnie zdarzenia: ${milestones || 'brak'}.`;
  return {
    found: true,
    text,
    lane,
  };
}

export class AlexLiveError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'AlexLiveError';
  }
}

function validateMetaTurn(input: AlexMetaTurnInput): AlexMetaTurnInput {
  const conversationId = typeof input?.conversationId === 'string' ? input.conversationId.trim() : '';
  const utteranceId = typeof input?.utteranceId === 'string' ? input.utteranceId.trim() : '';
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (!SAFE_ID.test(conversationId)) throw new AlexLiveError('invalid_conversation_id', 400);
  if (!SAFE_ID.test(utteranceId)) throw new AlexLiveError('invalid_utterance_id', 400);
  if (!message) throw new AlexLiveError('message_required', 400);
  if (message.length > MAX_MESSAGE_CHARS) throw new AlexLiveError('message_too_large', 413);
  return { conversationId, utteranceId, message };
}

function extractMetaText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim();
  if (typeof record.response === 'string') return record.response.trim();
  const message = record.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content.trim();
  }
  return '';
}

function limitVoiceSource(fullText: string): { text: string; truncated: boolean } {
  if (fullText.length <= MAX_VOICE_SOURCE_CHARS) return { text: fullText, truncated: false };
  const headLength = Math.floor(MAX_VOICE_SOURCE_CHARS * 0.75);
  const tailLength = MAX_VOICE_SOURCE_CHARS - headLength;
  return {
    text: `${fullText.slice(0, headLength)}\n\n[...środek pełnej odpowiedzi jest widoczny w interfejsie...]\n\n${fullText.slice(-tailLength)}`,
    truncated: true,
  };
}

function pruneTurnCache(
  cache: Map<string, { createdAt: number; promise: Promise<AlexMetaTurnResult> }>,
): void {
  const expiry = Date.now() - TURN_CACHE_TTL_MS;
  for (const [key, entry] of cache) {
    if (entry.createdAt < expiry) cache.delete(key);
  }
  while (cache.size >= TURN_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function clampNumber(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function isDashboardRequest(c: any): boolean {
  if (c.req.header('x-alex-client') !== 'dashboard-v1') return false;
  const fetchSite = c.req.header('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'same-site';
}

async function serveDashboardAsset(c: any, assetPath: string, contentType: string) {
  try {
    const body = await readFile(assetPath, 'utf8');
    return c.body(body, 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (error) {
    return c.json({ error: 'alex_asset_not_found', details: safeErrorMessage(error) }, 500);
  }
}

function toAlexLiveError(error: unknown, fallbackCode: string, fallbackStatus: number): AlexLiveError {
  return error instanceof AlexLiveError
    ? error
    : new AlexLiveError(fallbackCode, fallbackStatus);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
