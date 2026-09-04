import { GoogleGenAI, Modality } from '@google/genai';

type AlexConfig = {
  enabled: boolean;
  name: string;
  model: string;
  voice: string;
  inputSampleRate: number;
  outputSampleRate: number;
};

type AlexToken = {
  token: string;
  model: string;
  expiresAt: string;
};

type MetaTurnResult = {
  conversationId: string;
  utteranceId: string;
  fullText: string;
  voiceSource: string;
  voiceSourceTruncated: boolean;
  elapsedMs: number;
};

type LiveSession = {
  sendRealtimeInput: (input: Record<string, unknown>) => void;
  sendToolResponse: (input: Record<string, unknown>) => void;
  close: () => void;
};

type TranscriptTurn = {
  id: string;
  user: string;
  fullText: string;
  summary: string;
  elapsedMs?: number;
  truncated?: boolean;
  element?: HTMLElement;
};

const CLIENT_HEADER = { 'x-alex-client': 'dashboard-v1' };
const CONVERSATION_STORAGE_KEY = 'alex-live.conversation-id.v1';
const RECONNECT_MAX_MS = 30_000;
const WORKLET_SOURCE = `
class AlexPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pending = [];
    this.readPosition = 0;
    this.output = [];
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    for (let i = 0; i < input.length; i += 1) this.pending.push(input[i]);

    while (this.readPosition + this.ratio <= this.pending.length) {
      const start = Math.floor(this.readPosition);
      const end = Math.max(start + 1, Math.floor(this.readPosition + this.ratio));
      let sum = 0;
      let count = 0;
      for (let i = start; i < end && i < this.pending.length; i += 1) {
        sum += this.pending[i];
        count += 1;
      }
      const sample = Math.max(-1, Math.min(1, count ? sum / count : 0));
      this.output.push(sample < 0 ? sample * 32768 : sample * 32767);
      this.readPosition += this.ratio;

      if (this.output.length >= 640) {
        const pcm = new Int16Array(this.output.splice(0, 640));
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 1024) {
      this.pending.splice(0, consumed);
      this.readPosition -= consumed;
    }
    return true;
  }
}
registerProcessor('alex-pcm-capture', AlexPcmCapture);
`;

const state = {
  config: null as AlexConfig | null,
  session: null as LiveSession | null,
  connectPromise: null as Promise<void> | null,
  sessionWanted: false,
  connectionSerial: 0,
  reconnectAttempt: 0,
  reconnectTimer: 0 as number | undefined,
  pttHeld: false,
  alwaysListening: false,
  toolBusy: false,
  audioContext: null as AudioContext | null,
  workletLoaded: false,
  micStream: null as MediaStream | null,
  micSource: null as MediaStreamAudioSourceNode | null,
  captureNode: null as AudioWorkletNode | null,
  silentGain: null as GainNode | null,
  playbackSources: new Set<AudioBufferSourceNode>(),
  nextPlaybackTime: 0,
  outputTranscript: '',
  inputTranscript: '',
  turnCompletePending: false,
  finishTimer: 0 as number | undefined,
  pendingSummaryTurn: null as TranscriptTurn | null,
  turns: [] as TranscriptTurn[],
  conversationId: loadConversationId(),
  callIds: new Map<string, string>(),
};

let moduleRoot: HTMLElement;
let root: HTMLElement;
let statusText: HTMLElement;
let pttButton: HTMLButtonElement;
let alwaysToggle: HTMLInputElement;
let lastTurn: HTMLElement;
let fullButton: HTMLButtonElement;
let disconnectButton: HTMLButtonElement;
let drawer: HTMLElement;
let backdrop: HTMLElement;
let transcript: HTMLElement;

void boot();

