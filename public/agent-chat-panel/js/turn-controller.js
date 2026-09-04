/**
 * TURN CONTROLLER - AGENT CHAT PANEL (SPLOT OS)
 * Główny silnik zarządzający cyklem życia tury agenta:
 * - Live Ticker (zegar czasu rzeczywistego startujący od 1. ms)
 * - Renderowanie nagłówka z ikoną SVG i nazwą agenta
 * - Aktywny zasobnik kroków procesu (Step Timeline) z obsługą SSE w locie
 * - Zagnieżdżone karty delegacji subagentów (Hierarchical Progressive Disclosure)
 * - Wyraźne oddzielenie odpowiedzi końcowej od paska procesu
 * - Pojedyncza minimalistyczna ikona kopiowania
 */

import { AppState, getAgentSvg } from './state.js';

export class AgentTurnController {
  constructor(container, agentName = 'metaAgent', agentRole = null, customTime = null) {
    this.container = container;
    this.agent = AppState.getAgent(agentName);
    this.customTime = customTime;
    this.steps = [];
    this.delegations = new Map(); // delegationId -> { el, count, steps }
    this.toolStepMap = new Map(); // stepId -> { el, obj, payloadEl }
    this.toolsGroup = null; // { el, timelineEl, countEl, durationEl, count, totalDurationMs }
    this.startTime = Date.now();
    this.turnId = 'turn_' + Math.random().toString(36).substr(2, 9);
    this.isFinished = false;
    this.accumulatedText = '';

    this.element = this._createTurnElement();
    this.container.appendChild(this.element);
    this.container.scrollTop = this.container.scrollHeight;
    
    // Zapisz w centralnej pamięci stanu
    AppState.turns.set(this.turnId, this);

    // ── LIVE TICKER (Aktualizacja czasu co 100ms od razu po kliknięciu) ──
    if (!this.customTime) {
      this.timerInterval = setInterval(() => {
        if (this.isFinished) return;
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const elapsedEl = this.element.querySelector(`#tray-${this.turnId} .elapsed-time`);
        if (elapsedEl) {
          elapsedEl.textContent = `${elapsed}s`;
        }
      }, 100);
    }
  }

  _createTurnElement() {
    const card = document.createElement('div');
    card.className = 'agent-turn';
    card.id = this.turnId;
    card.style.setProperty('--accent', this.agent.accent);

    const timeStr = this.customTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
      <div class="turn-header">
        <div class="agent-badge">
          <span class="badge-icon">${getAgentSvg(this.agent.iconKey, 1.8)}</span>
          <span class="badge-name">${this.agent.full}</span>
        </div>
        <span class="turn-time">${timeStr}</span>
      </div>

      <!-- Aktywny zasobnik kroków (domyślnie otwarty w trakcie działania) -->
      <div class="step-tray is-running is-open" id="tray-${this.turnId}">
        <div class="step-tray-header" id="tray-head-${this.turnId}">
          <span class="tray-icon">⟳</span>
          <span class="tray-status-text">Wykonywanie procesu...</span>
          <div class="tray-metrics">
            <span class="step-count">0 kroków</span>
            <span class="elapsed-time">0.0s</span>
            <span class="tray-chev">▶</span>
          </div>
        </div>
        <div class="step-tray-collapse">
          <div class="step-tray-content">
            <div class="step-timeline" id="timeline-${this.turnId}"></div>
          </div>
        </div>
      </div>

      <!-- Treść odpowiedzi ostatecznej (wyraźnie oddzielona od paska procesu) -->
      <div class="turn-final" id="final-${this.turnId}" style="display:none;"></div>
    `;

    // Obsługa rozwijania / zwijania akordeonu
    const tray = card.querySelector(`#tray-${this.turnId}`);
    const head = card.querySelector(`#tray-head-${this.turnId}`);
    head.addEventListener('click', () => {
      tray.classList.toggle('is-open');
    });

    return card;
  }

