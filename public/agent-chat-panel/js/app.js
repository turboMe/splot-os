/**
 * APP - AGENT CHAT PANEL (SPLOT OS)
 * Główny punkt wejścia aplikacji frontendowej z pełną integracją:
 * - Realny silnik czatu ze wszystkimi 18 agentami Mastra
 * - Prawdziwa historia wątków i wiadomości z MongoDB
 * - Dynamiczny akordeon kroków procesu z realnymi parametrami JSON i czasem
 * - Dynamiczne szuflady: Pamięć Obserwacyjna, Task Ledger, Artefakty
 */

import { AGENTS, AppState, getAgentSvg } from './state.js';
import { AgentTurnController } from './turn-controller.js';
import { buildMemoryInspector, buildLedgerInspector, buildArtifactsInspector } from './memory-inspector.js';
import { VoiceInputController } from './voice-input.js';

// ── GLOBAL: Rejestr aktywnych strumieni SSE (per pane) dla przycisku Stop ──
// Przechowuje { reader, turn, paneType } aktywnej tury — pozwala na anulowanie.
window.__splotActiveStream = { main: null, side: null };

// Realny wskaźnik (mysz/trackpad) vs. dotyk — hover-only UI ma sens tylko dla tego pierwszego.
// Urządzenia hybrydowe (laptop z dotykiem) raportują `hover: hover`, dlatego dodatkowo
// sprawdzamy `pointerType` w samym zdarzeniu.
export const FINE_POINTER = window.matchMedia('(hover: hover) and (pointer: fine)');

// Wąski ekran — sidebar wątków przykrywa wtedy czat, zamiast stać obok niego.
export const NARROW_SCREEN = window.matchMedia('(max-width: 720px)');

// „Czy to telefon" mierzone KRÓTSZYM bokiem ekranu fizycznego, a nie `innerWidth`.
// Powód: po podmianie <meta viewport> na width=1280 `innerWidth` zaczyna zwracać 1280,
// więc test oparty na nim nie pozwoliłby już wrócić do widoku mobilnego. `screen` jest
// niezależny od meta, a krótszy bok jest odporny na obrót telefonu.
const SCREEN_SHORT_SIDE = Math.min(window.screen?.width || 0, window.screen?.height || 0);
// `> 0` bo brak/zerowy `screen` musi znaczyć „nie wiem", a nie „telefon" — inaczej desktop
// dostałby podmieniony viewport i powiększone fonty.
export const IS_PHONE = SCREEN_SHORT_SIDE > 0 && SCREEN_SHORT_SIDE <= 720;

// Dotyk to OSOBNE pytanie od „czy telefon": Safari zoomuje przy focusie tak samo na iPhonie
// i na iPadzie, więc próg 16px dla pól obowiązuje na obu. `pointer: coarse` jest własnością
// urządzenia, nie szerokości okna, więc łapie też telefon w poziomie i hybryda z myszką
// zostaje poza (tam pointer jest `fine`).
//
// Wystawiamy to klasą, a nie samym media query, bo `.is-touch .modal-textarea` wygrywa
// specyficznością (0,2,0) niezależnie od kolejności plików w bundlu — modals.css jest
// wklejany po layout.css i przy równej specyficzności nadpisywał ten override.
export const COARSE_POINTER = window.matchMedia('(pointer: coarse)');
if (COARSE_POINTER.matches) document.documentElement.classList.add('is-touch');

// Zakładki dashboardowe są projektowane pod ~1280px i na telefonie były przycinane bez
// możliwości przesunięcia. Podmiana viewportu sprawia, że strona układa się jak na desktopie,
// a telefon daje natywne przesuwanie i pinch-zoom. Czat zostaje przy device-width, bo tam
// liczy się czytelność pisania, a nie oglądanie całego układu naraz.
const VIEWPORT_CHAT = 'width=device-width, initial-scale=1.0';
const VIEWPORT_DASHBOARD = 'width=1280, user-scalable=yes, maximum-scale=5';

export function syncViewportForTab(tabId) {
  if (!IS_PHONE) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const wanted = tabId === 'view-chat' ? VIEWPORT_CHAT : VIEWPORT_DASHBOARD;
  if (meta.getAttribute('content') !== wanted) meta.setAttribute('content', wanted);
}

// Narzędzie Toast
let toastTimer;
export function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

// Bogaty i bezpieczny parser Markdown dla Splot OS (Tabele, Writing Blocks, Diff, Alerty, Linki, Listy)
function formatMarkdownToHtml(markdownText) {
  if (!markdownText) return '';
  let text = String(markdownText);

  // 1. Wyciągnięcie i zabezpieczenie bloków kodu (```lang ... ```)
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const safeLang = (lang || 'text').toLowerCase();
    let formattedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Specjalne kolorowanie dla bloków diff
    if (safeLang === 'diff') {
      formattedCode = formattedCode.split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return `<span class="diff-line diff-add">${line}</span>`;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          return `<span class="diff-line diff-del">${line}</span>`;
        }
        return line;
      }).join('\n');
    }

    const rawEscaped = encodeURIComponent(code.trim());
    codeBlocks.push(`
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${safeLang}</span>
          <button class="code-copy-btn" data-code="${rawEscaped}" onclick="window.__splotCopyCode(this)">Kopiuj</button>
        </div>
        <pre><code class="lang-${safeLang}">${formattedCode.trim()}</code></pre>
      </div>
    `);
    return placeholder;
  });

  // 2. Obsługa dedykowanych bloków OpenAI Writing Blocks (:::writing{variant="email" ...} ... :::)
  const writingCards = [];
  text = text.replace(/:::writing(?:\{([^}]*)\})?\n([\s\S]*?):::/g, (match, metaStr, body) => {
    const placeholder = `__WRITING_CARD_${writingCards.length}__`;
    const meta = {};
    if (metaStr) {
      const metaPairs = metaStr.match(/([a-zA-Z0-9_-]+)="([^"]*)"/g) || [];
      for (const pair of metaPairs) {
        const [k, v] = pair.split('=');
        if (k && v) meta[k.trim()] = v.replace(/"/g, '').trim();
      }
    }
    const variant = meta.variant || 'content';
    const subject = meta.subject || '';
    const badgeLabel = variant === 'email' ? '✉ E-mail' : (variant === 'social_post' ? '📢 Post Social' : '📄 Dokument');
    const rawEscaped = encodeURIComponent(body.trim());

    // Bezpieczne sformatowanie wnętrza karty
    const safeBodyHtml = body.trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br/>');

    writingCards.push(`
      <div class="writing-card" data-variant="${variant}">
        <div class="writing-card-header">
          <div class="writing-card-meta">
            <span class="writing-card-badge">${badgeLabel}</span>
            ${subject ? `<span class="writing-card-subject">Temat: <strong>${subject}</strong></span>` : ''}
          </div>
          <button class="writing-card-copy-btn" data-code="${rawEscaped}" onclick="window.__splotCopyCode(this)">Kopiuj treść</button>
        </div>
        <div class="writing-card-body"><p>${safeBodyHtml}</p></div>
      </div>
    `);
    return placeholder;
  });

  // 3. Bezpieczna ucieczka znaków HTML dla pozostałego tekstu
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 4. Inline elementy Markdown
  // Kod inline `code`
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Pogrubienie **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Kursywa *text* lub _text_
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // Linki zlinkowane cytowań [tekst](claim:1)
  text = text.replace(/\[([^\]]+)\]\(claim:([0-9]+)\)/g, '<span class="claim-citation" title="Źródło $2">$1<sup class="claim-num">[$2]</sup></span>');
  // Zwykłe linki markdown [tekst](url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');

  // 5. Linijka po linijce: Nagłówki, Alerty, Tabele, Listy, Poziome linie
  const lines = text.split('\n');
  const processed = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeaderParsed = false;

  const closeOpenStructures = () => {
    if (inUl) { processed.push('</ul>'); inUl = false; }
    if (inOl) { processed.push('</ol>'); inOl = false; }
    if (inTable) { processed.push('</tbody></table></div>'); inTable = false; tableHeaderParsed = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Sprawdzenie tabeli Markdown (| Col 1 | Col 2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        closeOpenStructures();
        processed.push('<div class="table-responsive"><table class="chat-table">');
        inTable = true;
        tableHeaderParsed = false;
      }
      // Sprawdzenie separatora tabeli (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
        tableHeaderParsed = true;
        continue;
      }
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      if (!tableHeaderParsed) {
        processed.push('<thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      } else {
        processed.push('<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>');
      }
      continue;
    } else if (inTable) {
      closeOpenStructures();
    }

    // Sprawdzenie poziomej linii (--- lub ***)
    if (/^(\-\-\-|\*\*\*)$/.test(trimmed)) {
      closeOpenStructures();
      processed.push('<hr class="chat-hr">');
      continue;
    }

    // Sprawdzenie GitHub Alerts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
    const alertMatch = trimmed.match(/^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
    if (alertMatch) {
      closeOpenStructures();
      const alertType = alertMatch[1].toUpperCase();
      const alertRest = alertMatch[2];
      const alertLabels = {
        NOTE: { icon: 'ℹ', label: 'Informacja', class: 'alert-note' },
        TIP: { icon: '💡', label: 'Wskazówka', class: 'alert-tip' },
        IMPORTANT: { icon: '❗', label: 'Ważne', class: 'alert-important' },
        WARNING: { icon: '⚠', label: 'Ostrzeżenie', class: 'alert-warning' },
        CAUTION: { icon: '🛑', label: 'Uwaga / Wymaga Zgody', class: 'alert-caution' },
      };
      const alertConfig = alertLabels[alertType] || alertLabels.NOTE;
      processed.push(`
        <div class="chat-alert ${alertConfig.class}">
          <div class="alert-head"><span class="alert-icon">${alertConfig.icon}</span> <strong>${alertConfig.label}</strong></div>
          ${alertRest ? `<p>${alertRest}</p>` : ''}
        </div>
      `);
      continue;
    }

    // Sprawdzenie zwykłego blockquote (> cytat)
    if (trimmed.startsWith('&gt; ')) {
      closeOpenStructures();
      processed.push(`<blockquote><p>${trimmed.substring(5)}</p></blockquote>`);
      continue;
    }

    // Sprawdzenie listy punktowanej (- lub *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (inOl) { processed.push('</ol>'); inOl = false; }
      if (!inUl) { processed.push('<ul class="chat-ul">'); inUl = true; }
      processed.push(`<li>${trimmed.substring(2)}</li>`);
      continue;
    }

    // Sprawdzenie listy numerowanej (1. , 2. )
    const olMatch = trimmed.match(/^([0-9]+)\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) { processed.push('</ul>'); inUl = false; }
      if (!inOl) { processed.push('<ol class="chat-ol">'); inOl = true; }
      processed.push(`<li>${olMatch[2]}</li>`);
      continue;
    }

    // Zamknięcie list, jeśli linia to zwykły tekst
    closeOpenStructures();

    if (trimmed.length > 0) {
      if (trimmed.startsWith('# ')) {
        processed.push(`<h3>${trimmed.substring(2)}</h3>`);
      } else if (trimmed.startsWith('## ')) {
        processed.push(`<h4>${trimmed.substring(3)}</h4>`);
      } else if (trimmed.startsWith('### ')) {
        processed.push(`<h5>${trimmed.substring(4)}</h5>`);
      } else if (trimmed.includes('__CODE_BLOCK_') || trimmed.includes('__WRITING_CARD_')) {
        processed.push(line);
      } else {
        processed.push(`<p>${trimmed}</p>`);
      }
    }
  }

  closeOpenStructures();
  let finalHtml = processed.join('\n');

  // Przywrócenie bloków kodu z tablicy placeholderów
  for (let idx = 0; idx < codeBlocks.length; idx++) {
    finalHtml = finalHtml.replace(`__CODE_BLOCK_${idx}__`, () => codeBlocks[idx]);
  }

  // Przywrócenie kart Writing Blocks z tablicy placeholderów
  for (let idx = 0; idx < writingCards.length; idx++) {
    finalHtml = finalHtml.replace(`__WRITING_CARD_${idx}__`, () => writingCards[idx]);
  }

  return finalHtml;
}