async function boot(): Promise<void> {
  try {
    const response = await fetch('/alex/live/config', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json() as AlexConfig;
    if (!config.enabled) return;
    state.config = config;
    mount(config);
  } catch {
    // A disabled Alex has no routes by design. The rest of the dashboard must
    // stay completely unaffected.
  }
}

function mount(config: AlexConfig): void {
  moduleRoot = requireElement<HTMLElement>('alex-live-module');
  const slot = requireElement<HTMLElement>('alex-live-slot');
  moduleRoot.hidden = false;
  slot.innerHTML = `
    <div class="alex-live" data-state="idle">
      <div class="alex-status-row">
        <div class="alex-status"><span class="alex-status-dot"></span><span id="alex-status-text">Gotowy do połączenia</span></div>
        <div class="alex-model" title="${escapeAttribute(config.model)}">${escapeHtml(config.voice)}</div>
      </div>
      <label class="alex-mode-row">
        <span>Ciągły nasłuch</span>
        <span class="alex-switch"><input id="alex-always" type="checkbox" aria-label="Ciągły nasłuch"><span></span></span>
      </label>
      <button id="alex-ptt" class="alex-ptt" type="button">Przytrzymaj, aby mówić</button>
      <div class="alex-hint">Przycisk albo spacja przy aktywnym dashboardzie. Puść, aby wysłać wypowiedź.</div>
      <div id="alex-last-turn" class="alex-last-turn"></div>
      <div class="alex-actions">
        <button id="alex-disconnect" class="alex-text-button" type="button" disabled>Rozłącz</button>
        <button id="alex-full" class="alex-text-button" type="button" disabled>Pełne odpowiedzi</button>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="alex-backdrop" class="alex-backdrop" aria-hidden="true"></div>
    <aside id="alex-drawer" class="alex-drawer" aria-hidden="true" aria-label="Pełne odpowiedzi Jarvis Meta">
      <div class="alex-drawer-header">
        <div>
          <h2 class="alex-drawer-title">ALEX ⇄ JARVIS META</h2>
          <div class="alex-drawer-subtitle">Pełny wynik Meta jest tutaj. Alex mówi tylko krótkie podsumowanie.</div>
        </div>
        <button id="alex-close" class="alex-close" type="button" aria-label="Zamknij">×</button>
      </div>
      <div id="alex-transcript" class="alex-transcript"><div class="alex-empty">Pierwsza pełna odpowiedź Meta pojawi się tutaj.</div></div>
    </aside>`);

  root = slot.querySelector<HTMLElement>('.alex-live')!;
  statusText = requireElement('alex-status-text');
  pttButton = requireElement('alex-ptt');
  alwaysToggle = requireElement('alex-always');
  lastTurn = requireElement('alex-last-turn');
  fullButton = requireElement('alex-full');
  disconnectButton = requireElement('alex-disconnect');
  drawer = requireElement('alex-drawer');
  backdrop = requireElement('alex-backdrop');
  transcript = requireElement('alex-transcript');

  pttButton.addEventListener('pointerdown', onPointerDown);
  pttButton.addEventListener('pointerup', endPushToTalk);
  pttButton.addEventListener('pointercancel', endPushToTalk);
  pttButton.addEventListener('lostpointercapture', endPushToTalk);
  pttButton.addEventListener('contextmenu', (event) => event.preventDefault());
  alwaysToggle.addEventListener('change', () => void changeAlwaysListening(alwaysToggle.checked));
  disconnectButton.addEventListener('click', disconnect);
  fullButton.addEventListener('click', openDrawer);
  requireElement('alex-close').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pagehide', disconnect);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.pttHeld) endPushToTalk();
  });
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || state.alwaysListening || state.toolBusy) return;
  pttButton.setPointerCapture(event.pointerId);
  void beginPushToTalk();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.code !== 'Space' || event.repeat || state.alwaysListening || state.toolBusy) return;
  if (isEditableTarget(event.target)) return;
  event.preventDefault();
  void beginPushToTalk();
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code !== 'Space' || isEditableTarget(event.target)) return;
  if (!state.pttHeld) return;
  event.preventDefault();
  endPushToTalk();
}

