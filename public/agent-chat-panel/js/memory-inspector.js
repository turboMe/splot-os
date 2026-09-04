/**
 * MEMORY, LEDGER & ARTIFACTS INSPECTOR - AGENT CHAT PANEL (SPLOT OS)
 * Precyzyjne mapowanie struktur danych z systemu Mastra & MongoDB:
 * - SystemKnowledge (Pamięć Obserwacyjna / Semantyczna / Ekstraktor Wiedzy)
 * - Task Ledger & Agent Events (Kolejki wykonawcze LaneRecord, Claims, Konsola & Logi z Tabami)
 * - ArtifactStore & ARTIFACT_TYPES (Typowane artefakty z sortowaniem, filtrowaniem i modalem)
 */

import { getAgentSvg } from './state.js';
import { showToast } from './app.js';

// Formatowanie rozmiaru bajtów
function humanSize(b) {
  if (b == null || isNaN(b)) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getArtifactIcon(type) {
  switch(type) {
    case 'research_report': return '📄';
    case 'analysis_report': return '{ }';
    case 'automation_workflow': return '⚙';
    case 'menu_book_ref': return '📖';
    case 'diff_patch': return 'Δ';
    case 'code_task_artifact': return '💻';
    case 'brief': return '📋';
    default: return '📦';
  }
}

// ── 1. MAPOWANIE PAMIĘCI OBSERWACYJNEJ (SystemKnowledge) ───────────────────
export async function buildMemoryInspector(container) {
  if (!container) return;
  container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">Ładowanie pamięci systemowej...</div>`;

  try {
    const res = await fetch('/splot/api/inspectors/memory');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const { rules, stats } = json.data || { rules: [], stats: {} };

    const totalRules = stats.totalRules || rules.length || 0;
    const omDocs = stats.omDocs || 0;
    const sharedLeases = stats.sharedLeases || 0;

    container.innerHTML = `
      <!-- Metryki i stan Pamięci Operacyjnej -->
      <div class="mem-section">
        <div class="mem-sec-title">Status Substratu Pamięci (Mastra Observational)</div>
        
        <div class="mem-layer">
          <span class="ml-ic" style="background:rgba(255,77,0,0.15);color:var(--signal);">OM</span>
          <div class="ml-info">
            <div class="ml-name">Observational Memory Engine</div>
            <div class="ml-sub">Model: ${stats.engineModel || 'deepseek-v4-flash'} · Pamięć wątków</div>
            <div class="mem-meter"><i style="width:${Math.min(100, Math.max(15, omDocs > 0 ? (omDocs / 10).toFixed(0) : 42))}%"></i></div>
          </div>
          <div class="ml-val">${omDocs} wpisów</div>
        </div>

        <div class="mem-layer">
          <span class="ml-ic" style="background:rgba(46,230,168,0.15);color:var(--success);">VEC</span>
          <div class="ml-info">
            <div class="ml-name">Semantic Recall (system_knowledge)</div>
            <div class="ml-sub">Indeks: ${stats.vectorIndex || 'text-embedding-3-small'} · Cosine Sim</div>
            <div class="mem-meter"><i style="width:${Math.min(100, Math.max(20, (totalRules / 4).toFixed(0)))}%"></i></div>
          </div>
          <div class="ml-val">${totalRules} reguł</div>
        </div>

        <div class="mem-layer">
          <span class="ml-ic" style="background:rgba(168,85,247,0.15);color:var(--accent-analytics);">TTL</span>
          <div class="ml-info">
            <div class="ml-name">Pamięć Współdzielona (Shared Leases)</div>
            <div class="ml-sub">Wygasanie TTL: 90 dni (odnawiane przy recall)</div>
            <div class="mem-meter"><i style="width:${Math.min(100, Math.max(10, sharedLeases * 2))}%"></i></div>
          </div>
          <div class="ml-val">${sharedLeases} aktywnych</div>
        </div>
      </div>

      <!-- Lista Wyekstrahowanej Wiedzy (SystemKnowledge Cards) -->
      <div class="mem-section">
        <div class="mem-sec-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>Wyekstrahowana Wiedza Systemowa</span>
          <span style="color:var(--signal);font-size:10px;">${totalRules} reguł w MongoDB</span>
        </div>

        <div class="knowledge-cards-list">
          ${rules.length === 0 ? `<div style="padding:12px;color:var(--muted);font-size:11px;">Brak wyekstrahowanych reguł w system_knowledge</div>` : rules.map(k => `
            <div class="knowledge-card">
              <div class="kc-head">
                <span class="kc-type-tag type-${k.type}">${k.type}</span>
                <span class="kc-score" title="Poziom pewności">${(k.confidence * 100).toFixed(0)}%</span>
              </div>
              <div class="kc-title">${k.title}</div>
              <div class="kc-content">${k.content}</div>
              <div class="kc-footer">
                <div class="kc-tags">
                  ${(k.tags || []).map(t => `<span class="kc-tag">#${t}</span>`).join('')}
                </div>
                <div class="kc-meta">
                  <span>⚡ ${k.sourceAgent}</span>
                  <span>↻ ${k.usageCount || 1} użyć</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div style="padding:20px;color:var(--error);font-size:12px;">
        Błąd ładowania pamięci: ${err.message}
        <button onclick="buildMemoryInspector(this.closest('#mem-body'))" style="margin-top:8px;padding:4px 8px;font-size:11px;cursor:pointer;">Ponów</button>
      </div>
    `;
  }
}

// ── 2. MAPOWANIE TASK LEDGERA I KONSOLI Z TABAMI ───────────────────────────
let activeLedgerTab = 'ledger'; // 'ledger' | 'logs'

export async function buildLedgerInspector(container) {
  if (!container) return;
  container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">Ładowanie kolejki Task Ledger i logów...</div>`;

  try {
    const res = await fetch('/splot/api/inspectors/ledger');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const { lanes, events } = json.data || { lanes: [], events: [] };

    container.innerHTML = `
      <!-- Taby przełączania: Task Ledger vs Konsola -->
      <div class="drawer-tabs">
        <button class="dtab ${activeLedgerTab === 'ledger' ? 'active' : ''}" id="tab-btn-ledger">📋 Task Ledger (${lanes.length})</button>
        <button class="dtab ${activeLedgerTab === 'logs' ? 'active' : ''}" id="tab-btn-logs">💻 Konsola & Logi (${events.length})</button>
      </div>

      <!-- Tab 1: Aktywne Kolejki Wykonawcze (Task Ledger Lanes) -->
      <div id="ledger-tab-content" style="display:${activeLedgerTab === 'ledger' ? 'block' : 'none'};padding-top:10px;">
        <div class="mem-section">
          <div class="mem-sec-title" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Aktywne Kolejki (Task Ledger Lanes §3.2)</span>
            <button class="term-refresh-btn" id="btn-refresh-ledger" style="background:none;border:none;color:var(--signal);cursor:pointer;font-size:11px;">↻ Odśwież</button>
          </div>
          
          <div class="lane-cards-list">
            ${lanes.length === 0 ? `<div style="padding:16px;text-align:center;color:var(--muted);font-size:11px;">Brak aktywnych kolejek w Task Ledger</div>` : lanes.map(l => `
              <div class="lane-card state-${l.state}">
                <div class="lane-card-head">
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="lane-no">#${l.laneNo}</span>
                    <span class="lane-agent">${l.agentId}</span>
                  </div>
                  <span class="lane-state-pill ${l.state}">● ${l.state}</span>
                </div>
                <div class="lane-goal">${l.goal}</div>
                <div class="lane-footer">
                  <div class="lane-claims">
                    ${(l.claims || []).map(c => `<span class="lane-claim">🔒 ${c}</span>`).join('')}
                  </div>
                  <div class="lane-owner">${l.owner === 'durable' ? '⚡ Durable Substrate' : '⏱ Heartbeat'} · ${l.duration}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Tab 2: Pełnowymiarowy Dziennik Zdarzeń i Konsola (Agent Events Stream) -->
      <div id="logs-tab-content" style="display:${activeLedgerTab === 'logs' ? 'block' : 'none'};padding-top:10px;">
        <div class="terminal-container terminal-full-height">
          <div class="mem-sec-title" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Dziennik Zdarzeń (Agent Event Stream)</span>
            <button class="term-refresh-btn" id="btn-refresh-logs" style="background:none;border:none;color:var(--signal);cursor:pointer;font-size:11px;">↻ Odśwież</button>
          </div>
          
          <div class="term-filters">
            <button class="term-filter-btn active" data-filter="all">Wszystkie (${events.length})</button>
            <button class="term-filter-btn" data-filter="error">Błędy</button>
            <button class="term-filter-btn" data-filter="tool">Narzędzia</button>
            <button class="term-filter-btn" data-filter="delegation">Delegacje</button>
          </div>

          <div class="terminal-logs" id="terminal-logs-body">
            ${events.length === 0 ? `<div style="padding:16px;text-align:center;color:var(--muted);font-size:11px;">Brak zdarzeń telemetrycznych w bazie MongoDB</div>` : events.map(log => {
              const typeLower = (log.type || '').toLowerCase();
              const isTool = typeLower.includes('tool') || typeLower.includes('command') || typeLower.includes('sandbox');
              const isDelegation = typeLower.includes('delegat') || typeLower.includes('subagent') || typeLower.includes('handoff');
              return `
                <div class="log-line ${log.level} ${isTool ? 'tool' : ''} ${isDelegation ? 'delegation' : ''}">
                  <span class="log-time">${log.time}</span>
                  <span class="log-agent">${log.agent}</span>
                  <span class="log-msg">${escapeHtml(log.msg)}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    // Obsługa przełączania tabów
    const tabBtnLedger = container.querySelector('#tab-btn-ledger');
    const tabBtnLogs = container.querySelector('#tab-btn-logs');
    const contentLedger = container.querySelector('#ledger-tab-content');
    const contentLogs = container.querySelector('#logs-tab-content');

    tabBtnLedger?.addEventListener('click', () => {
      activeLedgerTab = 'ledger';
      tabBtnLedger.classList.add('active');
      tabBtnLogs?.classList.remove('active');
      if (contentLedger) contentLedger.style.display = 'block';
      if (contentLogs) contentLogs.style.display = 'none';
    });

    tabBtnLogs?.addEventListener('click', () => {
      activeLedgerTab = 'logs';
      tabBtnLogs.classList.add('active');
      tabBtnLedger?.classList.remove('active');
      if (contentLogs) contentLogs.style.display = 'block';
      if (contentLedger) contentLedger.style.display = 'none';
      
      // Auto-scroll na sam dół logów przy wejściu do konsoli
      const logsBody = container.querySelector('#terminal-logs-body');
      if (logsBody) logsBody.scrollTop = logsBody.scrollHeight;
    });

    container.querySelector('#btn-refresh-ledger')?.addEventListener('click', () => buildLedgerInspector(container));
    container.querySelector('#btn-refresh-logs')?.addEventListener('click', () => buildLedgerInspector(container));

    container.querySelectorAll('.term-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.term-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        container.querySelectorAll('.log-line').forEach(line => {
          if (filter === 'all' || line.classList.contains(filter)) {
            line.style.display = 'flex';
          } else {
            line.style.display = 'none';
          }
        });
      });
    });

  } catch (err) {
    container.innerHTML = `
      <div style="padding:20px;color:var(--error);font-size:12px;">
        Błąd ładowania Task Ledgera: ${err.message}
        <button onclick="buildLedgerInspector(this.closest('#term-body'))" style="margin-top:8px;padding:4px 8px;font-size:11px;cursor:pointer;">Ponów</button>
      </div>
    `;
  }
}

// ── 3. MAPOWANIE ARTEFAKTÓW I PLIKÓW (Z SORTOWANIEM, SZUKANIEM I MODALEM) ──
let allArtifactsCache = [];
let artifactSortOrder = 'date-desc'; // 'date-desc' | 'date-asc' | 'size-desc' | 'title-asc'
let artifactSearchQuery = '';

export async function buildArtifactsInspector(container) {
  if (!container) return;
  container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">Ładowanie artefaktów...</div>`;

  try {
    const res = await fetch('/splot/api/inspectors/artifacts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    allArtifactsCache = json.data || [];

    // Renderujemy strukturę szkieletu tylko RAZ, aby nie niszczyć inputa wyszukiwarki przy wpisywaniu
    container.innerHTML = `
      <div class="mem-section">
        <div class="mem-sec-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>Zarejestrowane Artefakty (ArtifactStore)</span>
          <span style="color:var(--signal);font-size:10px;">${allArtifactsCache.length} plików w bazie</span>
        </div>

        <!-- Pasek narzędziowy: Wyszukiwarka i Sortowanie (Trwały w DOM) -->
        <div class="art-toolbar">
          <div class="art-toolbar-row">
            <input type="text" class="art-search-input" id="art-search-input" placeholder="Szukaj artefaktu (nazwa, typ, autor)..." value="${escapeHtml(artifactSearchQuery)}">
            <select class="art-sort-select" id="art-sort-select">
              <option value="date-desc" ${artifactSortOrder === 'date-desc' ? 'selected' : ''}>Najnowsze pierwsze ↓</option>
              <option value="date-asc" ${artifactSortOrder === 'date-asc' ? 'selected' : ''}>Najstarsze pierwsze ↑</option>
              <option value="size-desc" ${artifactSortOrder === 'size-desc' ? 'selected' : ''}>Rozmiar ↓</option>
              <option value="title-asc" ${artifactSortOrder === 'title-asc' ? 'selected' : ''}>Nazwa A-Z</option>
            </select>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="art-count-badge" id="art-count-badge">Ładowanie...</span>
            <button id="btn-clear-art-search" style="display:none;background:none;border:none;color:var(--signal);font-size:10px;cursor:pointer;padding:0;">✕ Wyczyść filtr</button>
          </div>
        </div>

        <!-- Dynamiczna lista kart artefaktów -->
        <div class="artifact-list" id="art-cards-list"></div>
      </div>
    `;

    const searchInput = container.querySelector('#art-search-input');
    const sortSelect = container.querySelector('#art-sort-select');
    const btnClear = container.querySelector('#btn-clear-art-search');
    const cardsListContainer = container.querySelector('#art-cards-list');
    const countBadge = container.querySelector('#art-count-badge');

    function updateCardsList() {
      // Filtrowanie
      let filtered = allArtifactsCache.filter(a => {
        if (!artifactSearchQuery) return true;
        const q = artifactSearchQuery.toLowerCase();
        return (
          (a.title || '').toLowerCase().includes(q) ||
          (a.summary || '').toLowerCase().includes(q) ||
          (a.producedBy || '').toLowerCase().includes(q) ||
          (a.type || '').toLowerCase().includes(q)
        );
      });

      // Sortowanie
      filtered.sort((a, b) => {
        if (artifactSortOrder === 'date-desc') {
          return (new Date(b.createdAt || 0).getTime() || 0) - (new Date(a.createdAt || 0).getTime() || 0);
        } else if (artifactSortOrder === 'date-asc') {
          return (new Date(a.createdAt || 0).getTime() || 0) - (new Date(b.createdAt || 0).getTime() || 0);
        } else if (artifactSortOrder === 'size-desc') {
          return (b.bytes || 0) - (a.bytes || 0);
        } else if (artifactSortOrder === 'title-asc') {
          return (a.title || '').localeCompare(b.title || '');
        }
        return 0;
      });

      if (countBadge) {
        countBadge.textContent = `Widoczne: ${filtered.length} z ${allArtifactsCache.length}`;
      }

      if (btnClear) {
        btnClear.style.display = artifactSearchQuery ? 'inline-block' : 'none';
      }

      if (!cardsListContainer) return;

      if (filtered.length === 0) {
        cardsListContainer.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px;">Brak artefaktów spełniających kryteria wyszukiwania</div>`;
        return;
      }

      cardsListContainer.innerHTML = filtered.map(a => `
        <div class="artifact-card" data-art-id="${a.id}" title="Kliknij, aby otworzyć szczegółowy podgląd artefaktu">
          <div class="artifact-icon">${getArtifactIcon(a.type)}</div>
          <div class="artifact-info">
            <div class="artifact-name">${escapeHtml(a.title)}</div>
            <div class="artifact-summary">${escapeHtml(a.summary)}</div>
            <div class="artifact-meta-row">
              <span class="art-type-pill type-${a.type}">${a.type}</span>
              <span>⚡ ${escapeHtml(a.producedBy)}</span>
              <span>📦 ${humanSize(a.bytes)}</span>
              ${a.filePath ? `<span title="${escapeHtml(a.filePath)}">📁 ${escapeHtml(a.filePath.split('/').pop() || a.filePath)}</span>` : ''}
              <span>${a.createdAt || 'Dzisiaj'}</span>
              <span>Lane ${a.laneId}</span>
            </div>
          </div>
        </div>
      `).join('');

      // Podpięcie kliknięcia na każdą kartę
      cardsListContainer.querySelectorAll('.artifact-card').forEach(card => {
        card.addEventListener('click', () => {
          const artId = card.dataset.artId;
          openArtifactPreviewModal(artId);
        });
      });
    }

    // Płynne wpisywanie bez utraty fokusu
    searchInput?.addEventListener('input', (e) => {
      artifactSearchQuery = e.target.value;
      updateCardsList();
    });

    sortSelect?.addEventListener('change', (e) => {
      artifactSortOrder = e.target.value;
      updateCardsList();
    });

    btnClear?.addEventListener('click', () => {
      artifactSearchQuery = '';
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      updateCardsList();
    });

    // Pierwsze wyrenderowanie listy
    updateCardsList();

  } catch (err) {
    container.innerHTML = `
      <div style="padding:20px;color:var(--error);font-size:12px;">
        Błąd ładowania artefaktów: ${err.message}
        <button onclick="buildArtifactsInspector(this.closest('#art-body'))" style="margin-top:8px;padding:4px 8px;font-size:11px;cursor:pointer;">Ponów</button>
      </div>
    `;
  }
}

// ── 4. MODAL SZCZEGÓŁOWEGO PODGLĄDU ARTEFAKTU ──────────────────────────────
let currentPreviewArtifact = null;

export async function openArtifactPreviewModal(artId) {
  const modal = document.getElementById('modal-artifact-preview');
  if (!modal) return;

  const titleEl = document.getElementById('art-modal-title');
  const iconEl = document.getElementById('art-modal-icon');
  const typeBadgeEl = document.getElementById('art-modal-type-badge');
  const authorEl = document.getElementById('art-modal-author');
  const dateEl = document.getElementById('art-modal-date');
  const sizeEl = document.getElementById('art-modal-size');
  const shaEl = document.getElementById('art-modal-sha');
  const laneEl = document.getElementById('art-modal-lane');
  const pathRowEl = document.getElementById('art-modal-path-row');
  const pathEl = document.getElementById('art-modal-filepath');
  const summaryEl = document.getElementById('art-modal-summary');
  const contentEl = document.getElementById('art-modal-content');

  // Stan ładowania
  if (titleEl) titleEl.textContent = 'Ładowanie artefaktu...';
  if (summaryEl) summaryEl.textContent = 'Pobieranie pełnej zawartości ze strumienia ArtifactStore...';
  if (contentEl) contentEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);">Ładowanie danych...</div>';
  if (pathRowEl) pathRowEl.style.display = 'none';
  modal.classList.add('open');

  try {
    const detailRes = await fetch(`/splot/api/inspectors/artifacts/${encodeURIComponent(artId)}/content`);
    if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
    const detailJson = await detailRes.json();
    const art = detailJson.data || {};
    currentPreviewArtifact = art;

    if (titleEl) titleEl.textContent = art.title || art.id;
    if (iconEl) iconEl.textContent = getArtifactIcon(art.type);
    if (typeBadgeEl) {
      typeBadgeEl.textContent = art.type || 'document';
      typeBadgeEl.className = `art-type-pill type-${art.type || 'default'}`;
    }
    if (authorEl) authorEl.textContent = art.producedBy || 'system';
    if (dateEl) dateEl.textContent = art.createdAt ? new Date(art.createdAt).toLocaleString('pl-PL') : 'Dzisiaj';
    if (sizeEl) sizeEl.textContent = humanSize(art.bytes);
    if (shaEl) shaEl.textContent = art.sha256 ? art.sha256.substring(0, 12) : 'brak';
    if (laneEl) laneEl.textContent = art.laneId || '#1';
    if (summaryEl) summaryEl.textContent = art.summary || 'Brak dodatkowego podsumowania.';

    // Wyświetlanie ścieżki do pliku na dysku (jeśli istnieje)
    const resolvedPath = art.resolvedFilePath || art.filePath || art.metadata?.filePath || art.metadata?.path || (art.uri?.startsWith('file://') ? art.uri.replace('file://', '') : null);
    if (pathRowEl && pathEl) {
      if (resolvedPath) {
        pathEl.textContent = resolvedPath;
        pathRowEl.style.display = 'flex';
      } else {
        pathRowEl.style.display = 'none';
      }
    }

    const rawContent = art.content || 'Brak treści tekstowej w tym artefakcie.';
    if (contentEl) {
      contentEl.textContent = rawContent;
    }
  } catch (err) {
    if (contentEl) contentEl.innerHTML = `<div style="color:var(--error);padding:14px;">Błąd pobierania treści artefaktu: ${err.message}</div>`;
  }
}

// Inicjalizacja zdarzeń modalu artefaktu
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    setupArtifactModalEvents();
  });
  // Fallback jeśli DOM już jest załadowany
  setupArtifactModalEvents();
}

function setupArtifactModalEvents() {
  const modal = document.getElementById('modal-artifact-preview');
  if (!modal || modal.dataset.eventsAttached) return;
  modal.dataset.eventsAttached = 'true';

  const btnClose = document.getElementById('btn-art-modal-close');
  const btnFooterClose = document.getElementById('btn-art-modal-footer-close');
  const btnCopy = document.getElementById('btn-art-modal-copy');
  const btnCopyPath = document.getElementById('btn-art-modal-copy-path');

  const closeModal = () => {
    modal.classList.remove('open');
    currentPreviewArtifact = null;
  };

  btnClose?.addEventListener('click', closeModal);
  btnFooterClose?.addEventListener('click', closeModal);

  // Zamknięcie po kliknięciu w tło (backdrop)
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Zamknięcie klawiszem Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) {
      closeModal();
    }
  });

  // Kopiowanie treści artefaktu
  btnCopy?.addEventListener('click', () => {
    const text = currentPreviewArtifact?.content || '';
    if (!text) {
      showToast('Brak treści do skopiowania');
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      showToast('Skopiowano treść artefaktu do schowka ✓');
    }).catch(() => {
      showToast('Nie udało się skopiować treści');
    });
  });

  // Kopiowanie ścieżki pliku
  btnCopyPath?.addEventListener('click', () => {
    const path = currentPreviewArtifact?.resolvedFilePath || currentPreviewArtifact?.filePath || currentPreviewArtifact?.metadata?.filePath || currentPreviewArtifact?.metadata?.path || (currentPreviewArtifact?.uri?.startsWith('file://') ? currentPreviewArtifact.uri.replace('file://', '') : '');
    if (!path) {
      showToast('Brak ścieżki pliku do skopiowania');
      return;
    }
    navigator.clipboard.writeText(path).then(() => {
      showToast('Skopiowano ścieżkę pliku do schowka ✓');
    }).catch(() => {
      showToast('Nie udało się skopiować ścieżki');
    });
  });
}