// Globalny handler kopiowania kodu dla Splot OS
if (typeof window !== 'undefined') {
  window.__splotCopyCode = function(btn) {
    const raw = btn.getAttribute('data-code');
    if (!raw) return;
    try {
      const text = decodeURIComponent(raw);
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.textContent;
        btn.textContent = 'Skopiowano ✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = old;
          btn.classList.remove('copied');
        }, 2000);
      });
    } catch (e) {
      console.warn('Copy failed:', e);
    }
  };
}

// Formatowanie rozmiaru pliku
function humanFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Dodawanie pigułki załącznika pliku
function addFileChip(container, fileName, fileSize) {
  const chip = document.createElement('span');
  chip.className = 'file-chip';
  chip.innerHTML = `
    <span class="fc-icon">▤</span>
    <span class="fc-name">${fileName}</span>
    <span class="fc-size">${fileSize ? ' · ' + fileSize : ''}</span>
    <span class="fc-x">✕</span>
  `;
  chip.querySelector('.fc-x').addEventListener('click', () => chip.remove());
  container.appendChild(chip);
}

// ── OBSERVATIONAL MEMORY CAPSULE & HOVER POPOVER CONTROLLER ──
function getLevelClass(percent) {
  if (percent >= 90) return 'level-high';
  if (percent >= 70) return 'level-warn';
  return '';
}

function formatTokenK(val) {
  if (val == null || isNaN(val)) return '0';
  if (val >= 1000) {
    return (val / 1000).toFixed(1) + 'k';
  }
  return String(val);
}

export async function updateMemoryCapsule(paneType = 'main', agentId = null, threadId = null) {
  const wrapperId = paneType === 'side' ? 'side-om-wrapper' : 'main-om-wrapper';
  const container = document.getElementById(wrapperId);
  if (!container) return;

  const currentAgent = agentId || (paneType === 'side' ? AppState.sideAgent?.id : AppState.activeAgent?.id) || 'metaAgent';
  const currentThread = threadId !== undefined ? threadId : (paneType === 'side' ? AppState.sideThreadId : AppState.activeThreadId);

  if (!currentThread) {
    renderMemoryCapsuleHtml(container, {
      agentId: currentAgent,
      threadId: null,
      messages: { current: 0, max: 50000, percent: 0, formatted: '0 / 50.0k' },
      observations: { current: 0, max: 60000, percent: 0, formatted: '0 / 60.0k' },
      isBuffering: false,
      scope: 'thread',
      model: 'gemini-2.5-flash',
    });
    return;
  }

  try {
    const res = await fetch(`/splot/api/memory/thread-stats?agentId=${encodeURIComponent(currentAgent)}&threadId=${encodeURIComponent(currentThread)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success && json.data) {
      renderMemoryCapsuleHtml(container, json.data);
    }
  } catch (err) {
    console.warn(`[updateMemoryCapsule:${paneType}] Failed:`, err);
  }
}

function renderMemoryCapsuleHtml(container, data) {
  const { messages, observations, isBuffering, scope, model, agentId } = data;
  const msgPercent = messages?.percent || 0;
  const obsPercent = observations?.percent || 0;
  const msgFormatted = messages?.formatted || `${formatTokenK(messages?.current)} / ${formatTokenK(messages?.max)}`;
  const obsFormatted = observations?.formatted || `${formatTokenK(observations?.current)} / ${formatTokenK(observations?.max)}`;

  container.innerHTML = `
    <div class="om-capsule ${isBuffering ? 'is-buffering' : ''}">
      <span class="om-icon" title="Observational Memory (${scope})">🧠</span>
      <div class="om-pill" title="Tokeny wiadomości w oknie kontekstowym: ${msgFormatted}">
        <span class="om-label">MSG</span>
        <span class="om-mini-track">
          <i class="om-mini-fill ${getLevelClass(msgPercent)}" style="width:${msgPercent}%"></i>
        </span>
        <span class="om-val">${msgPercent}%</span>
      </div>
      <span class="om-sep">·</span>
      <div class="om-pill" title="Tokeny historii obserwacji: ${obsFormatted}">
        <span class="om-label">OBS</span>
        <span class="om-mini-track">
          <i class="om-mini-fill ${getLevelClass(obsPercent)}" style="width:${obsPercent}%"></i>
        </span>
        <span class="om-val">${obsPercent}%</span>
      </div>
    </div>

    <!-- PŁYWAJĄCY POPOVER Z DETALAMI PO NAJECHANIU (HOVER) -->
    <div class="om-hover-popover">
      <div class="om-pop-header">
        <div class="om-pop-title">
          <span>🧠 Observational Memory</span>
        </div>
        <span class="om-pop-badge">scope: ${scope || 'thread'}</span>
      </div>

      <!-- SEKCJA WIADOMOŚCI -->
      <div class="om-pop-row">
        <div class="om-pop-row-head">
          <span class="om-pop-row-title">Wiadomości (Observer)</span>
          <span class="om-pop-row-val">${msgFormatted} (${msgPercent}%)</span>
        </div>
        <div class="om-pop-track">
          <div class="om-pop-fill ${getLevelClass(msgPercent)}" style="width:${msgPercent}%"></div>
        </div>
        <div class="om-pop-sub">
          <span>Próg: ${formatTokenK(messages?.max || 50000)}</span>
          <span>${isBuffering ? '⚡ Buforowanie w toku' : '● Bufor 20% (10k)'}</span>
        </div>
      </div>

      <!-- SEKCJA OBSERWACJI -->
      <div class="om-pop-row">
        <div class="om-pop-row-head">
          <span class="om-pop-row-title">Obserwacje (Reflector)</span>
          <span class="om-pop-row-val">${obsFormatted} (${obsPercent}%)</span>
        </div>
        <div class="om-pop-track">
          <div class="om-pop-fill ${getLevelClass(obsPercent)}" style="width:${obsPercent}%"></div>
        </div>
        <div class="om-pop-sub">
          <span>Próg: ${formatTokenK(observations?.max || 60000)}</span>
          <span>Model: ${model || 'gemini-2.5-flash'}</span>
        </div>
      </div>

      <div class="om-pop-footer">
        <span class="om-pop-meta">Agent: ${agentId || 'metaAgent'}</span>
        <span class="om-pop-hint">Kliknij, aby otworzyć Inspektor [M]</span>
      </div>
    </div>
  `;
}

// 1. POWIADOMIENIA WYSUWANE Z GÓRY
let topNotifTimer;
export function showTopNotification({ agent, title, snippet, targetThreadId = null }) {
  const banner = document.getElementById('top-notification');
  if (!banner) return;

  const targetAgent = typeof agent === 'string' ? AppState.getAgent(agent) : agent;
  banner.style.setProperty('--accent', targetAgent.accent);

  banner.innerHTML = `
    <div class="tn-avatar">${getAgentSvg(targetAgent.iconKey, 1.8)}</div>
    <div class="tn-content">
      <div class="tn-header">
        <span class="tn-agent-name">${targetAgent.full}</span>
        <span class="tn-status-pill">Zadanie ukończone ✓</span>
      </div>
      <div class="tn-snippet">${snippet || title || 'Agent zakończył przetwarzanie zadania w tle.'}</div>
      <div class="tn-hint">Kliknij, aby otworzyć czat ↵</div>
    </div>
    <button class="tn-close" title="Zamknij powiadomienie">✕</button>
  `;

  banner.onclick = (e) => {
    if (e.target.closest('.tn-close')) {
      e.stopPropagation();
      banner.classList.remove('show');
      return;
    }
    banner.classList.remove('show');
    clearTimeout(topNotifTimer);
    
    if (targetThreadId) {
      loadThreadInMain(targetThreadId);
    } else {
      setActiveMainAgent(targetAgent);
    }
    showToast(`Przełączono do czatu: ${targetAgent.full}`);
  };

  banner.classList.add('show');
  clearTimeout(topNotifTimer);
  topNotifTimer = setTimeout(() => {
    banner.classList.remove('show');
  }, 4000);
}

// 2. RENDEROWANIE HISTORII WIADOMOŚCI I WĄTKÓW
export function renderUserMessage(container, text, time = null) {
  const msgEl = document.createElement('div');
  msgEl.className = 'user-msg';
  msgEl.innerHTML = `
    <div class="user-msg-meta">
      <span class="user-badge-tag">TY</span>
      <span>${time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
    <div class="user-msg-bubble">${text}</div>
  `;
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

// Wczytanie i wyrenderowanie pełnego wątku z bazy danych MongoDB
export async function renderThread(container, threadId) {
  if (!container) return;
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--muted);font-size:12px;">Ładowanie historii wątku...</div>`;

  if (!threadId) {
    renderFreshAgentChat(container, AppState.activeAgent);
    return;
  }

  const messages = await AppState.loadThreadMessagesFromBackend(threadId);

  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    const thread = AppState.getThread(threadId);
    const agent = thread ? AppState.getAgent(thread.agent) : AppState.activeAgent;
    renderFreshAgentChat(container, agent);
    return;
  }

  messages.forEach(msg => {
    if (msg.type === 'user') {
      renderUserMessage(container, msg.text, msg.time);
    } else if (msg.type === 'agent_turn') {
      const turn = new AgentTurnController(container, msg.agent, msg.role, msg.time);
      if (msg.thought) {
        turn.addThoughtStep(msg.thought.title || 'Plan i analiza intencji', msg.thought.text);
      }
      if (msg.tools && Array.isArray(msg.tools)) {
        msg.tools.forEach(t => {
          const step = turn.startToolStep(t.name, t.action, t.input);
          step.complete('ok', t.action, t.output, t.duration || 500);
        });
      }
      if (msg.delegations && Array.isArray(msg.delegations)) {
        msg.delegations.forEach(d => {
          turn.addDelegationBlock(
            d.id,
            d.agent,
            d.brief,
            d.mode,
            d.model,
            d.input,
            d.output,
            d.durationMs,
            d.status || 'ok'
          );
        });
      } else if (msg.delegation) {
        turn.addDelegation(msg.delegation.agent, msg.delegation.mode, msg.delegation.model);
      }
      if (msg.intermediate) {
        turn.addIntermediateMessage(msg.intermediate);
      }
      if (msg.gates && Array.isArray(msg.gates)) {
        msg.gates.forEach(g => {
          turn.addGateStep(g.gateType, g.title, g.text, g.badge);
        });
      }
      if (msg.evalReport) {
        turn.addEvaluatorReport('Weryfikacja celu (Goal Scorer)', msg.evalReport);
      }
      if (msg.steps && Array.isArray(msg.steps)) {
        msg.steps.forEach(s => {
          if (s.type === 'evaluator_report') {
            turn.addEvaluatorReport(s.title || 'Weryfikacja celu (Goal Scorer)', s.text);
          }
        });
      }

      const finalHtml = msg.final ? formatMarkdownToHtml(msg.final) : (turn.steps.length > 0 ? '<p>Zadanie zostało pomyślnie przetworzone.</p>' : '');
      turn.finishTurn(finalHtml, { autoCollapse: true });
    }
  });

  container.scrollTop = container.scrollHeight;

  // Odświeżenie wskaźnika Observational Memory dla tego panelu
  const paneType = container.id === 'chat-side' ? 'side' : 'main';
  const currentAgentId = (paneType === 'side' ? AppState.sideAgent?.id : AppState.activeAgent?.id) || 'metaAgent';
  updateMemoryCapsule(paneType, currentAgentId, threadId);
}

// Świeży widok powitalny dla agenta bez wcześniejszej rozmowy
export function renderFreshAgentChat(container, agent, targetInputId = 'composer-input') {
  if (!container) return;
  container.innerHTML = '';

  const targetAgent = AppState.getAgent(agent?.id || agent?.full || agent);
  const freshEl = document.createElement('div');
  freshEl.className = 'fresh-chat-welcome';
  freshEl.innerHTML = `
    <div class="fcw-icon" style="--accent:${targetAgent.accent}">${getAgentSvg(targetAgent.iconKey, 2.0)}</div>
    <div class="fcw-title">${targetAgent.full}</div>
    <div class="fcw-desc">${targetAgent.desc} · Model: <code>${targetAgent.model}</code></div>
    <div class="fcw-chips">
      ${(targetAgent.suggestions || ['Rozpocznij analizę', 'Przeanalizuj dane', 'Zaproponuj rozwiązanie']).map(s => `
        <button class="fcw-chip" data-suggestion="${s}">${s} ↗</button>
      `).join('')}
    </div>
  `;

  freshEl.querySelectorAll('.fcw-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const text = chip.dataset.suggestion;
      const input = document.getElementById(targetInputId);
      if (input) {
        input.value = text;
        input.focus();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      }
    });
  });

  container.appendChild(freshEl);

  // Odświeżenie wskaźnika Observational Memory dla nowego wątku (0%)
  const paneType = targetInputId.includes('side') ? 'side' : 'main';
  updateMemoryCapsule(paneType, targetAgent.id, null);
}