async function beginPushToTalk(): Promise<void> {
  if (state.pttHeld || state.alwaysListening || state.toolBusy) return;
  state.pttHeld = true;
  pttButton.classList.add('is-held');
  clearPlayback();
  setState('connecting', 'Łączenie i uruchamianie mikrofonu…');
  try {
    await Promise.all([ensureConnected(), ensureMicrophone()]);
    if (!state.pttHeld) return;
    setState('listening', 'Słucham — puść, aby wysłać');
  } catch (error) {
    state.pttHeld = false;
    pttButton.classList.remove('is-held');
    releaseMicrophone();
    showError(error);
  }
}

function endPushToTalk(): void {
  if (!state.pttHeld) return;
  state.pttHeld = false;
  pttButton.classList.remove('is-held');
  signalAudioStreamEnd();
  if (!state.alwaysListening) releaseMicrophone();
  if (!state.toolBusy) setState(state.session ? 'ready' : 'idle', state.session ? 'Przekazuję wypowiedź…' : 'Gotowy do połączenia');
}

async function changeAlwaysListening(enabled: boolean): Promise<void> {
  state.alwaysListening = enabled;
  pttButton.disabled = enabled;
  pttButton.textContent = enabled ? 'Ciągły nasłuch aktywny' : 'Przytrzymaj, aby mówić';
  if (!enabled) {
    signalAudioStreamEnd();
    releaseMicrophone();
    if (!state.toolBusy) setState(state.session ? 'ready' : 'idle', state.session ? 'Połączony — nasłuch wyłączony' : 'Gotowy do połączenia');
    return;
  }

  clearPlayback();
  setState('connecting', 'Włączam ciągły nasłuch…');
  try {
    await Promise.all([ensureConnected(), ensureMicrophone()]);
    if (state.alwaysListening && !state.toolBusy) setState('listening', 'Słucham cały czas');
  } catch (error) {
    state.alwaysListening = false;
    alwaysToggle.checked = false;
    pttButton.disabled = false;
    pttButton.textContent = 'Przytrzymaj, aby mówić';
    releaseMicrophone();
    showError(error);
  }
}

async function ensureConnected(): Promise<void> {
  if (state.session) return;
  if (state.connectPromise) return state.connectPromise;
  state.sessionWanted = true;
  const serial = ++state.connectionSerial;
  setState('connecting', 'Łączę Alexa z Gemini Live…');
  state.connectPromise = (async () => {
    const tokenResponse = await fetch('/alex/live/token', {
      method: 'POST',
      headers: { ...CLIENT_HEADER, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!tokenResponse.ok) throw new Error(await friendlyHttpError(tokenResponse, 'Nie udało się utworzyć sesji Gemini Live.'));
    const credentials = await tokenResponse.json() as AlexToken;
    const ai = new GoogleGenAI({
      apiKey: credentials.token,
      httpOptions: { apiVersion: 'v1beta' },
    });
    const session = await ai.live.connect({
      model: credentials.model,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen: () => {
          if (serial !== state.connectionSerial) return;
          state.reconnectAttempt = 0;
          disconnectButton.disabled = false;
        },
        onmessage: (message) => {
          if (serial === state.connectionSerial) void handleServerMessage(message as Record<string, any>);
        },
        onerror: () => {
          if (serial === state.connectionSerial) setState('error', 'Błąd połączenia Gemini Live');
        },
        onclose: () => {
          if (serial !== state.connectionSerial) return;
          state.session = null;
          disconnectButton.disabled = true;
          clearPlayback();
          if (state.sessionWanted) scheduleReconnect();
        },
      },
    });
    if (serial !== state.connectionSerial) {
      session.close();
      return;
    }
    state.session = session as LiveSession;
    setState(state.alwaysListening || state.pttHeld ? 'listening' : 'ready', state.alwaysListening ? 'Słucham cały czas' : state.pttHeld ? 'Słucham — puść, aby wysłać' : 'Alex połączony');
  })().finally(() => {
    state.connectPromise = null;
  });
  return state.connectPromise;
}

function scheduleReconnect(): void {
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  const delay = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** state.reconnectAttempt++);
  setState('connecting', `Ponowne łączenie za ${Math.ceil(delay / 1000)} s…`);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = undefined;
    if (!state.sessionWanted) return;
    void ensureConnected().catch((error) => {
      showError(error);
      if (state.sessionWanted) scheduleReconnect();
    });
  }, delay);
}