  /**
   * Formatuje tekst myśli i planu (Markdown, inline code, listy, akapity)
   */
  _formatThoughtText(rawText) {
    if (!rawText) return '';
    const escaped = this._escapeHtml(rawText);
    
    // Podział na akapity (podwójny znak nowej linii)
    const paragraphs = escaped.split(/\n\n+/);
    
    return paragraphs.map(p => {
      let formatted = p.trim();
      
      // Inline code `symbol`
      formatted = formatted.replace(/`([^`]+)`/g, '<code class="thought-inline-code">$1</code>');
      
      // Pogrubienie **tekst**
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      
      // Listy wypunktowane (linie zaczynające się od - , * lub •)
      const lines = formatted.split('\n');
      const processedLines = lines.map(line => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ') || trimmedLine.startsWith('• ')) {
          return `<div class="thought-list-item"><span class="thought-bullet">•</span><span>${trimmedLine.replace(/^[-*•]\s*/, '')}</span></div>`;
        }
        return line;
      });
      
      formatted = processedLines.join('<br/>');
      return `<p class="thought-paragraph">${formatted}</p>`;
    }).join('');
  }

  /**
   * Dodaje krok myślowy / planowania (Thought Step / Deliberation Card)
   */
  addThoughtStep(title, thoughtText) {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const stepId = `step_thought_${this.steps.length + 1}`;
    
    // Sprawdź czy krok planu już nie istnieje (wtedy aktualizujemy treść w locie)
    const existing = this.steps.find(s => s.type === 'thought' && s.title === title);
    if (existing) {
      existing.text = thoughtText;
      const el = timeline.querySelector(`#${existing.id}`);
      if (el) {
        const bodyEl = el.querySelector('.thought-body');
        const metaEl = el.querySelector('.thought-meta');
        const words = thoughtText.trim().split(/\s+/).filter(Boolean).length;
        if (metaEl) metaEl.textContent = `${words} słów · Rozumowanie`;
        if (bodyEl) bodyEl.innerHTML = this._formatThoughtText(thoughtText);
      }
      return;
    }

    const words = thoughtText.trim().split(/\s+/).filter(Boolean).length;
    const isLong = thoughtText.length > 450;
    const formatted = this._formatThoughtText(thoughtText);

    const stepEl = document.createElement('div');
    stepEl.className = 'thought-card';
    stepEl.id = stepId;
    stepEl.innerHTML = `
      <div class="thought-header">
        <span class="thought-icon">💭</span>
        <span class="thought-title">${this._escapeHtml(title || 'Plan i analiza intencji')}</span>
        <span class="thought-meta">${words} słów · Rozumowanie</span>
      </div>
      <div class="thought-body ${isLong ? 'is-collapsed' : ''}">
        ${formatted}
      </div>
      ${isLong ? `<button class="thought-expand-btn">Rozwiń pełne rozumowanie ▾</button>` : ''}
    `;

    if (isLong) {
      const btn = stepEl.querySelector('.thought-expand-btn');
      const body = stepEl.querySelector('.thought-body');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        body.classList.toggle('is-collapsed');
        btn.textContent = body.classList.contains('is-collapsed')
          ? 'Rozwiń pełne rozumowanie ▾'
          : 'Zwiń rozumowanie ▴';
      });
    }

    timeline.appendChild(stepEl);
    this.steps.push({ id: stepId, type: 'thought', title, text: thoughtText });
    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Zwraca lub tworzy zbiorczy akordeon dla operacji narzędziowych (Tools Group Accordion)
   */
  _getOrCreateToolsGroup() {
    if (this.toolsGroup) return this.toolsGroup;

    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const groupEl = document.createElement('div');
    groupEl.className = 'tools-group-card status-running is-open';
    groupEl.id = `tools-group-${this.turnId}`;

    groupEl.innerHTML = `
      <div class="tools-group-header" id="tools-head-${this.turnId}">
        <span class="tools-group-badge">🔧 Operacje narzędziowe</span>
        <div class="tools-group-meta">
          <span class="tools-group-count">0 operacji</span>
          <span class="tools-group-duration">0.0s</span>
          <span class="tools-group-chev">▶</span>
        </div>
      </div>
      <div class="tools-group-nested-collapse">
        <div class="tools-group-nested-timeline"></div>
      </div>
    `;

    const head = groupEl.querySelector('.tools-group-header');
    head.addEventListener('click', () => {
      groupEl.classList.toggle('is-open');
    });

    timeline.appendChild(groupEl);

    this.toolsGroup = {
      el: groupEl,
      timelineEl: groupEl.querySelector('.tools-group-nested-timeline'),
      countEl: groupEl.querySelector('.tools-group-count'),
      durationEl: groupEl.querySelector('.tools-group-duration'),
      count: 0,
      totalDurationMs: 0,
    };

    return this.toolsGroup;
  }

  /**
   * Rozpoczyna krok wywołania narzędzia z jawnym ID (SSE Streaming)
   */
  startToolStepWithId(stepId, toolName, actionLabel, inputArgs = {}) {
    const group = this._getOrCreateToolsGroup();
    const effectiveId = stepId || `step_tool_${this.steps.length + 1}`;
    
    const stepEl = document.createElement('div');
    stepEl.className = 'step-item status-running';
    stepEl.id = effectiveId;

    stepEl.innerHTML = `
      <span class="step-bullet">⚙</span>
      <div class="step-body">
        <div class="step-title-row">
          <span class="step-type-tag type-tool">Tool</span>
          <span class="step-label">${this._escapeHtml(actionLabel || toolName)}</span>
          <span class="step-duration">trwa...</span>
        </div>
        <div class="step-details-toggle"><span>Parametry JSON ▾</span></div>
        <div class="step-payload">[INPUT]:\n${this._escapeHtml(JSON.stringify(inputArgs, null, 2))}</div>
      </div>
    `;

    const toggle = stepEl.querySelector('.step-details-toggle');
    const payload = stepEl.querySelector('.step-payload');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      payload.classList.toggle('is-visible');
      toggle.querySelector('span').textContent = payload.classList.contains('is-visible')
        ? 'Ukryj parametry ▴'
        : 'Parametry JSON ▾';
    });

    group.timelineEl.appendChild(stepEl);
    group.count++;
    group.countEl.textContent = `${group.count} operacj${group.count === 1 ? 'a' : (group.count < 5 ? 'e' : 'i')}`;

    const stepObj = { id: effectiveId, type: 'tool', toolName, actionLabel, inputArgs, status: 'running' };
    this.steps.push(stepObj);
    this.toolStepMap.set(effectiveId, { el: stepEl, obj: stepObj, payloadEl: payload });

    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
    return effectiveId;
  }

  /**
   * Rozpoczyna krok wywołania narzędzia i zwraca handler zakończenia (kompatybilność)
   */
  startToolStep(toolName, actionLabel, inputArgs = {}) {
    const effectiveId = `step_tool_${this.steps.length + 1}`;
    this.startToolStepWithId(effectiveId, toolName, actionLabel, inputArgs);

    return {
      complete: (status, summaryLabel, resultData, durationMs) => {
        this.updateToolStep(effectiveId, { status, summaryLabel, resultData, durationMs });
      }
    };
  }

  /**
   * Aktualizuje status trwającego kroku narzędzia (SSE Event: tool_end)
   */
  updateToolStep(stepId, { status = 'ok', summaryLabel, resultData, durationMs = 500 } = {}) {
    let entry = this.toolStepMap.get(stepId);
    
    // Fallback: jeśli nie znaleziono po ID, weź ostatni running tool
    if (!entry) {
      const runningStep = [...this.steps].reverse().find(s => s.type === 'tool' && s.status === 'running');
      if (runningStep) {
        entry = this.toolStepMap.get(runningStep.id);
      }
    }

    if (!entry) return;

    const { el, obj, payloadEl } = entry;
    obj.status = status;
    obj.summaryLabel = summaryLabel;
    obj.resultData = resultData;
    obj.durationMs = durationMs;

    el.className = `step-item status-${status === 'ok' ? 'ok' : 'error'}`;
    const bullet = el.querySelector('.step-bullet');
    if (bullet) bullet.textContent = status === 'ok' ? '✓' : '✗';
    
    const labelEl = el.querySelector('.step-label');
    if (labelEl && summaryLabel) labelEl.textContent = summaryLabel;

    const durEl = el.querySelector('.step-duration');
    if (durEl) durEl.textContent = `${(durationMs / 1000).toFixed(1)}s`;

    if (payloadEl) {
      payloadEl.textContent = `[INPUT]:\n${JSON.stringify(obj.inputArgs, null, 2)}\n\n[OUTPUT (${status === 'ok' ? 'SUCCESS' : 'ERROR'})]:\n${typeof resultData === 'string' ? resultData : JSON.stringify(resultData, null, 2)}`;
    }

    if (this.toolsGroup) {
      this.toolsGroup.totalDurationMs += durationMs;
      this.toolsGroup.durationEl.textContent = `${(this.toolsGroup.totalDurationMs / 1000).toFixed(1)}s`;
      
      const hasErrors = this.steps.some(s => s.type === 'tool' && s.status === 'error');
      const hasRunning = this.steps.some(s => s.type === 'tool' && s.status === 'running');
      const isCardOpen = this.toolsGroup.el.classList.contains('is-open');
      this.toolsGroup.el.className = `tools-group-card status-${hasRunning ? 'running' : (hasErrors ? 'error' : 'ok')}${isCardOpen ? ' is-open' : ''}`;
    }

    this._updateMetrics();
  }

  /**
   * Dodaje zagnieżdżoną kartę delegacji (Hierarchical Sub-Accordion dla delegacji)
   */
  addDelegationBlock(delegationId, targetAgentName, brief = '', mode = 'sync', model = 'gemini-3.7-flash', inputArgs = {}, outputResult = '', durationMs = 1200, status = 'running') {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const dId = delegationId || `del_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    const isFinished = status === 'ok' || status === 'error';
    const delCard = document.createElement('div');
    delCard.className = `delegation-card status-${status}${!isFinished ? ' is-open' : ''}`;
    delCard.id = `card-${dId}`;

    const cleanBrief = brief ? (brief.length > 55 ? `${brief.substring(0, 52)}...` : brief) : 'Oddelegowane podzadanie';
    const durStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '1.2s';
    const statusText = !isFinished ? 'trwa...' : (status === 'ok' ? `✓ ${durStr}` : `✗ Błąd (${durStr})`);

    const briefFormatted = brief ? this._formatThoughtText(brief) : '';
    const resultFormatted = outputResult ? this._formatThoughtText(outputResult) : '';

    delCard.innerHTML = `
      <div class="del-header" id="del-head-${dId}">
        <span class="del-badge">🤖 ${this._escapeHtml(targetAgentName)}</span>
        <span class="del-brief" title="${this._escapeHtml(brief)}">${this._escapeHtml(cleanBrief)}</span>
        <div class="del-meta">
          <span class="del-status del-status-${status}">${statusText}</span>
          <span class="del-chev">▶</span>
        </div>
      </div>
      <div class="del-nested-collapse">
        <div class="del-nested-timeline" id="del-timeline-${dId}">
          ${brief ? `
            <div class="del-detail-section">
              <div class="del-section-title">📋 Zadanie oddelegowane (Brief):</div>
              <div class="del-section-content del-brief-content">${briefFormatted}</div>
            </div>
          ` : ''}
          <div class="del-substeps-container" id="del-substeps-${dId}"></div>
          <div class="del-detail-section del-result-section" id="del-result-sec-${dId}" style="${outputResult ? '' : 'display:none;'}">
            <div class="del-section-title">📤 Wynik wykonania subagenta:</div>
            <div class="del-section-content del-result-content">${resultFormatted}</div>
          </div>
        </div>
      </div>
    `;

    // Obsługa rozwijania pod-akordeonu po kliknięciu
    const head = delCard.querySelector(`#del-head-${dId}`);
    head.addEventListener('click', () => {
      delCard.classList.toggle('is-open');
    });

    timeline.appendChild(delCard);
    
    const delRecord = {
      id: dId,
      agent: targetAgentName,
      brief,
      mode,
      model,
      inputArgs,
      outputResult,
      count: 0,
      el: delCard,
      timelineEl: delCard.querySelector(`#del-substeps-${dId}`),
      resultSecEl: delCard.querySelector(`#del-result-sec-${dId}`),
      status,
    };
    
    this.delegations.set(dId, delRecord);
    this.steps.push({ type: 'delegation_block', id: dId, targetAgentName, brief, mode, model, outputResult, status });
    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
    return dId;
  }

  /**
   * Wstrzykuje operację narzędziową subagenta do jego karty delegacji
   */
  addSubagentStep(delegationId, { toolName = 'tool', actionLabel = '', status = 'ok', durationMs = 400, inputArgs = {}, resultData = null } = {}) {
    let delRecord = this.delegations.get(delegationId);
    
    // Jeśli nie podano delegationId, przypnij do ostatniej running delegacji
    if (!delRecord) {
      const lastDel = [...this.delegations.values()].reverse().find(d => d.status === 'running');
      if (lastDel) delRecord = lastDel;
    }

    if (!delRecord) {
      // Fallback: dodaj zwykły krok narzędzia
      const st = this.startToolStep(toolName, actionLabel || `[Subagent] ${toolName}`, inputArgs);
      st.complete(status, actionLabel, resultData, durationMs);
      return;
    }

    delRecord.count++;
    const subStepEl = document.createElement('div');
    subStepEl.className = `sub-step-item status-${status}`;
    subStepEl.innerHTML = `
      <span class="sub-step-bullet">${status === 'ok' ? '✓' : '⚙'}</span>
      <span class="sub-step-label">${this._escapeHtml(actionLabel || toolName)}</span>
      <span class="sub-step-duration">${(durationMs / 1000).toFixed(1)}s</span>
    `;

    delRecord.timelineEl.appendChild(subStepEl);
    
    const metaStatus = delRecord.el.querySelector('.del-status');
    if (metaStatus && delRecord.status === 'running') {
      metaStatus.textContent = `${delRecord.count} operacj${delRecord.count === 1 ? 'a' : (delRecord.count < 5 ? 'e' : 'i')}...`;
    }

    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Kończy delegację subagenta i aktualizuje nagłówek karty oraz wynik
   */
  completeDelegation(delegationId, { summary = '', output = '', durationMs = 1200, status = 'ok' } = {}) {
    let delRecord = this.delegations.get(delegationId);
    if (!delRecord) {
      const lastDel = [...this.delegations.values()].reverse().find(d => d.status === 'running');
      if (lastDel) delRecord = lastDel;
    }

    if (!delRecord) return;

    delRecord.status = status;
    delRecord.el.className = `delegation-card status-${status}`;
    
    const effectiveOutput = output || summary || '';
    if (effectiveOutput && delRecord.resultSecEl) {
      delRecord.resultSecEl.style.display = 'block';
      const contentEl = delRecord.resultSecEl.querySelector('.del-result-content');
      if (contentEl) contentEl.innerHTML = this._formatThoughtText(effectiveOutput);
    }

    const metaStatus = delRecord.el.querySelector('.del-status');
    if (metaStatus) {
      metaStatus.className = `del-status del-status-${status}`;
      metaStatus.textContent = status === 'ok'
        ? `✓ ${(durationMs / 1000).toFixed(1)}s`
        : `✗ Błąd (${(durationMs / 1000).toFixed(1)}s)`;
    }

    // Domyślnie zwiń pod-akordeon po zakończeniu dla czystości
    delRecord.el.classList.remove('is-open');
    this._updateMetrics();
  }

  /**
   * Dodaje prosty chip delegacji (wsteczna kompatybilność)
   */
  addDelegation(toAgentName, mode = 'sync', model = 'gemini-3.7-flash') {
    this.addDelegationBlock(null, toAgentName, `Zadanie dla ${toAgentName}`, mode, model);
  }

  /**
   * Dodaje krótką wiadomość informacyjną w trakcie procesu (Mid-chain update)
   */
  addIntermediateMessage(messageText) {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const noteEl = document.createElement('div');
    noteEl.className = 'intermediate-note';
    noteEl.innerHTML = `<strong>Status:</strong> ${this._escapeHtml(messageText)}`;
    timeline.appendChild(noteEl);
    this.steps.push({ type: 'intermediate_note', text: messageText });
    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Dodaje kartę weryfikacji celu (Goal Completion Scorer) do osi czasu procesu
   */
  addEvaluatorReport(title = 'Weryfikacja celu (Goal Scorer)', reportText = '') {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const evalEl = document.createElement('div');
    evalEl.className = 'eval-report-card';
    evalEl.innerHTML = `
      <div class="eval-report-header">
        <span class="eval-report-icon">🎯</span>
        <span class="eval-report-title">${this._escapeHtml(title)}</span>
        <span class="eval-badge">Score: 1 ✅</span>
      </div>
      <pre class="eval-report-body">${this._escapeHtml(reportText)}</pre>
    `;
    timeline.appendChild(evalEl);
    this.steps.push({ type: 'evaluator_report', text: reportText });
    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Dodaje kartę bramki kognitywnej (Auto Review, Approval Gate, Deliberation, Depth Upgrade) do procesu
   */
  addGateStep(gateType = 'gate', title = 'Bramka kognitywna', details = '', badge = '') {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const gateEl = document.createElement('div');
    gateEl.className = `gate-step-card gate-${gateType}`;

    let icon = '🔍';
    let defaultTitle = 'Bramka kognitywna';
    let defaultBadge = 'Zaliczono ✓';

    if (gateType === 'auto_review') {
      icon = '🔍';
      defaultTitle = 'Auto Review Gate (Autokrytyka)';
      defaultBadge = badge || 'Approve ✓';
    } else if (gateType === 'approval_gate' || gateType === 'approval') {
      icon = '🛡️';
      defaultTitle = 'Approval Gate (Bramka Bezpieczeństwa)';
      defaultBadge = badge || 'Weryfikacja autoryzacji ⚠️';
    } else if (gateType === 'deliberation') {
      icon = '🤔';
      defaultTitle = 'Auto Deliberation Gate';
      defaultBadge = badge || 'Deliberacja';
    } else if (gateType === 'depth_upgrade') {
      icon = '⚡';
      defaultTitle = 'Depth Upgrade Pass';
      defaultBadge = badge || 'Critical Depth';
    } else if (gateType === 'auto_retry' || gateType === 'retry') {
      icon = '↻';
      defaultTitle = 'Ponowienie wykonania (Auto-Recovery)';
      defaultBadge = badge || 'Wznowienie';
    }

    gateEl.innerHTML = `
      <div class="gate-step-header">
        <span class="gate-step-icon">${icon}</span>
        <span class="gate-step-title">${this._escapeHtml(title || defaultTitle)}</span>
        <span class="gate-step-badge">${this._escapeHtml(badge || defaultBadge)}</span>
      </div>
      ${details ? `<div class="gate-step-body">${this._escapeHtml(details.slice(0, 350))}${details.length > 350 ? '...' : ''}</div>` : ''}
    `;

    timeline.appendChild(gateEl);
    this.steps.push({ type: 'gate', gateType, title: title || defaultTitle, text: details });
    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Dodaje blok błędu wywołania narzędzia z opcją ponowienia
   */
  addError(toolName, errMsg, attempt = 1, onRetry = null) {
    const timeline = this.element.querySelector(`#timeline-${this.turnId}`);
    const errEl = document.createElement('div');
    errEl.className = 'error-card';
    errEl.innerHTML = `
      <div class="error-title">⚠ Błąd wykonania narzędzia · ${this._escapeHtml(toolName)}</div>
      <div class="error-msg">${this._escapeHtml(errMsg)} (próba ${attempt}/3)</div>
      <div class="error-actions">
        <button class="err-btn btn-retry">↻ Ponów</button>
        <button class="err-btn ghost btn-delegate">Deleguj do nadzoru</button>
      </div>
    `;

    errEl.querySelector('.btn-retry').addEventListener('click', () => {
      if (onRetry) onRetry();
    });

    timeline.appendChild(errEl);
    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
  }

  /**
   * Przyrostowe dopisywanie fragmentu tekstu odpowiedzi (Token Streaming)
   */
  appendDelta(textChunk) {
    if (!textChunk) return;
    this.accumulatedText += textChunk;
    const finalBox = this.element.querySelector(`#final-${this.turnId}`);
    if (finalBox) {
      finalBox.style.display = 'block';
      finalBox.innerHTML = this._escapeHtml(this.accumulatedText).replace(/\n/g, '<br/>');
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  /**
   * Zakończenie tury: Zwijanie kroków i renderowanie odpowiedzi ostatecznej
   */
  finishTurn(finalHtmlContent, options = { autoCollapse: true }) {
    this.isFinished = true;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const tray = this.element.querySelector(`#tray-${this.turnId}`);
    const finalBox = this.element.querySelector(`#final-${this.turnId}`);

    tray.classList.remove('is-running');
    tray.querySelector('.tray-icon').textContent = '⚡';
    tray.querySelector('.tray-status-text').textContent = `Wykonano proces (${elapsed}s)`;

    // Auto-zwinięcie akordeonu do eleganckiego paska
    if (options.autoCollapse) {
      tray.classList.remove('is-open');
    }

    // Domyślnie zwiń pod-akordeon narzędzi po zakończeniu procesu dla czystości
    if (this.toolsGroup) {
      this.toolsGroup.el.classList.remove('is-open');
      this.toolsGroup.el.classList.remove('status-running');
      const hasErrors = this.steps.some(s => s.type === 'tool' && s.status === 'error');
      this.toolsGroup.el.classList.add(hasErrors ? 'status-error' : 'status-ok');
    }

    // Wyświetlenie głównej odpowiedzi końcowej z minimalistyczną ikonką kopiowania
    const copySvg = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const checkSvg = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#2EE6A8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    finalBox.innerHTML = `
      ${finalHtmlContent || (this.accumulatedText ? this.accumulatedText : '')}
      <div class="turn-actions">
        <button class="turn-icon-btn btn-copy-turn" title="Kopiuj do schowka">${copySvg}</button>
      </div>
    `;
    finalBox.style.display = 'block';

    const copyBtn = finalBox.querySelector('.btn-copy-turn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const textToCopy = finalBox.innerText.trim();
        navigator.clipboard?.writeText(textToCopy);
        copyBtn.innerHTML = checkSvg;
        copyBtn.title = 'Skopiowano do schowka';
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.title = 'Kopiuj do schowka';
        }, 2000);
      });
    }

    this._updateMetrics();
    this.container.scrollTop = this.container.scrollHeight;
  }

  _updateMetrics() {
    const toolSteps = this.steps.filter(s => s.type === 'tool');
    const okCount = toolSteps.filter(s => s.status === 'ok').length;
    const errCount = toolSteps.filter(s => s.status === 'error').length;
    const totalCount = this.steps.length;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const metricsEl = this.element.querySelector('.tray-metrics');
    if (!metricsEl) return;

    let summaryHtml = `<span class="step-count">${totalCount} krok${totalCount === 1 ? '' : (totalCount < 5 ? 'i' : 'ów')}</span>`;
    
    if (okCount > 0) summaryHtml += `<span class="ok-cnt">✓ ${okCount}</span>`;
    if (errCount > 0) summaryHtml += `<span class="err-cnt">✗ ${errCount}</span>`;
    
    summaryHtml += `<span class="elapsed-time">${elapsed}s</span><span class="tray-chev">▶</span>`;
    metricsEl.innerHTML = summaryHtml;
  }

  _escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