// 3. PIONOWY PASEK IKON AGENTÓW (AGENT RAIL Z SVG) + HOVER CARD
function renderAgentRail() {
  const railEl = document.getElementById('agent-rail');
  const hoverCard = document.getElementById('agent-hover-card');
  if (!railEl || !hoverCard) return;

  const hideHoverCard = () => hoverCard.classList.remove('show');

  railEl.innerHTML = `
    <div class="rail-label">AGENTY</div>
    ${AGENTS.map(a => `
      <div class="rail-icon ${a.id === AppState.activeAgent.id ? 'active' : ''}" 
           data-agent-id="${a.id}" 
           style="--accent:${a.accent}"
           title="${a.full}">
        ${getAgentSvg(a.iconKey)}
        ${a.unread > 0 ? `<span class="rail-unread">${a.unread}</span>` : ''}
      </div>
    `).join('')}
  `;

  railEl.querySelectorAll('.rail-icon').forEach(icon => {
    const agentId = icon.dataset.agentId;
    const agent = AppState.getAgent(agentId);

    // Hover Card — TYLKO dla realnego wskaźnika (mysz/trackpad).
    // Na dotyku `mouseenter` odpalał się przy tapnięciu, a `mouseleave` już nie,
    // więc karta zostawała na stałe i zasłaniała czat (pointer-events:none = nie da się zamknąć).
    // `pointerenter` niesie pointerType, więc odsiewamy 'touch'/'pen' u źródła.
    icon.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || !FINE_POINTER.matches) return;
      const rect = icon.getBoundingClientRect();
      hoverCard.style.top = `${Math.max(10, rect.top - 10)}px`;
      hoverCard.style.setProperty('--accent', agent.accent);
      hoverCard.innerHTML = `
        <div class="hover-card-head">
          <span class="hover-card-name">${agent.full}</span>
          <span class="hover-card-model">${agent.model}</span>
        </div>
        <div class="hover-card-desc">${agent.desc}</div>
        <div class="hover-card-status">
          <span>●</span>
          <span>Status: Gotowy do zadań (${agent.role})</span>
        </div>
      `;
      hoverCard.classList.add('show');
    });

    icon.addEventListener('pointerleave', hideHoverCard);
    icon.addEventListener('pointercancel', hideHoverCard);

    icon.addEventListener('click', () => {
      hideHoverCard();
      const chatTabBtn = document.querySelector('.ntab[data-view="view-chat"]');
      if (chatTabBtn) {
        document.querySelectorAll('.ntab').forEach(t => t.classList.remove('active'));
        chatTabBtn.classList.add('active');
        document.querySelectorAll('.tab-view').forEach(v => {
          v.classList.toggle('active', v.id === 'view-chat');
        });
        AppState.activeTab = 'view-chat';
      }

      syncViewportForTab('view-chat');
      startNewThreadWithAgent(agent);
      showToast(`Czat Główny: Nowy wątek z ${agent.full}`);

      // Ta sama intencja co przy wyborze wątku z listy: agent wybrany, pokaż rozmowę.
      if (NARROW_SCREEN.matches) {
        document.querySelector('.workspace')?.classList.add('sidebar-hidden');
      }
    });
  });
}

// Rozpoczęcie nowego wątku z wybranym agentem w Czacie 1
export function startNewThreadWithAgent(agent) {
  const mainInput = document.getElementById('composer-input');
  const chatMain = document.getElementById('chat-main');

  if (mainInput && AppState.activeAgent) {
    AppState.mainDrafts.set(AppState.activeAgent.id, mainInput.value);
  }

  AppState.activeAgent = agent;
  AppState.activeThreadId = null; // nowy wątek

  const mainSelect = document.getElementById('main-agent-select');
  if (mainSelect) mainSelect.value = agent.id;

  if (mainInput) {
    mainInput.placeholder = `Napisz do ${agent.full}... (Shift+Enter dla nowej linii)`;
    mainInput.value = AppState.mainDrafts.get(agent.id) || '';
    mainInput.style.height = 'auto';
    if (mainInput.value) {
      mainInput.style.height = Math.min(mainInput.scrollHeight, 180) + 'px';
    }
    setTimeout(() => mainInput.focus(), 50);
  }

  if (chatMain) {
    renderFreshAgentChat(chatMain, agent, 'composer-input');
  }

  renderAgentRail();
  renderSidebar();
}