function disconnect(): void {
  state.sessionWanted = false;
  state.connectionSerial += 1;
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
  if (state.finishTimer) window.clearTimeout(state.finishTimer);
  state.finishTimer = undefined;
  state.turnCompletePending = false;
  const session = state.session;
  state.session = null;
  try { session?.close(); } catch { /* best effort */ }
  state.connectPromise = null;
  state.pttHeld = false;
  state.alwaysListening = false;
  state.toolBusy = false;
  if (alwaysToggle) alwaysToggle.checked = false;
  if (pttButton) {
    pttButton.disabled = false;
    pttButton.classList.remove('is-held');
    pttButton.textContent = 'Przytrzymaj, aby mówić';
  }
  if (disconnectButton) disconnectButton.disabled = true;
  clearPlayback();
  releaseMicrophone();
  if (root) setState('idle', 'Rozłączony');
}

async function ensureAudioContext(): Promise<AudioContext> {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioContext({ latencyHint: 'interactive' });
    state.workletLoaded = false;
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  if (!state.workletLoaded) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await state.audioContext.audioWorklet.addModule(url);
      state.workletLoaded = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return state.audioContext;
}

async function ensureMicrophone(): Promise<void> {
  if (state.micStream?.active) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Ta przeglądarka nie udostępnia mikrofonu.');
  const [context, stream] = await Promise.all([
    ensureAudioContext(),
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  ]);
  state.micStream = stream;
  state.micSource = context.createMediaStreamSource(stream);
  state.captureNode = new AudioWorkletNode(context, 'alex-pcm-capture');
  state.silentGain = context.createGain();
  state.silentGain.gain.value = 0;
  state.captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!shouldStreamMicrophone() || !(event.data instanceof ArrayBuffer)) return;
    try {
      state.session?.sendRealtimeInput({
        audio: {
          data: arrayBufferToBase64(event.data),
          mimeType: `audio/pcm;rate=${state.config?.inputSampleRate ?? 16_000}`,
        },
      });
    } catch {
      // A close callback will reconnect; dropping a partial audio chunk is safer
      // than replaying speech and accidentally duplicating a Meta task.
    }
  };
  state.micSource.connect(state.captureNode);
  state.captureNode.connect(state.silentGain);
  state.silentGain.connect(context.destination);
}

function shouldStreamMicrophone(): boolean {
  return Boolean(state.session && !state.toolBusy && (state.pttHeld || state.alwaysListening));
}

function releaseMicrophone(): void {
  try { state.micSource?.disconnect(); } catch { /* no-op */ }
  try { state.captureNode?.disconnect(); } catch { /* no-op */ }
  try { state.silentGain?.disconnect(); } catch { /* no-op */ }
  for (const track of state.micStream?.getTracks() ?? []) track.stop();
  state.micStream = null;
  state.micSource = null;
  state.captureNode = null;
  state.silentGain = null;
}

function signalAudioStreamEnd(): void {
  try { state.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* socket is closing */ }
}

async function handleServerMessage(message: Record<string, any>): Promise<void> {
  if (message.goAway) {
    setState('connecting', 'Gemini odnawia sesję…');
  }

  if (message.toolCall?.functionCalls?.length) {
    await handleToolCalls(message.toolCall.functionCalls as Array<Record<string, any>>);
  }

  const content = message.serverContent;
  if (!content) return;
  if (content.interrupted) {
    clearPlayback();
    state.outputTranscript = '';
  }

  if (content.inputTranscription?.text) {
    state.inputTranscript = mergeTranscript(state.inputTranscript, String(content.inputTranscription.text));
  }
  if (content.outputTranscription?.text) {
    state.outputTranscript = mergeTranscript(state.outputTranscript, String(content.outputTranscription.text));
    if (state.turnCompletePending) scheduleSpokenTurnFinish(160);
  }

  for (const part of content.modelTurn?.parts ?? []) {
    const audio = part.inlineData;
    if (audio?.data && String(audio.mimeType ?? '').startsWith('audio/')) {
      queuePlayback(String(audio.data), sampleRateFromMime(audio.mimeType) ?? state.config?.outputSampleRate ?? 24_000);
    }
  }

  if (content.turnComplete) {
    state.turnCompletePending = true;
    // Transcription is explicitly unordered relative to turnComplete in the
    // Live protocol, so leave a short grace period for its final fragment.
    scheduleSpokenTurnFinish(320);
  }
}