// Zmiana aktywnego agenta w Czacie 1
async function setActiveMainAgent(newAgent) {
  const mainInput = document.getElementById('composer-input');
  const chatMain = document.getElementById('chat-main');

  if (mainInput && AppState.activeAgent) {
    AppState.mainDrafts.set(AppState.activeAgent.id, mainInput.value);
  }

  AppState.activeAgent = newAgent;

  const mainSelect = document.getElementById('main-agent-select');
  if (mainSelect) mainSelect.value = newAgent.id;

  if (mainInput) {
    mainInput.placeholder = `Napisz do ${newAgent.full}... (Shift+Enter dla nowej linii)`;
    mainInput.value = AppState.mainDrafts.get(newAgent.id) || '';
    mainInput.style.height = 'auto';
    if (mainInput.value) {
      mainInput.style.height = Math.min(mainInput.scrollHeight, 180) + 'px';
    }
  }

  const agentThreads = AppState.getThreadsForAgent(newAgent.id);
  if (agentThreads.length > 0) {
    AppState.activeThreadId = agentThreads[0].id;
    await renderThread(chatMain, agentThreads[0].id);
  } else {
    AppState.activeThreadId = null;
    renderFreshAgentChat(chatMain, newAgent, 'composer-input');
  }

  renderAgentRail();
  renderSidebar();
}

// Wczytanie konkretnego wątku w Czacie 1
async function loadThreadInMain(threadId) {
  const thread = AppState.getThread(threadId);
  if (!thread) return;

  const agent = AppState.getAgent(thread.agent);
  AppState.activeThreadId = thread.id;
  AppState.activeAgent = agent;

  const mainSelect = document.getElementById('main-agent-select');
  if (mainSelect) mainSelect.value = agent.id;

  const mainInput = document.getElementById('composer-input');
  if (mainInput) {
    mainInput.placeholder = `Napisz do ${agent.full}... (Shift+Enter dla nowej linii)`;
    mainInput.value = AppState.mainDrafts.get(agent.id) || '';
  }

  const chatMain = document.getElementById('chat-main');
  await renderThread(chatMain, thread.id);
  renderAgentRail();
  renderSidebar();
}

// Zmiana aktywnego agenta w Czacie 2 (Split Screen)
async function setActiveSideAgent(newAgent) {
  const sideInput = document.getElementById('side-composer-input');
  const chatSide = document.getElementById('chat-side');

  if (sideInput && AppState.sideAgent) {
    AppState.sideDrafts.set(AppState.sideAgent.id, sideInput.value);
  }

  AppState.sideAgent = newAgent;

  const sideSelect = document.getElementById('side-agent-select');
  if (sideSelect) sideSelect.value = newAgent.id;

  if (sideInput) {
    sideInput.placeholder = `Napisz do ${newAgent.full}...`;
    sideInput.value = AppState.sideDrafts.get(newAgent.id) || '';
    sideInput.style.height = 'auto';
    if (sideInput.value) {
      sideInput.style.height = Math.min(sideInput.scrollHeight, 180) + 'px';
    }
  }

  const agentThreads = AppState.getThreadsForAgent(newAgent.id);
  if (agentThreads.length > 0) {
    AppState.sideThreadId = agentThreads[0].id;
    await renderThread(chatSide, agentThreads[0].id);
  } else {
    AppState.sideThreadId = null;
    renderFreshAgentChat(chatSide, newAgent, 'side-composer-input');
  }
}

// Kategoryzacja daty wątku (Smart Date Bucketing dla grup czasowych)
export function getThreadDateCategory(dateStrOrObj) {
  if (!dateStrOrObj) return 'Wcześniejsze';
  const d = new Date(dateStrOrObj);
  if (isNaN(d.getTime())) return 'Wcześniejsze';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThreadDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfThreadDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 'Dzisiaj';
  if (diffDays === 1) return 'Wczoraj';
  if (diffDays > 1 && diffDays <= 7) return 'Poprzednie 7 dni';
  if (diffDays > 7 && diffDays <= 30) return 'Ten miesiąc';
  return 'Wcześniejsze';
}

export function formatSmartThreadTime(dateStrOrObj) {
  if (!dateStrOrObj) return '';
  const d = new Date(dateStrOrObj);
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThreadDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfThreadDay.getTime()) / (1000 * 60 * 60 * 24));

  const timeOnly = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays <= 0) return timeOnly;
  if (diffDays === 1) return `Wczoraj, ${timeOnly}`;
  if (diffDays <= 7) {
    const days = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];
    return `${days[d.getDay()]}, ${timeOnly}`;
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

// 4. RENDEROWANIE PANELU BOCZNEGO Z HISTORIĄ WĄTKÓW (Z PODZIAŁEM NA SEKCJE DAT)
let deleteModeActive = false;
const selectedThreadIds = new Set();
let pendingDeleteAction = null;

export function renderSidebar() {
  const threadListEl = document.getElementById('thread-list');
  const sidebarEl = document.querySelector('.sidebar');
  const btnToggleDelete = document.getElementById('btn-toggle-delete-mode');
  const btnDelSelected = document.getElementById('btn-del-selected');

  if (!threadListEl || !sidebarEl) return;

  sidebarEl.classList.toggle('delete-mode', deleteModeActive);
  if (btnToggleDelete) {
    btnToggleDelete.classList.toggle('active', deleteModeActive);
    btnToggleDelete.title = deleteModeActive ? 'Zakończ tryb zaznaczania' : 'Włącz tryb zaznaczania wątków do usunięcia';
  }

  if (btnDelSelected) {
    const count = selectedThreadIds.size;
    btnDelSelected.classList.toggle('show', count > 0);
    btnDelSelected.innerHTML = `🗑 Usuń (${count})`;
  }

  if (AppState.threads.length === 0) {
    threadListEl.innerHTML = `<div style="padding:16px 10px;color:var(--muted);font-size:11px;text-align:center;">Brak wątków w bazie MongoDB</div>`;
    return;
  }

  // Grupowanie wątków w sekcje czasowe
  const dateBuckets = ['Dzisiaj', 'Wczoraj', 'Poprzednie 7 dni', 'Ten miesiąc', 'Wcześniejsze'];
  const grouped = new Map();
  for (const bucket of dateBuckets) grouped.set(bucket, []);

  for (const t of AppState.threads) {
    const bucket = getThreadDateCategory(t.updatedAt || t.createdAt);
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(t);
  }

  let html = '';
  for (const bucket of dateBuckets) {
    const items = grouped.get(bucket) || [];
    if (items.length === 0) continue;

    html += `<div class="thread-section-header">${bucket}</div>`;
    html += items.map(t => {
      const a = AppState.getAgent(t.agent);
      const isSelected = selectedThreadIds.has(t.id);
      const displayTime = formatSmartThreadTime(t.updatedAt || t.createdAt);
      return `
        <div class="thread-nav-item ${t.id === AppState.activeThreadId ? 'active' : ''} ${isSelected ? 'marked-for-delete' : ''}" 
             data-thread-id="${t.id}" 
             data-agent-id="${a.id}">
          <span class="thread-select-box">${isSelected ? '✓' : ''}</span>
          <span class="t-avatar" style="--accent:${a.accent}">${getAgentSvg(a.iconKey, 1.8)}</span>
          <span class="t-name" title="${t.title}">${t.title}</span>
          ${t.unread > 0 && !deleteModeActive ? `<span class="unread-dot" title="${t.unread} nieprzeczytane"></span>` : ''}
          <span class="t-time">${displayTime}</span>
        </div>
      `;
    }).join('');
  }

  threadListEl.innerHTML = html;

  threadListEl.querySelectorAll('.thread-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const threadId = item.dataset.threadId;

      if (deleteModeActive) {
        if (selectedThreadIds.has(threadId)) {
          selectedThreadIds.delete(threadId);
        } else {
          selectedThreadIds.add(threadId);
        }
        renderSidebar();
      } else {
        loadThreadInMain(threadId);
        showToast(`Wczytano wątek: „${item.querySelector('.t-name').textContent}”`);

        // Na wąskim ekranie sidebar zjada większość szerokości, więc po wybraniu
        // wątku chowamy go — inaczej trzeba osobno kliknąć ☰, żeby zobaczyć rozmowę.
        if (NARROW_SCREEN.matches) {
          document.querySelector('.workspace')?.classList.add('sidebar-hidden');
        }
      }
    });
  });
}

function setupSidebarDeleteControls() {
  const btnToggle = document.getElementById('btn-toggle-delete-mode');
  const btnDelAll = document.getElementById('btn-del-all');
  const btnDelSelected = document.getElementById('btn-del-selected');
  const modalConfirm = document.getElementById('modal-confirm-delete');
  const modalMsg = document.getElementById('confirm-delete-msg');
  const btnConfirmYes = document.getElementById('btn-confirm-delete-yes');
  const btnConfirmCancel = document.getElementById('btn-confirm-delete-cancel');

  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      deleteModeActive = !deleteModeActive;
      selectedThreadIds.clear();
      renderSidebar();
    });
  }

  if (btnDelSelected) {
    btnDelSelected.addEventListener('click', () => {
      if (selectedThreadIds.size === 0) return;
      pendingDeleteAction = 'selected';
      if (modalMsg) modalMsg.textContent = `Czy na pewno chcesz bezpowrotnie usunąć ${selectedThreadIds.size} zaznaczonych wątków z bazy MongoDB?`;
      modalConfirm?.classList.add('open');
    });
  }

  if (btnDelAll) {
    btnDelAll.addEventListener('click', () => {
      pendingDeleteAction = 'all';
      if (modalMsg) modalMsg.textContent = `Czy na pewno chcesz usunąć WSZYSTKIE (${AppState.threads.length}) wątki czatów z bazy danych?`;
      modalConfirm?.classList.add('open');
    });
  }

  if (btnConfirmYes) {
    btnConfirmYes.addEventListener('click', async () => {
      if (pendingDeleteAction === 'selected') {
        const ids = Array.from(selectedThreadIds);
        await AppState.batchDeleteThreads(ids);
        selectedThreadIds.clear();
        deleteModeActive = false;
        showToast(`Usunięto ${ids.length} wątków z MongoDB`);
      } else if (pendingDeleteAction === 'all') {
        const allIds = AppState.threads.map(t => t.id);
        await AppState.batchDeleteThreads(allIds);
        deleteModeActive = false;
        showToast('Usunięto wszystkie wątki');
      }
      modalConfirm?.classList.remove('open');
      renderSidebar();
      if (!AppState.activeThreadId) {
        renderFreshAgentChat(document.getElementById('chat-main'), AppState.activeAgent);
      }
    });
  }

  if (btnConfirmCancel) {
    btnConfirmCancel.addEventListener('click', () => {
      modalConfirm?.classList.remove('open');
      pendingDeleteAction = null;
    });
  }
}

// 5. OBSŁUGA SZUFLAD (DRAWERS)
function setupDrawers() {
  const drawerOverlay = document.getElementById('drawer-overlay');

  function toggleDrawer(drawerId) {
    const allDrawers = document.querySelectorAll('.drawer');
    if (AppState.activeDrawer === drawerId || !drawerId) {
      allDrawers.forEach(d => d.classList.remove('open'));
      drawerOverlay?.classList.remove('show');
      AppState.activeDrawer = null;
      return;
    }

    allDrawers.forEach(d => {
      d.classList.toggle('open', d.id === `drawer-${drawerId}`);
    });
    drawerOverlay?.classList.add('show');
    AppState.activeDrawer = drawerId;

    if (drawerId === 'mem') buildMemoryInspector(document.getElementById('mem-body'));
    else if (drawerId === 'term') buildLedgerInspector(document.getElementById('term-body'));
    else if (drawerId === 'art') buildArtifactsInspector(document.getElementById('art-body'));
  }

  // Globalny handler otwierania szuflady pamięci (dla przycisków w popoverze OM)
  window.__splotOpenMemoryDrawer = function() {
    toggleDrawer('mem');
  };

  // Bezpośrednie kliknięcie kapsuły nagłówka lub przycisku w popoverze otwiera szufladę pamięci
  document.addEventListener('click', (e) => {
    if (e.target.closest('.om-capsule') || e.target.closest('.om-pop-action-btn')) {
      toggleDrawer('mem');
    }
  });

  if (drawerOverlay) {
    drawerOverlay.addEventListener('click', () => toggleDrawer(null));
  }

  document.querySelectorAll('[data-drawer]').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleDrawer(btn.dataset.drawer);
    });
  });

  document.querySelectorAll('.drawer .btn-close').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleDrawer(null);
    });
  });
}

// ── STOP BUTTON: Przełączanie UI przycisku Wyślij ↔ Stop ──
function setSendButtonStop(btnEl, isStop) {
  if (!btnEl) return;
  if (isStop) {
    btnEl.innerHTML = '<span class="stop-icon"></span>Stop';
    btnEl.classList.add('is-stop');
    btnEl.title = 'Zatrzymaj agenta';
  } else {
    btnEl.innerHTML = 'Wyślij ↵';
    btnEl.classList.remove('is-stop');
    btnEl.title = '';
  }
}

function stopActiveGeneration(paneType) {
  const active = window.__splotActiveStream[paneType];
  if (!active) return false;

  try {
    // Zamknij strumień SSE
    active.reader.cancel();
  } catch (e) {
    console.warn('[Splot] reader.cancel() error:', e);
  }

  // Zakończ turę z komunikatem przerwania
  if (active.turn && !active.turn.isFinished) {
    active.turn.finishTurn(
      '<p style="color:var(--warning);font-style:italic;">⏹ Proces został przerwany przez użytkownika.</p>',
      { autoCollapse: true }
    );
  }

  // Wyczyść rejestr
  window.__splotActiveStream[paneType] = null;

  // Przywróć przycisk Wyślij
  const btnId = paneType === 'main' ? 'btn-send' : 'btn-side-send';
  setSendButtonStop(document.getElementById(btnId), false);

  // Ukryj typing bar
  if (paneType === 'main') {
    document.getElementById('typing-bar')?.classList.remove('show');
  }

  showToast('Agent zatrzymany');
  return true;
}