async function handleToolCalls(functionCalls: Array<Record<string, any>>): Promise<void> {
  const responses: Array<Record<string, unknown>> = [];
  for (const call of functionCalls) {
    const name = String(call.name ?? '');
    const id = String(call.id ?? randomId('call'));

    if (name === 'get_system_status') {
      const utteranceId = utteranceIdForCall(id);
      const turn = upsertPendingTurn(utteranceId, '📊 Sprawdź status systemu');
      state.pendingSummaryTurn = turn;
      state.toolBusy = true;
      clearPlayback();
      setState('working', 'Sprawdzam status systemu…');
      try {
        const response = await fetch('/alex/live/status', {
          headers: CLIENT_HEADER,
        });
        if (!response.ok) throw new Error(await friendlyHttpError(response, 'Nie udało się pobrać statusu systemu.'));
        const result = await response.json() as { text: string; counts: unknown; killSwitch: boolean };
        turn.fullText = result.text;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            systemStatus: result.text,
            counts: result.counts,
            killSwitch: result.killSwitch,
          },
        });
      } catch (error) {
        turn.fullText = `Błąd pobierania statusu: ${errorMessage(error)}`;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            error: 'status_check_failed',
            userMessage: 'Nie udało się pobrać statusu systemu. Powiedz krótko o błędzie połączenia.',
          },
        });
      } finally {
        state.toolBusy = false;
      }
      continue;
    }

    if (name === 'get_pending_approvals') {
      const utteranceId = utteranceIdForCall(id);
      const turn = upsertPendingTurn(utteranceId, '⏳ Sprawdź oczekujące zgody');
      state.pendingSummaryTurn = turn;
      state.toolBusy = true;
      clearPlayback();
      setState('working', 'Sprawdzam oczekujące zgody…');
      try {
        const response = await fetch('/alex/live/approvals', {
          headers: CLIENT_HEADER,
        });
        if (!response.ok) throw new Error(await friendlyHttpError(response, 'Nie udało się pobrać listy zgód.'));
        const result = await response.json() as { text: string; count: number; approvals: unknown[] };
        turn.fullText = result.text;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            pendingApprovals: result.text,
            count: result.count,
          },
        });
      } catch (error) {
        turn.fullText = `Błąd sprawdzania zgód: ${errorMessage(error)}`;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            error: 'approvals_check_failed',
            userMessage: 'Nie udało się sprawdzić oczekujących zgód. Powiedz krótko o błędzie.',
          },
        });
      } finally {
        state.toolBusy = false;
      }
      continue;
    }

    if (name === 'get_task_status') {
      const laneId = String(call.args?.laneId ?? '').trim();
      const utteranceId = utteranceIdForCall(id);
      const turn = upsertPendingTurn(utteranceId, `🔍 Status zadania ${laneId || '?'}`);
      state.pendingSummaryTurn = turn;
      state.toolBusy = true;
      clearPlayback();
      setState('working', `Sprawdzam zadanie ${laneId}…`);
      try {
        const response = await fetch('/alex/live/task/' + encodeURIComponent(laneId), {
          headers: CLIENT_HEADER,
        });
        if (!response.ok) throw new Error(await friendlyHttpError(response, `Nie udało się pobrać statusu zadania ${laneId}.`));
        const result = await response.json() as { found: boolean; text: string };
        turn.fullText = result.text;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            taskStatus: result.text,
            found: result.found,
          },
        });
      } catch (error) {
        turn.fullText = `Błąd sprawdzania zadania ${laneId}: ${errorMessage(error)}`;
        renderTranscript();
        responses.push({
          id,
          name,
          response: {
            error: 'task_status_failed',
            userMessage: `Nie udało się sprawdzić zadania ${laneId}. Powiedz krótko o błędzie.`,
          },
        });
      } finally {
        state.toolBusy = false;
      }
      continue;
    }

    if (name !== 'send_to_meta') {
      responses.push({ id, name, response: { error: 'unsupported_function' } });
      continue;
    }

    const message = typeof call.args?.message === 'string' ? call.args.message.trim() : '';
    if (!message) {
      responses.push({ id, name, response: { error: 'empty_user_message' } });
      continue;
    }

    const utteranceId = utteranceIdForCall(id);
    const turn = upsertPendingTurn(utteranceId, message);
    state.pendingSummaryTurn = turn;
    state.toolBusy = true;
    clearPlayback();
    setState('working', 'Jarvis Meta pracuje…');
    try {
      const response = await fetch('/alex/live/meta', {
        method: 'POST',
        headers: { ...CLIENT_HEADER, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: state.conversationId,
          utteranceId,
          message,
        }),
      });
      if (!response.ok) throw new Error(await friendlyHttpError(response, 'Jarvis Meta nie zwrócił odpowiedzi.'));
      const result = await response.json() as MetaTurnResult;
      turn.fullText = result.fullText;
      turn.elapsedMs = result.elapsedMs;
      turn.truncated = result.voiceSourceTruncated;
      renderTranscript();
      openDrawer();
      responses.push({
        id,
        name,
        response: {
          metaReply: result.voiceSource,
          fullReplyVisibleInInterface: true,
          sourceTruncatedForVoice: result.voiceSourceTruncated,
        },
      });
    } catch (error) {
      turn.fullText = `Błąd połączenia z Jarvis Meta: ${errorMessage(error)}`;
      renderTranscript();
      openDrawer();
      responses.push({
        id,
        name,
        response: {
          error: 'meta_bridge_failed',
          userMessage: 'Nie udało się teraz uzyskać odpowiedzi Jarvis Meta. Powiedz użytkownikowi krótko, że wystąpił błąd i może spróbować ponownie.',
        },
      });
    } finally {
      state.toolBusy = false;
    }
  }

  try {
    state.session?.sendToolResponse({ functionResponses: responses });
    setState('speaking', 'Alex przygotowuje krótkie podsumowanie…');
  } catch (error) {
    showError(error);
  }
}

function upsertPendingTurn(id: string, user: string): TranscriptTurn {
  let turn = state.turns.find((candidate) => candidate.id === id);
  if (!turn) {
    turn = { id, user, fullText: '', summary: '' };
    state.turns.push(turn);
  }
  lastTurn.textContent = `Ty: ${user}`;
  lastTurn.classList.add('has-text');
  fullButton.disabled = false;
  renderTranscript();
  return turn;
}

function finishSpokenTurn(): void {
  if (state.finishTimer) window.clearTimeout(state.finishTimer);
  state.finishTimer = undefined;
  state.turnCompletePending = false;
  const summary = state.outputTranscript.trim();
  if (summary && state.pendingSummaryTurn) {
    state.pendingSummaryTurn.summary = summary;
    lastTurn.textContent = `Alex: ${summary}`;
    lastTurn.classList.add('has-text');
    renderTranscript();
  } else if (summary) {
    lastTurn.textContent = `Alex: ${summary}`;
    lastTurn.classList.add('has-text');
  }
  state.pendingSummaryTurn = null;
  state.outputTranscript = '';
  state.inputTranscript = '';
  if (state.alwaysListening) setState('listening', 'Słucham cały czas');
  else if (state.session) setState('ready', 'Alex połączony');
}

function scheduleSpokenTurnFinish(delayMs: number): void {
  if (state.finishTimer) window.clearTimeout(state.finishTimer);
  state.finishTimer = window.setTimeout(finishSpokenTurn, delayMs);
}