// 6. OBSŁUGA CZATU GŁÓWNEGO (CZAT 1)
function setupMainChat() {
  const mainSelect = document.getElementById('main-agent-select');
  const btnMainHistory = document.getElementById('btn-main-history');
  const mainHistoryPopover = document.getElementById('main-history-popover');
  const mainPopList = document.getElementById('main-pop-list');
  const textarea = document.getElementById('composer-input');
  const btnSend = document.getElementById('btn-send');
  const btnAttach = document.getElementById('btn-attach');
  const fileInput = document.getElementById('file-input');
  const attachRow = document.getElementById('attach-row');
  const composerBox = textarea?.closest('.composer');
  const dropOverlay = composerBox?.querySelector('.drop-overlay');
  const chatContainer = document.getElementById('chat-main');
  const typingBar = document.getElementById('typing-bar');

  if (mainSelect) {
    mainSelect.innerHTML = AGENTS.map(a => `
      <option value="${a.id}" ${a.id === AppState.activeAgent.id ? 'selected' : ''}>
        ${a.full} (${a.role})
      </option>
    `).join('');

    mainSelect.addEventListener('change', async (e) => {
      const agent = AppState.getAgent(e.target.value);
      await setActiveMainAgent(agent);
      showToast(`Czat 1: połączono z ${agent.full}`);
    });
  }

  function renderMainHistoryPopover() {
    if (!mainPopList) return;
    const threads = AppState.getThreadsForAgent(AppState.activeAgent.id);
    if (threads.length === 0) {
      mainPopList.innerHTML = `<div style="padding:10px;color:var(--muted);font-size:11px;text-align:center;">Brak wcześniejszych wątków z tym agentem</div>`;
      return;
    }

    const dateBuckets = ['Dzisiaj', 'Wczoraj', 'Poprzednie 7 dni', 'Ten miesiąc', 'Wcześniejsze'];
    const grouped = new Map();
    for (const bucket of dateBuckets) grouped.set(bucket, []);

    for (const t of threads) {
      const bucket = getThreadDateCategory(t.updatedAt || t.createdAt);
      if (!grouped.has(bucket)) grouped.set(bucket, []);
      grouped.get(bucket).push(t);
    }

    let html = '';
    for (const bucket of dateBuckets) {
      const items = grouped.get(bucket) || [];
      if (items.length === 0) continue;

      html += `<div class="popover-section-header">${bucket}</div>`;
      html += items.map(t => {
        const displayTime = formatSmartThreadTime(t.updatedAt || t.createdAt);
        return `
          <div class="agent-history-item ${t.id === AppState.activeThreadId ? 'active' : ''}" data-thread-id="${t.id}">
            <span class="ah-title" title="${t.title}">${t.title}</span>
            <div class="ah-meta">
              <span class="ah-time">${displayTime}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    mainPopList.innerHTML = html;

    mainPopList.querySelectorAll('.agent-history-item').forEach(item => {
      item.addEventListener('click', () => {
        loadThreadInMain(item.dataset.threadId);
        mainHistoryPopover.classList.remove('open');
        showToast(`Czat 1: wczytano „${item.querySelector('.ah-title').textContent}”`);
      });
    });
  }

  if (btnMainHistory && mainHistoryPopover) {
    btnMainHistory.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('side-history-popover')?.classList.remove('open');
      renderMainHistoryPopover();
      mainHistoryPopover.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!mainHistoryPopover.contains(e.target) && e.target !== btnMainHistory) {
        mainHistoryPopover.classList.remove('open');
      }
    });
  }

  function autoResize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    if (AppState.activeAgent) {
      AppState.mainDrafts.set(AppState.activeAgent.id, textarea.value);
    }
  }

  textarea?.addEventListener('input', autoResize);

  async function handleSend() {
    // Jeśli aktywna tura — kliknięcie przycisku = stop
    if (window.__splotActiveStream.main) {
      stopActiveGeneration('main');
      return;
    }

    const text = textarea.value.trim();
    if (!text) return;

    let currentThreadId = AppState.activeThreadId;
    if (!currentThreadId) {
      currentThreadId = `thread_${Date.now()}`;
      AppState.activeThreadId = currentThreadId;
      AppState.createLocalThreadForAgent(AppState.activeAgent.id, text);
    }

    if (chatContainer.querySelector('.fresh-chat-welcome')) {
      chatContainer.innerHTML = '';
    }

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderUserMessage(chatContainer, text, timeStr);

    textarea.value = '';
    if (attachRow) attachRow.innerHTML = '';
    autoResize();

    if (AppState.activeAgent) {
      AppState.mainDrafts.delete(AppState.activeAgent.id);
    }

    // Przełącz przycisk na Stop
    setSendButtonStop(btnSend, true);
    typingBar?.classList.add('show');
    chatContainer.scrollTop = chatContainer.scrollHeight;

    await executeRealAgentTurn(chatContainer, text, AppState.activeAgent, currentThreadId, 'main');
    typingBar?.classList.remove('show');
    setSendButtonStop(btnSend, false);
  }

  btnSend?.addEventListener('click', handleSend);
  textarea?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  if (btnAttach && fileInput) {
    btnAttach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      Array.from(fileInput.files).forEach(f => addFileChip(attachRow, f.name, humanFileSize(f.size)));
      showToast(`Dołączono ${fileInput.files.length} plik(ów)`);
      fileInput.value = '';
    });
  }

  const btnVoiceMain = document.getElementById('btn-voice-main');
  if (btnVoiceMain && textarea) {
    new VoiceInputController({
      triggerBtn: btnVoiceMain,
      textarea,
      composerBox: textarea.closest('.composer'),
      onToast: showToast,
      onResize: autoResize,
    });
  }
}

// 7. OBSŁUGA CZATU 2 (SPLIT SCREEN)
function setupSideChat() {
  const sideSelect = document.getElementById('side-agent-select');
  const btnSideHistory = document.getElementById('btn-side-history');
  const sideHistoryPopover = document.getElementById('side-history-popover');
  const sidePopList = document.getElementById('side-pop-list');
  const sideInput = document.getElementById('side-composer-input');
  const sideSend = document.getElementById('btn-side-send');
  const sideContainer = document.getElementById('chat-side');
  const btnCloseSide = document.getElementById('btn-close-side');

  if (sideSelect) {
    sideSelect.innerHTML = AGENTS.map(a => `
      <option value="${a.id}" ${a.id === AppState.sideAgent.id ? 'selected' : ''}>
        ${a.full} (${a.role})
      </option>
    `).join('');

    sideSelect.addEventListener('change', async (e) => {
      const agent = AppState.getAgent(e.target.value);
      await setActiveSideAgent(agent);
      showToast(`Czat 2: połączono z ${AppState.sideAgent.full}`);
    });
  }

  function renderSideHistoryPopover() {
    if (!sidePopList) return;
    const threads = AppState.getThreadsForAgent(AppState.sideAgent.id);
    if (threads.length === 0) {
      sidePopList.innerHTML = `<div style="padding:10px;color:var(--muted);font-size:11px;text-align:center;">Brak wcześniejszych wątków z tym agentem</div>`;
      return;
    }

    const dateBuckets = ['Dzisiaj', 'Wczoraj', 'Poprzednie 7 dni', 'Ten miesiąc', 'Wcześniejsze'];
    const grouped = new Map();
    for (const bucket of dateBuckets) grouped.set(bucket, []);

    for (const t of threads) {
      const bucket = getThreadDateCategory(t.updatedAt || t.createdAt);
      if (!grouped.has(bucket)) grouped.set(bucket, []);
      grouped.get(bucket).push(t);
    }

    let html = '';
    for (const bucket of dateBuckets) {
      const items = grouped.get(bucket) || [];
      if (items.length === 0) continue;

      html += `<div class="popover-section-header">${bucket}</div>`;
      html += items.map(t => {
        const displayTime = formatSmartThreadTime(t.updatedAt || t.createdAt);
        return `
          <div class="agent-history-item ${t.id === AppState.sideThreadId ? 'active' : ''}" data-thread-id="${t.id}">
            <span class="ah-title" title="${t.title}">${t.title}</span>
            <div class="ah-meta">
              <span class="ah-time">${displayTime}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    sidePopList.innerHTML = html;

    sidePopList.querySelectorAll('.agent-history-item').forEach(item => {
      item.addEventListener('click', async () => {
        AppState.sideThreadId = item.dataset.threadId;
        await renderThread(sideContainer, item.dataset.threadId);
        sideHistoryPopover.classList.remove('open');
        showToast(`Czat 2: wczytano „${item.querySelector('.ah-title').textContent}”`);
      });
    });
  }

  if (btnSideHistory && sideHistoryPopover) {
    btnSideHistory.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('main-history-popover')?.classList.remove('open');
      renderSideHistoryPopover();
      sideHistoryPopover.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!sideHistoryPopover.contains(e.target) && e.target !== btnSideHistory) {
        sideHistoryPopover.classList.remove('open');
      }
    });
  }

  async function handleSideSend() {
    // Jeśli aktywna tura — kliknięcie przycisku = stop
    if (window.__splotActiveStream.side) {
      stopActiveGeneration('side');
      return;
    }

    const text = sideInput.value.trim();
    if (!text) return;

    let currentThreadId = AppState.sideThreadId;
    if (!currentThreadId) {
      currentThreadId = `thread_${Date.now()}`;
      AppState.sideThreadId = currentThreadId;
      AppState.createLocalThreadForAgent(AppState.sideAgent.id, text);
    }

    if (sideContainer.querySelector('.fresh-chat-welcome')) {
      sideContainer.innerHTML = '';
    }

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderUserMessage(sideContainer, text, timeStr);

    sideInput.value = '';
    if (AppState.sideAgent) {
      AppState.sideDrafts.delete(AppState.sideAgent.id);
    }

    // Przełącz przycisk na Stop
    setSendButtonStop(sideSend, true);

    await executeRealAgentTurn(sideContainer, text, AppState.sideAgent, currentThreadId, 'side');
    setSendButtonStop(sideSend, false);
  }

  sideSend?.addEventListener('click', handleSideSend);
  sideInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSideSend();
    }
  });

  if (btnCloseSide) {
    btnCloseSide.addEventListener('click', () => {
      document.querySelector('.workspace')?.classList.remove('split-active');
      document.getElementById('btn-split')?.classList.remove('active');
      AppState.splitActive = false;
      showToast('Zamknięto Czat 2');
    });
  }

  const btnVoiceSide = document.getElementById('btn-voice-side');
  if (btnVoiceSide && sideInput) {
    new VoiceInputController({
      triggerBtn: btnVoiceSide,
      textarea: sideInput,
      composerBox: sideInput.closest('.composer'),
      onToast: showToast,
      onResize: () => {
        sideInput.style.height = 'auto';
        sideInput.style.height = Math.min(sideInput.scrollHeight, 180) + 'px';
      },
    });
  }
}

// 7b. OBSŁUGA ROZSZERZONEGO EDYTORA WIADOMOŚCI (MODAL COMPOSER + GŁOS)
function setupModalComposer() {
  const modal = document.getElementById('modal-composer');
  const btnClose = document.getElementById('btn-modal-close');
  const btnCancel = document.getElementById('btn-modal-cancel');
  const btnSend = document.getElementById('btn-modal-send');
  const modalTextarea = document.getElementById('modal-textarea');
  const targetAgentBadge = document.getElementById('modal-target-agent');
  const btnVoiceModal = document.getElementById('btn-voice-modal');
  const btnExpandMain = document.getElementById('btn-expand-composer');
  const btnExpandSide = document.getElementById('btn-expand-side-composer');
  const mainInput = document.getElementById('composer-input');
  const sideInput = document.getElementById('side-composer-input');

  let activeSource = 'main';

  if (btnVoiceModal && modalTextarea) {
    new VoiceInputController({
      triggerBtn: btnVoiceModal,
      textarea: modalTextarea,
      composerBox: modal?.querySelector('.modal-dialog') || modal,
      onToast: showToast,
      onResize: () => {},
    });
  }

  function openModal(source) {
    activeSource = source;
    const agent = source === 'main' ? AppState.activeAgent : AppState.sideAgent;
    if (targetAgentBadge) targetAgentBadge.textContent = agent?.full || 'Agent';
    const sourceInput = source === 'main' ? mainInput : sideInput;
    if (modalTextarea && sourceInput) {
      modalTextarea.value = sourceInput.value;
    }
    modal?.classList.add('open');
    modalTextarea?.focus();
  }

  function closeModal() {
    modal?.classList.remove('open');
  }

  btnExpandMain?.addEventListener('click', () => openModal('main'));
  btnExpandSide?.addEventListener('click', () => openModal('side'));
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  btnSend?.addEventListener('click', () => {
    const text = modalTextarea?.value || '';
    const sourceInput = activeSource === 'main' ? mainInput : sideInput;
    if (sourceInput) {
      sourceInput.value = text;
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    closeModal();
    if (activeSource === 'main') {
      document.getElementById('btn-send')?.click();
    } else {
      document.getElementById('btn-side-send')?.click();
    }
  });
}

// 8. REALNE WYWOŁANIE AGENTA I ZASILENIE AKORDEONU PROCESU (STREAMING SSE + LIVE DISPATCH)
async function executeRealAgentTurn(container, userPrompt, targetAgent, threadId, paneType = 'main') {
  const agent = targetAgent || AppState.activeAgent;
  const turn = new AgentTurnController(container, agent.full, agent.role);

  try {
    const response = await fetch('/splot/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        agentId: agent.id,
        threadId,
        message: userPrompt,
        resourceId: agent.id,
      }),
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => ({}));
      throw new Error(errorJson.error || `HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // Jeśli serwer odesłał strumień SSE (Server-Sent Events)
    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      window.__splotActiveStream[paneType] = { reader, turn, paneType };
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let finishReceived = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || ''; // Ostatni niekompletny fragment zostaje w buforze

          for (const block of parts) {
            if (!block.trim()) continue;

            let eventName = 'message';
            let dataStr = '';

            const lines = block.split('\n');
            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.substring(6).trim();
              } else if (line.startsWith('data:')) {
                dataStr += line.substring(5).trim();
              }
            }

            if (!dataStr) continue;

            let data = {};
            try {
              data = JSON.parse(dataStr);
            } catch {
              data = { text: dataStr };
            }

            // Reaktywny dispatch zdarzeń do tury agenta w locie
            if (eventName === 'init') {
              if (data.threadId && !AppState.activeThreadId) {
                AppState.activeThreadId = data.threadId;
              }
            } else if (eventName === 'thought') {
              turn.addThoughtStep(data.title || 'Plan i analiza intencji', data.text || '');
            } else if (eventName === 'delegation') {
              turn.addDelegationBlock(data.delegationId, data.targetAgent, data.brief, data.mode, data.model, data.input, '', 1200, 'running');
            } else if (eventName === 'subagent_step') {
              turn.addSubagentStep(data.delegationId, data);
            } else if (eventName === 'subagent_done') {
              turn.completeDelegation(data.delegationId, data);
            } else if (eventName === 'tool_start') {
              turn.startToolStepWithId(data.stepId, data.toolName, data.actionLabel, data.inputArgs);
            } else if (eventName === 'tool_end') {
              turn.updateToolStep(data.stepId, data);
            } else if (eventName === 'step_note') {
              turn.addIntermediateMessage(data.text);
            } else if (eventName === 'step_eval') {
              turn.addEvaluatorReport(data.title || 'Weryfikacja celu (Goal Scorer)', data.text || '');
            } else if (eventName === 'chunk') {
              turn.appendDelta(data.delta || data.text);
            } else if (eventName === 'finish') {
              finishReceived = true;
              if (data.thought && !turn.steps.some(s => s.type === 'thought')) {
                turn.addThoughtStep('Plan i analiza intencji', typeof data.thought === 'string' ? data.thought : JSON.stringify(data.thought, null, 2));
              }
              const rawText = data.text || 'Zadanie zostało pomyślnie przetworzone.';
              const finalHtml = formatMarkdownToHtml(rawText);
              turn.finishTurn(finalHtml, { autoCollapse: true });
            } else if (eventName === 'error') {
              throw new Error(data.error || 'Wystąpił błąd podczas wykonywania agenta');
            }
          }
        }

        if (!finishReceived && !turn.isFinished) {
          turn.finishTurn(formatMarkdownToHtml(turn.accumulatedText || 'Proces został zakończony.'), { autoCollapse: true });
        }
      } catch (streamErr) {
        // Jeśli strumień został celowo anulowany przez użytkownika, ignorujemy błąd czytania
        if (turn.isFinished || String(streamErr).includes('cancel') || String(streamErr).includes('abort')) {
          console.log('[Splot] Strumień został przerwany przez użytkownika.');
        } else {
          throw streamErr;
        }
      }

    } else {
      // Fallback: Klasyczna odpowiedź JSON (kompatybilność)
      const data = await response.json();

      if (data.thought) {
        turn.addThoughtStep('Plan i analiza intencji', typeof data.thought === 'string' ? data.thought : JSON.stringify(data.thought, null, 2));
      }

      if (Array.isArray(data.steps) && data.steps.length > 0) {
        data.steps.forEach(step => {
          if (step.type === 'thought') {
            turn.addThoughtStep(step.title || 'Plan', step.text || '');
          } else if (step.type === 'tool') {
            const st = turn.startToolStep(step.toolName, step.actionLabel, step.inputArgs);
            st.complete(step.status || 'ok', step.actionLabel, step.resultData, step.durationMs || 500);
          } else if (step.type === 'evaluator_report') {
            turn.addEvaluatorReport(step.title || 'Weryfikacja celu (Goal Scorer)', step.text);
          } else if (step.type === 'intermediate_note') {
            turn.addIntermediateMessage(step.text);
          } else if (step.type === 'delegation') {
            turn.addDelegationBlock(null, step.toAgentName || step.targetAgent, '', step.mode, step.model);
          }
        });
      }

      const rawText = data.text || 'Zadanie zostało pomyślnie przetworzone.';
      const finalHtml = formatMarkdownToHtml(rawText);
      turn.finishTurn(finalHtml, { autoCollapse: true });
    }

    // Odświeżenie wskaźnika Observational Memory po zakończonej turze
    await updateMemoryCapsule(paneType, targetAgent.id, threadId);

    // Odświeżenie listy wątków w panelu bocznym
    await AppState.loadThreadsFromBackend();
    renderSidebar();

  } catch (err) {
    if (!turn.isFinished) {
      turn.addError(agent.full, err.message, 1, () => {
        executeRealAgentTurn(container, userPrompt, targetAgent, threadId, paneType);
      });
      turn.finishTurn(`<p style="color:var(--error);">Wystąpił błąd podczas komunikacji z agentem <strong>${agent.full}</strong>: ${err.message}</p>`, { autoCollapse: false });
    }
  } finally {
    window.__splotActiveStream[paneType] = null;
    const btnId = paneType === 'main' ? 'btn-send' : 'btn-side-send';
    setSendButtonStop(document.getElementById(btnId), false);
    if (paneType === 'main') {
      document.getElementById('typing-bar')?.classList.remove('show');
    }
  }
}

// 9. PRZEŁĄCZANIE ZAKŁADEK GŁÓWNYCH
function setupTabs() {
  const tabs = document.querySelectorAll('.ntab');
  const allViews = document.querySelectorAll('.tab-view');

  tabs.forEach((tab) => {
    tab.addEventListener('click', async () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetViewId = tab.dataset.view || 'view-chat';
      AppState.activeTab = targetViewId;
      syncViewportForTab(targetViewId);

      allViews.forEach(view => {
        view.classList.toggle('active', view.id === targetViewId);
      });

      const label = tab.querySelector('.ntab-label')?.textContent || tab.textContent;
      showToast(`Widok: ${label}`);

      if (targetViewId === 'tab-jarvis') {
        setTimeout(() => {
          if (typeof window.fitJarvisView === 'function') window.fitJarvisView();
          if (typeof window.fetchJarvisTopology === 'function') window.fetchJarvisTopology();
        }, 60);
      } else if (targetViewId === 'view-orchestration') {
        await refreshOrchestrationTab();
      } else if (targetViewId === 'view-evals') {
        await refreshEvaluationsTab();
      }
    });
  });
}

// Dynamiczne zasilanie zakładki Orkiestracja
async function refreshOrchestrationTab() {
  try {
    const res = await fetch('/splot/api/orchestration/overview');
    if (!res.ok) return;
    const json = await res.json();
    const { kpis, lanes } = json.data || {};

    const view = document.getElementById('view-orchestration');
    if (!view || !kpis) return;

    const cards = view.querySelectorAll('.tab-view > div:first-of-type > div');
    if (cards.length >= 4) {
      cards[0].querySelector('div:nth-child(2)').textContent = kpis.activeLanes;
      cards[1].querySelector('div:nth-child(2)').textContent = kpis.durableJobs;
      cards[2].querySelector('div:nth-child(2)').textContent = kpis.cronTasks;
      cards[3].querySelector('div:nth-child(2)').textContent = kpis.memoryLeases;
    }
  } catch (e) {
    console.warn('[OrchestrationTab] Refresh error:', e);
  }
}

// Dynamiczne zasilanie zakładki Ewaluacje
async function refreshEvaluationsTab() {
  try {
    const res = await fetch('/splot/api/evaluations/summary');
    if (!res.ok) return;
    const json = await res.json();
    const rows = json.data?.rows || [];

    const view = document.getElementById('view-evals');
    const tbody = view?.querySelector('table tbody');
    if (!tbody || rows.length === 0) return;

    tbody.innerHTML = rows.map(r => `
      <tr style="border-bottom:1px solid var(--line);">
        <td style="padding:8px 6px;color:var(--signal);font-weight:600;">${r.agent}</td>
        <td style="padding:8px 6px;">${r.model}</td>
        <td style="padding:8px 6px;">${r.accuracy}</td>
        <td style="padding:8px 6px;color:var(--success);">${r.hallucination}</td>
        <td style="padding:8px 6px;">${r.latency}</td>
        <td style="padding:8px 6px;">${r.cost}</td>
        <td style="padding:8px 6px;color:var(--success);">${r.status}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.warn('[EvaluationsTab] Refresh error:', e);
  }
}

// 10. INICJALIZACJA APLIKACJI
async function initSplotApp() {
  // Pobranie aktualnych modeli agentów z manifestu backendu w czasie rzeczywistym
  try {
    const res = await fetch('/splot/api/agents');
    if (res.ok) {
      const json = await res.json();
      if (json.data && Array.isArray(json.data)) {
        for (const meta of json.data) {
          const found = AGENTS.find(a => a.id === meta.id);
          if (found && meta.primaryModel) {
            found.model = meta.primaryModel;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[initSplotApp] Could not fetch live agent models:', e);
  }

  renderAgentRail();
  setupSidebarDeleteControls();
  setupDrawers();
  setupMainChat();
  setupSideChat();
  setupModalComposer();
  setupTabs();

  // Pobranie realnych wątków z bazy MongoDB
  await AppState.loadThreadsFromBackend();
  renderSidebar();

  const chatMain = document.getElementById('chat-main');
  if (AppState.threads.length > 0) {
    AppState.activeThreadId = AppState.threads[0].id;
    AppState.activeAgent = AppState.getAgent(AppState.threads[0].agent);
    await renderThread(chatMain, AppState.threads[0].id);
  } else {
    renderFreshAgentChat(chatMain, AppState.activeAgent);
  }

  // Przełącznik Hamburgera
  const btnRevealSidebar = document.getElementById('btn-reveal-sidebar');
  const workspace = document.querySelector('.workspace');
  if (btnRevealSidebar && workspace) {
    btnRevealSidebar.addEventListener('click', () => {
      workspace.classList.toggle('sidebar-hidden');
      const isHidden = workspace.classList.contains('sidebar-hidden');
      showToast(isHidden ? 'Panel wątków ukryty' : 'Panel wątków widoczny');
    });
  }

  // Przełącznik Split View
  const btnSplit = document.getElementById('btn-split');
  if (btnSplit && workspace) {
    btnSplit.addEventListener('click', () => {
      workspace.classList.toggle('split-active');
      btnSplit.classList.toggle('active');
      AppState.splitActive = workspace.classList.contains('split-active');
      if (AppState.splitActive && !AppState.sideThreadId) {
        renderFreshAgentChat(document.getElementById('chat-side'), AppState.sideAgent, 'side-composer-input');
      }
      showToast(AppState.splitActive ? 'Widok dzielony aktywny (Czat 1 + Czat 2)' : 'Widok pojedynczy');
    });
  }

  setupAlexVoiceCapsule();

  // Skróty klawiszowe (S, T, A, M, H, Ctrl+Space)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      if (!isAlexListening && !isAlexContinuous) {
        const ptt = document.getElementById('alex-ptt');
        if (ptt) ptt.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
        startAlexListening();
      }
      return;
    }

    if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === 's') { if (btnSplit) btnSplit.click(); }
    else if (key === 't') { document.querySelector('[data-drawer="term"]')?.click(); }
    else if (key === 'a') { document.querySelector('[data-drawer="art"]')?.click(); }
    else if (key === 'm') { document.querySelector('[data-drawer="mem"]')?.click(); }
    else if (key === 'h') { if (btnRevealSidebar) btnRevealSidebar.click(); }
  });

  document.addEventListener('keyup', (e) => {
    if ((e.code === 'Space' || e.key === 'Control') && isAlexListening && !isAlexContinuous) {
      const ptt = document.getElementById('alex-ptt');
      if (ptt) ptt.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
      stopAlexListening();
    }
  });
}