function renderTranscript(): void {
  transcript.replaceChildren();
  if (!state.turns.length) {
    const empty = document.createElement('div');
    empty.className = 'alex-empty';
    empty.textContent = 'Pierwsza pełna odpowiedź Meta pojawi się tutaj.';
    transcript.append(empty);
    return;
  }
  for (const turn of [...state.turns].reverse()) {
    const article = document.createElement('article');
    article.className = 'alex-turn';
    const user = turnSection('alex-turn-user', 'Ty', turn.user);
    const summary = turnSection('alex-turn-summary', 'Alex — skrót głosowy', turn.summary || 'Oczekiwanie na skrót głosowy…');
    if (turn.summary) summary.classList.add('has-text');
    const full = turnSection('alex-turn-full', 'Jarvis Meta — pełna odpowiedź', turn.fullText || 'Meta pracuje…');
    article.append(user, summary, full);
    if (turn.elapsedMs !== undefined) {
      const meta = document.createElement('div');
      meta.className = 'alex-turn-meta';
      meta.textContent = `Meta: ${(turn.elapsedMs / 1000).toFixed(1)} s${turn.truncated ? ' · źródło skrótu ograniczone, pełny tekst zachowany' : ''}`;
      article.append(meta);
    }
    transcript.append(article);
    turn.element = article;
  }
}

function turnSection(className: string, labelText: string, value: string): HTMLElement {
  const section = document.createElement('div');
  section.className = className;
  const label = document.createElement('span');
  label.className = 'alex-turn-label';
  label.textContent = labelText;
  section.append(label, document.createTextNode(value));
  return section;
}

function openDrawer(): void {
  drawer.classList.add('is-open');
  backdrop.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeDrawer(): void {
  drawer.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  backdrop.setAttribute('aria-hidden', 'true');
}

function queuePlayback(base64: string, sampleRate: number): void {
  void (async () => {
    const context = await ensureAudioContext();
    const bytes = base64ToBytes(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.025, state.nextPlaybackTime);
    state.nextPlaybackTime = startAt + buffer.duration;
    state.playbackSources.add(source);
    source.onended = () => state.playbackSources.delete(source);
    source.start(startAt);
    if (!state.pttHeld && !state.alwaysListening) setState('speaking', 'Alex mówi…');
  })().catch(showError);
}

function clearPlayback(): void {
  for (const source of state.playbackSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  state.playbackSources.clear();
  state.nextPlaybackTime = state.audioContext?.currentTime ?? 0;
}

function setState(kind: string, label: string): void {
  root.dataset.state = kind;
  statusText.textContent = label;
}

function showError(error: unknown): void {
  setState('error', errorMessage(error));
}

function signalSafeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function mergeTranscript(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current} ${next}`.trim();
}

function sampleRateFromMime(mime: unknown): number | undefined {
  const match = /rate=(\d+)/i.exec(signalSafeText(mime));
  return match ? Number(match[1]) : undefined;
}

function utteranceIdForCall(callId: string): string {
  const known = state.callIds.get(callId);
  if (known) return known;
  const normalized = callId.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 108);
  const id = `utt-${normalized || crypto.randomUUID()}`;
  state.callIds.set(callId, id);
  return id;
}

function loadConversationId(): string {
  const stored = localStorage.getItem(CONVERSATION_STORAGE_KEY);
  if (stored && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(stored)) return stored;
  const id = randomId('alex');
  localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  return id;
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}

async function friendlyHttpError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    if (body.error === 'gemini_api_key_missing') return 'Brakuje klucza Gemini API w konfiguracji Mastry.';
    if (body.error) return `${fallback} (${body.error})`;
  } catch { /* non-JSON response */ }
  return `${fallback} (HTTP ${response.status})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Brak elementu interfejsu: ${id}`);
  return element as T;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