// readyState-safe: działa zarówno przy pierwszym załadowaniu jak i przy refresh/bfcache
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSplotApp, { once: true });
} else {
  initSplotApp();
}

// ── KONTROLER ALEX DYNAMIC VOICE CAPSULE ──────────────────────────────────
let isAlexListening = false;
let isAlexContinuous = false;

export function setupAlexVoiceCapsule() {
  const capsule = document.getElementById('alex-capsule');
  const menuBtn = document.getElementById('btn-alex-menu');
  const popover = document.getElementById('alex-menu-popover');
  const optPtt = document.getElementById('opt-alex-ptt');
  const optContinuous = document.getElementById('opt-alex-continuous');
  const optTranscript = document.getElementById('opt-alex-transcript');
  const modalTranscript = document.getElementById('modal-alex-transcript');
  const btnCloseModal = document.getElementById('btn-alex-modal-close');
  const btnCloseTranscript = document.getElementById('btn-alex-close-transcript');
  const btnCopyTranscript = document.getElementById('btn-alex-copy-transcript');

  if (!capsule) return;

  const getAlexElements = () => ({
    ptt: document.getElementById('alex-ptt'),
    always: document.getElementById('alex-always'),
    statusText: document.getElementById('alex-status-text'),
    liveRoot: document.querySelector('.alex-live'),
    transcript: document.getElementById('alex-transcript'),
  });

  const syncWithAlexEngine = () => {
    const { statusText, liveRoot } = getAlexElements();
    if (!liveRoot || !statusText) return;

    const state = liveRoot.dataset.state || 'idle';
    const text = statusText.textContent || '';
    const brand = capsule.querySelector('.vc-brand');
    const label = capsule.querySelector('.vc-status-label');
    const wave = capsule.querySelector('.vc-waveform');

    capsule.classList.remove('is-listening', 'is-speaking', 'is-working', 'is-connecting', 'is-ready', 'is-error');

    if (state === 'listening') {
      capsule.classList.add('is-listening');
      if (brand) brand.style.display = 'none';
      if (label) { label.textContent = text || 'Alex słucha...'; label.style.display = 'inline-block'; }
      if (wave) wave.style.display = 'inline-flex';
    } else if (state === 'speaking') {
      capsule.classList.add('is-speaking');
      if (brand) brand.style.display = 'none';
      if (label) { label.textContent = text || 'Alex mówi...'; label.style.display = 'inline-block'; }
      if (wave) wave.style.display = 'inline-flex';
    } else if (state === 'working' || state === 'connecting') {
      capsule.classList.add('is-working');
      if (brand) brand.style.display = 'none';
      if (label) { label.textContent = text || 'Łączenie...'; label.style.display = 'inline-block'; }
      if (wave) wave.style.display = 'inline-flex';
    } else if (state === 'ready') {
      capsule.classList.add('is-ready');
      if (brand) brand.style.display = isAlexContinuous ? 'none' : 'inline-block';
      if (label) { label.textContent = isAlexContinuous ? 'Alex Live (Gotowy)' : 'Alex'; label.style.display = isAlexContinuous ? 'inline-block' : 'none'; }
      if (wave) wave.style.display = 'none';
    } else if (state === 'error') {
      capsule.classList.add('is-error');
      if (brand) brand.style.display = 'none';
      if (label) { label.textContent = text || 'Błąd połączenia'; label.style.display = 'inline-block'; }
      if (wave) wave.style.display = 'none';
    } else {
      if (!isAlexContinuous) {
        if (brand) brand.style.display = 'inline-block';
        if (label) label.style.display = 'none';
        if (wave) wave.style.display = 'none';
      }
    }
  };

  setInterval(syncWithAlexEngine, 200);

  let isMouseDownOnCapsule = false;

  const handleMouseDown = (e) => {
    if (e.target.closest('#btn-alex-menu') || e.target.closest('#alex-menu-popover')) return;
    const { ptt, always } = getAlexElements();
    if (always && always.checked) return;
    isMouseDownOnCapsule = true;
    if (ptt) {
      ptt.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
    }
    startAlexListening();
  };

  const handleMouseUp = () => {
    if (isMouseDownOnCapsule) {
      isMouseDownOnCapsule = false;
      const { ptt } = getAlexElements();
      if (ptt) {
        ptt.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
      }
      stopAlexListening();
    }
  };

  capsule.addEventListener('mousedown', handleMouseDown);
  window.addEventListener('mouseup', handleMouseUp);

  capsule.addEventListener('dblclick', (e) => {
    if (e.target.closest('#btn-alex-menu') || e.target.closest('#alex-menu-popover')) return;
    toggleContinuousMode();
  });

  if (menuBtn && popover) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== menuBtn) {
        popover.classList.remove('show');
      }
    });
  }

  if (optPtt) {
    optPtt.addEventListener('click', () => {
      popover.classList.remove('show');
      showToast('Push-to-Talk: Przytrzymaj Ctrl+Spacja lub kliknij i trzymaj kapsułę.');
    });
  }

  if (optContinuous) {
    optContinuous.addEventListener('click', () => {
      popover.classList.remove('show');
      toggleContinuousMode();
    });
  }

  if (optTranscript && modalTranscript) {
    optTranscript.addEventListener('click', () => {
      popover.classList.remove('show');
      const { transcript } = getAlexElements();
      const feed = modalTranscript.querySelector('.alex-transcript-feed');
      if (transcript && feed) {
        feed.innerHTML = transcript.innerHTML;
      }
      modalTranscript.classList.add('show');
    });
  }

  if (btnCloseModal) btnCloseModal.addEventListener('click', () => modalTranscript.classList.remove('show'));
  if (btnCloseTranscript) btnCloseTranscript.addEventListener('click', () => modalTranscript.classList.remove('show'));
  if (btnCopyTranscript) {
    btnCopyTranscript.addEventListener('click', () => {
      const feed = modalTranscript.querySelector('.alex-transcript-feed');
      if (feed) {
        navigator.clipboard?.writeText(feed.innerText);
        btnCopyTranscript.textContent = '✓ Skopiowano';
        setTimeout(() => { btnCopyTranscript.textContent = 'Kopiuj Transkrypcję'; }, 2000);
      }
    });
  }
}

export function startAlexListening() {
  isAlexListening = true;
  const capsule = document.getElementById('alex-capsule');
  if (!capsule) return;

  const brand = capsule.querySelector('.vc-brand');
  const label = capsule.querySelector('.vc-status-label');
  const wave = capsule.querySelector('.vc-waveform');

  capsule.classList.add('is-listening');
  if (brand) brand.style.display = 'none';
  if (label) {
    label.textContent = isAlexContinuous ? 'Alex Live (Ciągły)...' : 'Alex słucha...';
    label.style.display = 'inline-block';
  }
  if (wave) wave.style.display = 'inline-flex';
}

export function stopAlexListening() {
  isAlexListening = false;
  const capsule = document.getElementById('alex-capsule');
  if (!capsule) return;

  const brand = capsule.querySelector('.vc-brand');
  const label = capsule.querySelector('.vc-status-label');
  const wave = capsule.querySelector('.vc-waveform');

  capsule.classList.remove('is-listening');
  if (!isAlexContinuous) {
    if (brand) brand.style.display = 'inline-block';
    if (label) label.style.display = 'none';
    if (wave) wave.style.display = 'none';
  }
}

export function toggleContinuousMode() {
  const alwaysCheckbox = document.getElementById('alex-always');
  if (alwaysCheckbox) {
    alwaysCheckbox.checked = !alwaysCheckbox.checked;
    alwaysCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    isAlexContinuous = alwaysCheckbox.checked;
  } else {
    isAlexContinuous = !isAlexContinuous;
  }
  const capsule = document.getElementById('alex-capsule');
  const toggleCont = document.getElementById('alex-toggle-continuous');

  if (isAlexContinuous) {
    capsule?.classList.add('is-continuous');
    if (toggleCont) {
      toggleCont.textContent = 'ON';
      toggleCont.classList.add('active');
    }
    showToast('Alex: Włączono tryb ciągły (Gemini Live Hands-free).');
  } else {
    capsule?.classList.remove('is-continuous');
    capsule?.classList.remove('is-listening');
    if (toggleCont) {
      toggleCont.textContent = 'OFF';
      toggleCont.classList.remove('active');
    }
    showToast('Alex: Wyłączono tryb ciągły.');
  }
}
