// === ANALYTICS.JS ===

(() => {
  const VERSION = 'phase-2-v2-analytics';
  let initialized = false;
  let refreshImpl = null;
  let destroyImpl = null;

  function init(options = {}) {
    if (initialized) {
      return { initialized: true, ownsRendering: true, version: VERSION };
    }

    const rootId = options.rootId || 'tab-analytics';
    const root = document.getElementById(rootId);
    if (!root) {
      return { initialized: false, ownsRendering: true, version: VERSION, missingRoot: rootId };
    }

    initialized = true;
    root.dataset.analyticsExternalReady = 'true';
    root.dataset.analyticsExternalVersion = VERSION;
    const events = new AbortController();
    const eventOptions = { signal: events.signal };

        // ────────────────────────────────────────────────────────
        // API client
        // ────────────────────────────────────────────────────────
        const API_ROOT = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:4111' : '';
        const baseParam = options.apiBase || '/dashboard';
        const API_BASE = baseParam.startsWith('http') ? baseParam : (API_ROOT + baseParam);

        async function fetchEndpoint(path, params = {}) {
          const qs = new URLSearchParams(params).toString();
          const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
          const res = await fetch(url);
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
          }
          return res.json();
        }

        // ────────────────────────────────────────────────────────
        // State + UI
        // ────────────────────────────────────────────────────────
        const state = {
          window: '7d',
          granularity: 'day',
          filters: {
            agentId: '',
            model: '',
            toolCategory: '',
            toolRisk: '',
            toolStatus: '',
          },
          traceFilters: {
            runId: '',
            taskId: '',
            threadId: '',
            status: '',
            limit: '25',
          },
          selectedTraceId: '',
          autoRefresh: false,
          autoRefreshTimer: null,
          charts: {},
        };

        function setStatus(text, kind = 'ok') {
          document.getElementById('statusText').textContent = text;
          const dot = document.getElementById('statusDot');
          dot.className = 'status-dot' + (kind === 'ok' ? '' : ' ' + kind);
        }

        function showError(msg) {
          document.getElementById('errorContainer').innerHTML =
            `<div class="error">⚠️ ${msg}</div>`;
        }
        function clearError() {
          document.getElementById('errorContainer').innerHTML = '';
        }

        function setLoadingState() {
          const loadingTargets = [
            'overviewCards',
            'analyticsAlerts',
            'modelFinopsCards',
            'latencySummaryCards',
            'toolsPolicyCards',
            'qualityCards',
            'traceListTable',
            'traceDetailPanel',
            'slowestRunsTable',
            'timelineAnnotationsTable',
            'skillsTable',
            'legacySkillsTable',
            'qualityScorersTable',
            'qualityFailuresTable',
            'qualityGapsTable',
            'toolsTable',
            'toolFailuresTable',
            'hangingToolsTable',
            'agentsTable',
            'modelsTable',
            'scoresTable',
          ];
          for (const id of loadingTargets) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div class="loading">Loading...</div>';
          }
        }

        function renderSectionError(ids, label, error) {
          const message = error?.message || String(error || 'Unknown error');
          const html = `<div class="error">${escapeHtml(label)} failed: ${escapeHtml(message)}</div>`;
          for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = html;
          }
        }

        async function settleEndpoint(promise) {
          try {
            return { ok: true, value: await promise };
          } catch (error) {
            console.error(error);
            return { ok: false, error };
          }
        }

        function readFiltersFromInputs() {
          state.filters = {
            agentId: valueOf('agentFilterInput'),
            model: valueOf('modelFilterInput'),
            toolCategory: valueOf('toolCategoryFilterInput'),
            toolRisk: valueOf('toolRiskFilter'),
            toolStatus: valueOf('toolStatusFilter'),
          };
          renderFilterSummary();
          return state.filters;
        }

        function valueOf(id) {
          const el = document.getElementById(id);
          return el ? String(el.value || '').trim() : '';
        }

        function buildParams(extra = {}) {
          const filters = readFiltersFromInputs();
          const params = { since: state.window, ...extra };
          for (const [key, value] of Object.entries(filters)) {
            if (value) params[key] = value;
          }
          return params;
        }

        function readTraceFiltersFromInputs() {
          state.traceFilters = {
            runId: valueOf('traceRunFilterInput'),
            taskId: valueOf('traceTaskFilterInput'),
            threadId: valueOf('traceThreadFilterInput'),
            status: valueOf('traceStatusFilter'),
            limit: valueOf('traceLimitSelect') || '25',
          };
          return state.traceFilters;
        }

        function buildTraceParams(extra = {}) {
          const params = buildParams(extra);
          const filters = readTraceFiltersFromInputs();
          for (const [key, value] of Object.entries(filters)) {
            if (value) params[key] = value;
          }
          return params;
        }

        function renderFilterSummary() {
          const el = document.getElementById('filterSummary');
          if (!el) return;
          const active = Object.entries(state.filters)
            .filter(([, value]) => value)
            .map(([key, value]) => `${filterLabel(key)}=${value}`);
          el.textContent = active.length ? active.join(' · ') : 'All data';
        }

        function filterLabel(key) {
          return ({
            agentId: 'agent',
            model: 'model',
            toolCategory: 'category',
            toolRisk: 'risk',
            toolStatus: 'status',
          })[key] || key;
        }

        function clearFilters() {
          for (const id of ['agentFilterInput', 'modelFilterInput', 'toolCategoryFilterInput', 'toolRiskFilter', 'toolStatusFilter']) {
            const el = document.getElementById(id);
            if (el) el.value = '';
          }
          readFiltersFromInputs();
          loadAll();
        }

        function clearTraceFilters() {
          for (const id of ['traceRunFilterInput', 'traceTaskFilterInput', 'traceThreadFilterInput', 'traceStatusFilter']) {
            const el = document.getElementById(id);
            if (el) el.value = '';
          }
          const limit = document.getElementById('traceLimitSelect');
          if (limit) limit.value = '25';
          state.selectedTraceId = '';
          readTraceFiltersFromInputs();
          loadAll();
        }

        // ────────────────────────────────────────────────────────
        // Drill-down helpers (alerts/timeline/tables → trace/filter)
        // ────────────────────────────────────────────────────────
        function setInputValue(id, value) {
          const el = document.getElementById(id);
          if (el) el.value = value || '';
        }

        function scrollToAnalyticsSection(id) {
          const el = id ? document.getElementById(id) : null;
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Build drill attributes for a clickable trace row. Returns '' when no id
        // is available so the row stays non-interactive.
        function traceDrillAttrs(ids = {}) {
          const runId = ids.runId || '';
          const taskId = ids.taskId || '';
          const threadId = ids.threadId || '';
          const eventId = ids.eventId || '';
          const traceId = ids.traceId || '';
          if (!(runId || taskId || threadId || eventId || traceId)) return '';
          return [
            'class="drill-row"',
            'data-drill="trace"',
            'title="Open in Trace Explorer"',
            runId ? `data-run-id="${escapeHtml(runId)}"` : '',
            taskId ? `data-task-id="${escapeHtml(taskId)}"` : '',
            threadId ? `data-thread-id="${escapeHtml(threadId)}"` : '',
            eventId ? `data-event-id="${escapeHtml(eventId)}"` : '',
            traceId ? `data-trace-id="${escapeHtml(traceId)}"` : '',
          ].filter(Boolean).join(' ');
        }

        async function loadTraceList() {
          try {
            const res = await fetchEndpoint('/v2/traces', buildTraceParams());
            renderTraces(res.data);
          } catch (err) {
            const el = document.getElementById('traceListTable');
            if (el) el.innerHTML = `<div class="error">${escapeHtml(err.message || String(err))}</div>`;
          }
        }

        // Open a specific run/task/thread in the Trace Explorer without
        // disturbing the global dashboard filters.
        async function focusTrace(ids = {}) {
          const runId = ids.runId || '';
          const taskId = ids.taskId || '';
          const threadId = ids.threadId || '';
          // Mirror backend trace-key precedence so the list row highlights.
          const direct = taskId || runId || threadId || ids.turnId || ids.traceId || ids.eventId || '';
          if (!direct) return;

          setInputValue('traceRunFilterInput', runId);
          setInputValue('traceTaskFilterInput', taskId);
          setInputValue('traceThreadFilterInput', threadId);
          setInputValue('traceStatusFilter', '');
          readTraceFiltersFromInputs();
          state.selectedTraceId = direct;

          scrollToAnalyticsSection('section-traces');
          await loadTraceList();
          await loadTraceDetail(direct);
        }

        // Re-scope the whole dashboard to a single agent / model.
        function applyAgentFilter(agentId) {
          if (!agentId) return;
          setInputValue('agentFilterInput', agentId);
          readFiltersFromInputs();
          scrollToAnalyticsSection('section-health');
          loadAll();
        }

        function applyModelFilter(model) {
          if (!model) return;
          setInputValue('modelFilterInput', model);
          readFiltersFromInputs();
          scrollToAnalyticsSection('section-agents');
          loadAll();
        }

        // Map an alert code to the section that explains it.
        function alertSectionFor(code) {
          const c = (code || '').toLowerCase();
          if (c.includes('scorer') || c.includes('coverage') || c.includes('quality') || c.includes('eval')) return 'section-quality';
          if (c.includes('hang') || c.includes('tool') || c.includes('block') || c.includes('risk') || c.includes('policy') || c.includes('approval')) return 'section-tools';
          if (c.includes('latency') || c.includes('p99') || c.includes('p95') || c.includes('slow')) return 'section-latency';
          if (c.includes('cost') || c.includes('pricing') || c.includes('token') || c.includes('model') || c.includes('spend')) return 'section-agents';
          return 'section-health';
        }

        function handleDrillClick(event) {
          const target = event.target instanceof Element ? event.target.closest('[data-drill]') : null;
          if (!target) return;
          // Ignore the Trace Explorer's own list buttons (handled separately).
          if (target.closest('#traceListTable')) return;
          const kind = target.getAttribute('data-drill');
          if (kind === 'trace') {
            focusTrace({
              runId: target.getAttribute('data-run-id') || '',
              taskId: target.getAttribute('data-task-id') || '',
              threadId: target.getAttribute('data-thread-id') || '',
              eventId: target.getAttribute('data-event-id') || '',
              traceId: target.getAttribute('data-trace-id') || '',
            });
          } else if (kind === 'agent') {
            applyAgentFilter(target.getAttribute('data-agent-id') || '');
          } else if (kind === 'model') {
            applyModelFilter(target.getAttribute('data-model-id') || '');
          } else if (kind === 'section') {
            scrollToAnalyticsSection(target.getAttribute('data-section') || 'section-health');
          }
        }

        function handleDrillKeydown(event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = event.target instanceof Element ? event.target.closest('[data-drill][tabindex]') : null;
          if (!target) return;
          event.preventDefault();
          handleDrillClick(event);
        }

        // ────────────────────────────────────────────────────────
        // Formatters
        // ────────────────────────────────────────────────────────
        const fmt = {
          usd: (n) => '$' + (n ?? 0).toFixed(4),
          pct: (n) => ((n ?? 0) * 100).toFixed(1) + '%',
          num: (n) => (n ?? 0).toLocaleString('en-US'),
          ms: (n) => Math.round(n ?? 0) + 'ms',
          duration: (ms) => {
            const v = Math.max(0, Math.round(ms ?? 0));
            if (v >= 86_400_000) return Math.round(v / 86_400_000) + 'd';
            if (v >= 3_600_000) return Math.round(v / 3_600_000) + 'h';
            if (v >= 60_000) return Math.round(v / 60_000) + 'm';
            return Math.round(v / 1000) + 's';
          },
          tokens: (n) => {
            const v = n ?? 0;
            if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
            if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k';
            return String(v);
          },
        };

        function fmtPctPoint(n) {
          return ((n ?? 0) * 100).toFixed(1) + 'pp';
        }

        function fmtScoreDelta(n) {
          return (n ?? 0).toFixed(2);
        }

        function formatSignedDelta(value, formatter) {
          const n = value ?? 0;
          if (Math.abs(n) < 0.000001) return formatter(0);
          return (n > 0 ? '+' : '-') + formatter(Math.abs(n));
        }

        function deltaClass(delta, lowerIsBetter = false) {
          if (!delta || delta.direction === 'flat' || Math.abs(delta.absolute ?? 0) < 0.000001) return 'flat';
          const improved = lowerIsBetter ? delta.direction === 'down' : delta.direction === 'up';
          return improved ? 'good' : 'bad';
        }

        function deltaBadge(delta, formatter = fmt.num, options = {}) {
          if (!delta) return '';
          const label = options.label || 'vs prev';
          return `<span class="analytics-delta ${deltaClass(delta, options.lowerIsBetter)}">${formatSignedDelta(delta.absolute, formatter)} ${label}</span>`;
        }

        function rateClass(rate) {
          if (rate >= 0.9) return 'green';
          if (rate >= 0.7) return 'yellow';
          return 'red';
        }

        // ────────────────────────────────────────────────────────
        // Chart helpers
        // ────────────────────────────────────────────────────────
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = '#334155';
        Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

        const COLORS = {
          green: '#22c55e',
          red: '#ef4444',
          blue: '#3b82f6',
          yellow: '#eab308',
          purple: '#a855f7',
          cyan: '#06b6d4',
          orange: '#f97316',
          pink: '#ec4899',
        };
        const PALETTE = Object.values(COLORS);

        function makeOrUpdate(id, type, data, options = {}) {
          const ctx = document.getElementById(id);
          if (!ctx) return;
          if (state.charts[id]) {
            state.charts[id].data = data;
            state.charts[id].options = { ...state.charts[id].options, ...options };
            state.charts[id].update();
          } else {
            state.charts[id] = new Chart(ctx, { type, data, options: {
              maintainAspectRatio: false,
              responsive: true,
              ...options,
            }});
          }
        }

        // ────────────────────────────────────────────────────────
        // Renderers
        // ────────────────────────────────────────────────────────
        function renderOverview(data) {
          const totals = data.totals ?? {};
          const rates = data.rates ?? {};
          const latency = data.latency ?? {};
          const deltas = data.compare?.deltas ?? {};
          const successClass = rateClass(rates.successRate);
          const errorClass = rates.toolFailureRate > 0.05 ? 'red' : rates.toolFailureRate > 0.02 ? 'yellow' : 'green';
          const coverageClass = rates.scorerCoverage >= 0.2 ? 'green' : rates.scorerCoverage > 0 ? 'yellow' : 'red';
          const html = `
            <div class="card metric">
              <div class="label">Tasks</div>
              <div class="value">${fmt.num(totals.tasks)}</div>
              <div class="delta">${fmt.num(totals.agents)} canonical agents · ${fmt.num(totals.models)} models ${deltaBadge(deltas.tasks, fmt.num)}</div>
            </div>
            <div class="card metric">
              <div class="label">Success Rate</div>
              <div class="value ${successClass}">${fmt.pct(rates.successRate)}</div>
              <div class="delta">${fmt.num(totals.failed)} task failures ${deltaBadge(deltas.successRate, fmtPctPoint)}</div>
            </div>
            <div class="card metric">
              <div class="label">Cost</div>
              <div class="value">${fmt.usd(totals.costUsd)}</div>
              <div class="delta">${fmt.tokens(totals.tokens)} tokens ${deltaBadge(deltas.costUsd, fmt.usd, { lowerIsBetter: true })}</div>
            </div>
            <div class="card metric">
              <div class="label">Latency P95</div>
              <div class="value">${fmt.ms(latency.p95Ms)}</div>
              <div class="delta">avg ${fmt.ms(latency.avgMs)} ${deltaBadge(deltas.p95LatencyMs, fmt.ms, { lowerIsBetter: true })}</div>
            </div>
            <div class="card metric">
              <div class="label">Tool Envelopes</div>
              <div class="value">${fmt.num(totals.toolExecutions)}</div>
              <div class="delta">failure rate <span class="pill ${errorClass}">${fmt.pct(rates.toolFailureRate)}</span> ${deltaBadge(deltas.toolFailureRate, fmtPctPoint, { lowerIsBetter: true })}</div>
            </div>
            <div class="card metric">
              <div class="label">Scorer Coverage</div>
              <div class="value ${coverageClass}">${fmt.pct(rates.scorerCoverage)}</div>
              <div class="delta">${fmt.num(totals.scorerEvaluations)} evaluations ${deltaBadge(deltas.scorerCoverage, fmtPctPoint)}</div>
            </div>
          `;
          document.getElementById('overviewCards').innerHTML = html;
        }

        function renderAlerts(alerts = []) {
          const el = document.getElementById('analyticsAlerts');
          if (!el) return;
          if (!alerts.length) {
            el.innerHTML = '<div class="analytics-alert info"><div><div class="analytics-alert-code">healthy</div><div class="analytics-alert-message">No active analytics alerts in this window.</div></div></div>';
            return;
          }
          el.innerHTML = alerts.map(alert => `
            <div class="analytics-alert drill-alert ${alert.severity || 'info'}" data-drill="section" data-section="${escapeHtml(alertSectionFor(alert.code))}" role="button" tabindex="0" title="Jump to the related section">
              <div>
                <div class="analytics-alert-code">${escapeHtml(alert.code || 'alert')}</div>
                <div class="analytics-alert-message">${escapeHtml(alert.message || '')}</div>
              </div>
              ${typeof alert.metric === 'number' ? `<div class="analytics-alert-metric">${formatAlertMetric(alert)}</div>` : ''}
            </div>
          `).join('');
        }

        function formatAlertMetric(alert) {
          if ((alert.code || '').includes('rate') || (alert.code || '').includes('coverage')) return fmt.pct(alert.metric);
          return fmt.num(alert.metric);
        }

        function renderAgentsChart(rows) {
          const top = rows
            .filter(r => r.entityKind === 'agent' || r.entityKind === 'plan' || r.entityKind === 'worker')
            .slice(0, 14);
          const labels = top.map(r => r.displayName || r.canonicalAgentId);
          const completed = top.map(r => r.completed);
          const failed = top.map(r => r.failed);
          makeOrUpdate('agentsChart', 'bar', {
            labels,
            datasets: [
              { label: 'Completed', data: completed, backgroundColor: COLORS.green },
              { label: 'Failed', data: failed, backgroundColor: COLORS.red },
            ],
          }, {
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
            plugins: { legend: { position: 'top' } },
          });
        }

        function renderAgentsTable(rows) {
          if (!rows.length) { document.getElementById('agentsTable').innerHTML = '<div class="empty">No data</div>'; return; }
          const html = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Agent</th>
                <th>Kind</th>
                <th class="num">Tasks</th>
                <th class="num">Success</th>
                <th class="num">Tool fail</th>
                <th class="num">Cost</th>
                <th class="num">P95 latency</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr class="drill-row" data-drill="agent" data-agent-id="${escapeHtml(r.canonicalAgentId)}" title="Filter dashboard by this agent">
                    <td>
                      <strong>${escapeHtml(r.displayName || r.canonicalAgentId)}</strong>
                      <div class="analytics-subtle">${escapeHtml((r.rawAgentIds || []).slice(0, 2).join(', '))}${(r.rawAgentIds || []).length > 2 ? ' +' + ((r.rawAgentIds || []).length - 2) : ''}</div>
                    </td>
                    <td><span class="pill gray">${escapeHtml(r.entityKind || 'agent')}</span></td>
                    <td class="num">${fmt.num(r.totalTasks)}</td>
                    <td class="num"><span class="pill ${rateClass(r.successRate)}">${fmt.pct(r.successRate)}</span></td>
                    <td class="num">${fmt.pct(r.toolFailureRate)}</td>
                    <td class="num">${fmt.usd(r.costUsd)}</td>
                    <td class="num">${fmt.ms(r.p95LatencyMs)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
          document.getElementById('agentsTable').innerHTML = html;
        }

        function renderModelsChart(rows) {
          const top = [...rows]
            .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0) || (b.invocations || 0) - (a.invocations || 0))
            .slice(0, 10);
          makeOrUpdate('modelsChart', 'bar', {
            labels: top.map(r => r.displayName || r.model),
            datasets: [
              { label: 'Cost USD', data: top.map(r => r.costUsd || 0), backgroundColor: COLORS.blue },
            ],
          }, {
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const row = top[ctx.dataIndex] || {};
                    return [
                      `Cost: ${fmt.usd(row.costUsd)}`,
                      `Tokens: ${fmt.tokens(row.totalTokens)}`,
                      `Calls: ${fmt.num(row.invocations)}`,
                    ];
                  },
                },
              },
            },
            scales: {
              x: { beginAtZero: true, ticks: { callback: (v) => '$' + Number(v).toFixed(2) } },
            },
          });
        }

        function renderModelFinopsCards(rows) {
          const el = document.getElementById('modelFinopsCards');
          if (!el) return;
          const totalCalls = rows.reduce((sum, row) => sum + (row.invocations || 0), 0);
          const totalCost = rows.reduce((sum, row) => sum + (row.costUsd || 0), 0);
          const totalTokens = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
          const zeroTokenCalls = rows.reduce((sum, row) => sum + (row.zeroTokenInvocations || 0), 0);
          const missingPricing = rows.filter(row => row.pricingStatus === 'missing_pricing').length;
          const aliasModels = rows.filter(row => row.pricingStatus === 'alias').length;
          const topCost = [...rows].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0];
          el.innerHTML = `
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Model Spend</div>
              <div class="analytics-signal-value">${fmt.usd(totalCost)}</div>
              <div class="analytics-signal-note">${fmt.tokens(totalTokens)} tokens across ${fmt.num(totalCalls)} calls</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Top Cost Driver</div>
              <div class="analytics-signal-value">${escapeHtml(topCost?.displayName || topCost?.model || '-')}</div>
              <div class="analytics-signal-note">${fmt.usd(topCost?.costUsd || 0)} · ${fmt.pct(topCost?.costShare || 0)} of spend</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Pricing Gaps</div>
              <div class="analytics-signal-value ${missingPricing > 0 ? 'red' : 'green'}">${fmt.num(missingPricing)}</div>
              <div class="analytics-signal-note">${fmt.num(aliasModels)} alias-normalized model groups</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Zero-token Calls</div>
              <div class="analytics-signal-value ${zeroTokenCalls > 0 ? 'yellow' : 'green'}">${fmt.num(zeroTokenCalls)}</div>
              <div class="analytics-signal-note">invocations that cannot explain cost or throughput</div>
            </div>
          `;
        }

        function renderModelsTable(rows) {
          if (!rows.length) { document.getElementById('modelsTable').innerHTML = '<div class="empty">No data</div>'; return; }
          const maxCost = Math.max(1, ...rows.map(r => r.costUsd || 0));
          const maxTokens = Math.max(1, ...rows.map(r => r.totalTokens || 0));
          const maxCalls = Math.max(1, ...rows.map(r => r.invocations || 0));
          const html = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Model</th>
                <th>Status</th>
                <th class="num">Calls</th>
                <th class="num">Tokens</th>
                <th class="num">Cost</th>
                <th class="num">$/1k tok</th>
                <th class="num">Errors</th>
                <th class="num">P95 latency</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr class="drill-row" data-drill="model" data-model-id="${escapeHtml(r.model)}" title="Filter dashboard by this model">
                    <td>
                      <div><strong>${escapeHtml(r.displayName || r.model)}</strong></div>
                      <div class="analytics-subtle">${escapeHtml(r.provider)} · ${escapeHtml((r.rawAliases || []).join(', '))}</div>
                    </td>
                    <td><span class="pill ${modelStatusClass(r.pricingStatus)}">${escapeHtml(r.pricingStatus || 'priced')}</span></td>
                    <td class="num">${barCell(fmt.num(r.invocations), (r.invocations || 0) / maxCalls, 'calls')}</td>
                    <td class="num">${barCell(fmt.tokens(r.totalTokens), (r.totalTokens || 0) / maxTokens, 'tokens')}</td>
                    <td class="num">${barCell(fmt.usd(r.costUsd), (r.costUsd || 0) / maxCost, 'cost')}</td>
                    <td class="num">${fmt.usd(r.costPer1kTokensUsd)}</td>
                    <td class="num"><span class="pill ${r.errorRate > 0.05 ? 'red' : r.errorRate > 0 ? 'yellow' : 'green'}">${fmt.pct(r.errorRate)}</span></td>
                    <td class="num">${fmt.ms(r.p95LatencyMs)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
          document.getElementById('modelsTable').innerHTML = html;
        }

        function modelStatusClass(status) {
          if (status === 'priced') return 'green';
          if (status === 'alias' || status === 'zero_tokens') return 'yellow';
          return 'red';
        }

        function barCell(label, ratio, kind) {
          const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
          return `
            <div class="analytics-bar-cell">
              <span>${label}</span>
              <div class="analytics-bar-track"><div class="analytics-bar-fill ${kind || ''}" style="width:${pct}%"></div></div>
            </div>
          `;
        }

        function renderCostChart(data) {
          const days = Array.isArray(data?.byDay)
            ? data.byDay
            : (data?.buckets || []).map(bucket => ({
                date: formatBucketLabel(bucket.bucket, data?.granularity),
                usd: bucket.costUsd || 0,
              }));
          makeOrUpdate('costChart', 'line', {
            labels: days.map(d => d.date),
            datasets: [{
              label: 'USD',
              data: days.map(d => d.usd),
              borderColor: COLORS.blue,
              backgroundColor: COLORS.blue + '33',
              fill: true,
              tension: 0.3,
            }],
          }, {
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (ctx) => fmt.usd(ctx.parsed.y) } },
            },
            scales: { y: { beginAtZero: true, ticks: { callback: (v) => '$' + v.toFixed(2) } } },
          });
        }

        function renderLatencyChart(data) {
          const rows = data?.byAgent || [];
          const top = rows.slice(0, 12);
          makeOrUpdate('latencyChart', 'bar', {
            labels: top.map(r => r.displayName || r.canonicalAgentId),
            datasets: [
              { label: 'P50', data: top.map(r => r.p50Ms || 0), backgroundColor: COLORS.green },
              { label: 'P95', data: top.map(r => r.p95Ms || 0), backgroundColor: COLORS.yellow },
              { label: 'P99', data: top.map(r => r.p99Ms || 0), backgroundColor: COLORS.red },
            ],
          }, {
            scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + 'ms' } } },
            plugins: { legend: { position: 'top' } },
          });
        }

        function renderLatencySummary(data) {
          const el = document.getElementById('latencySummaryCards');
          if (!el) return;
          const overall = data?.overall || {};
          el.innerHTML = `
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Latency Samples</div>
              <div class="analytics-signal-value">${fmt.num(overall.samples || 0)}</div>
              <div class="analytics-signal-note">events with durationMs in this window</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">P50 / P95</div>
              <div class="analytics-signal-value">${fmt.ms(overall.p50Ms)} / ${fmt.ms(overall.p95Ms)}</div>
              <div class="analytics-signal-note">median versus operational tail</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">P99 / Max</div>
              <div class="analytics-signal-value ${overall.p99ToP50Ratio > 10 ? 'red' : overall.p99ToP50Ratio > 5 ? 'yellow' : 'green'}">${fmt.ms(overall.p99Ms)} / ${fmt.ms(overall.maxMs)}</div>
              <div class="analytics-signal-note">p99/p50 ratio ${overall.p99ToP50Ratio || 0}x</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Long-tail Risk</div>
              <div class="analytics-signal-value ${overall.p99ToP50Ratio > 10 ? 'red' : overall.p99ToP50Ratio > 5 ? 'yellow' : 'green'}">${overall.p99ToP50Ratio || 0}x</div>
              <div class="analytics-signal-note">higher means unstable tail latency</div>
            </div>
          `;
        }

        function renderSlowestRunsTable(data) {
          const el = document.getElementById('slowestRunsTable');
          if (!el) return;
          const rows = data?.slowest || [];
          if (!rows.length) {
            el.innerHTML = '<div class="empty">No latency samples in this window</div>';
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Event</th>
                <th>Agent</th>
                <th>Trace</th>
                <th class="num">Duration</th>
                <th>Model</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr ${traceDrillAttrs(r)}>
                    <td>
                      <strong>${escapeHtml(r.type || 'event')}</strong>
                      <div class="analytics-subtle">${escapeHtml(formatTimestamp(r.timestamp))}</div>
                      ${r.errorMessage ? `<div class="analytics-subtle">${escapeHtml(r.errorMessage).slice(0, 160)}</div>` : ''}
                    </td>
                    <td>${escapeHtml(r.agentId || 'unknown')}</td>
                    <td>
                      <div>${escapeHtml(shortId(r.runId || r.taskId || r.threadId || r.eventId))}</div>
                      <div class="analytics-subtle">${escapeHtml(r.taskId ? 'task ' + shortId(r.taskId) : r.threadId ? 'thread ' + shortId(r.threadId) : '')}</div>
                    </td>
                    <td class="num"><span class="pill ${r.durationMs > 60000 ? 'red' : r.durationMs > 15000 ? 'yellow' : 'green'}">${fmt.ms(r.durationMs)}</span></td>
                    <td>${escapeHtml(r.model || '-')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function shortId(value) {
          const text = String(value || '');
          return text.length > 14 ? text.slice(0, 14) : text;
        }

        function formatTimestamp(value) {
          if (!value) return '-';
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return String(value);
          return date.toLocaleString();
        }

        function renderTimelineChart(data) {
          const rows = Array.isArray(data) ? data : (data?.buckets || []);
          const labels = rows.map(r => formatBucketLabel(r.bucket, data?.granularity));
          makeOrUpdate('timelineChart', 'bar', {
            labels,
            datasets: [
              {
                label: 'Completed',
                data: rows.map(r => (r.taskCompleted || 0) + (r.runsCompleted || 0)),
                backgroundColor: COLORS.green,
                stack: 'events',
                yAxisID: 'y',
              },
              {
                label: 'Failed',
                data: rows.map(r => (r.taskFailed || 0) + (r.runsFailed || 0)),
                backgroundColor: COLORS.red,
                stack: 'events',
                yAxisID: 'y',
              },
              {
                label: 'Tool failed/blocked',
                data: rows.map(r => (r.toolFailed || 0) + (r.toolBlocked || 0)),
                backgroundColor: COLORS.orange,
                stack: 'events',
                yAxisID: 'y',
              },
              {
                type: 'line',
                label: 'Cost USD',
                data: rows.map(r => r.costUsd || 0),
                borderColor: COLORS.blue,
                backgroundColor: COLORS.blue + '33',
                pointRadius: 2,
                tension: 0.25,
                yAxisID: 'yCost',
              },
              {
                type: 'line',
                label: 'P95 latency sec',
                data: rows.map(r => Math.round((r.p95LatencyMs || 0) / 1000)),
                borderColor: COLORS.purple,
                backgroundColor: COLORS.purple + '33',
                borderDash: [4, 4],
                pointRadius: 2,
                tension: 0.25,
                yAxisID: 'yLatency',
              },
            ],
          }, {
            plugins: {
              legend: { position: 'top' },
              tooltip: {
                callbacks: {
                  afterBody: (items) => {
                    const row = rows[items[0]?.dataIndex] || {};
                    return [
                      `tokens ${fmt.tokens(row.tokens || 0)}`,
                      `approval gates ${fmt.num(row.approvalGates || 0)}`,
                      `policy blocks ${fmt.num(row.policyBlocked || 0)}`,
                    ];
                  },
                },
              },
            },
            scales: {
              x: { stacked: true },
              y: { stacked: true, beginAtZero: true, title: { display: true, text: 'events' } },
              yCost: {
                beginAtZero: true,
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { callback: (v) => '$' + Number(v).toFixed(2) },
              },
              yLatency: {
                beginAtZero: true,
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { callback: (v) => Number(v).toFixed(0) + 's' },
              },
            },
          });
        }

        function renderTimelineAnnotations(data) {
          const el = document.getElementById('timelineAnnotationsTable');
          if (!el) return;
          const rows = (data?.annotations || [])
            .slice()
            .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || b.count - a.count || b.bucket.localeCompare(a.bucket))
            .slice(0, 20);

          if (!rows.length) {
            el.innerHTML = '<div class="empty">No timeline annotations in this window</div>';
            return;
          }

          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Annotation</th>
                <th>Bucket</th>
                <th class="num">Count</th>
                <th>Sample</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr ${traceDrillAttrs({ traceId: r.traceId })}>
                    <td>
                      <strong>${escapeHtml(r.label || r.type)}</strong>
                      <div class="analytics-subtle"><span class="pill ${annotationClass(r.severity)}">${escapeHtml(r.severity || 'info')}</span> ${escapeHtml(r.type || '')}</div>
                    </td>
                    <td>${escapeHtml(formatBucketLabel(r.bucket, data?.granularity))}</td>
                    <td class="num">${fmt.num(r.count)}</td>
                    <td>${escapeHtml(r.sample || '-').slice(0, 180)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function severityWeight(severity) {
          if (severity === 'critical') return 3;
          if (severity === 'warning') return 2;
          return 1;
        }

        function annotationClass(severity) {
          if (severity === 'critical') return 'red';
          if (severity === 'warning') return 'yellow';
          return 'gray';
        }

        function formatBucketLabel(value, granularity) {
          if (!value) return '-';
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return String(value);
          if (granularity === 'hour') {
            return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          }
          return date.toISOString().slice(0, 10);
        }

        function renderSkillsChart(rows) {
          const top = Array.isArray(rows)
            ? rows.slice(0, 10).map(r => ({ label: r.skillId, count: r.uses, failed: 0, blocked: 0 }))
            : (rows.byOperation || []).slice(0, 10).map(r => ({
                label: `skill_${r.operation}`,
                count: r.count,
                failed: r.failed,
                blocked: r.blocked,
              }));
          if (!top.length) {
            makeOrUpdate('skillsChart', 'bar', {
              labels: ['No skill operations'],
              datasets: [{ label: 'Operations', data: [0], backgroundColor: COLORS.purple }],
            }, {
              indexAxis: 'y',
              plugins: { legend: { display: false } },
              scales: { x: { beginAtZero: true } },
            });
            return;
          }
          makeOrUpdate('skillsChart', 'bar', {
            labels: top.map(r => r.label),
            datasets: [
              { label: 'Completed/other', data: top.map(r => Math.max(0, r.count - r.failed - r.blocked)), backgroundColor: COLORS.purple },
              { label: 'Failed', data: top.map(r => r.failed), backgroundColor: COLORS.red },
              { label: 'Blocked', data: top.map(r => r.blocked), backgroundColor: COLORS.yellow },
            ],
          }, {
            indexAxis: 'y',
            plugins: { legend: { position: 'top' } },
            scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } },
          });
        }

        function renderSkillsDetails(data) {
          const operations = Array.isArray(data) ? [] : (data.byOperation || []);
          const tools = Array.isArray(data) ? [] : (data.topSkillTools || []);
          const legacy = Array.isArray(data) ? data : (data.legacySkillUsed || []);

          const skillsTable = document.getElementById('skillsTable');
          if (skillsTable) {
            if (!tools.length && !operations.length) {
              skillsTable.innerHTML = '<div class="empty">No skill operation envelopes in this window</div>';
            } else {
              const rows = tools.length
                ? tools
                : operations.map(r => ({
                    toolId: `skill_${r.operation}`,
                    count: r.count,
                    failed: r.failed,
                    blocked: r.blocked,
                    failureRate: r.count > 0 ? (r.failed + r.blocked) / r.count : 0,
                    avgDurationMs: r.avgDurationMs,
                  }));
              skillsTable.innerHTML = `
                <div class="table-wrap"><table>
                  <thead><tr>
                    <th>Skill tool</th>
                    <th class="num">Ops</th>
                    <th class="num">Failed</th>
                    <th class="num">Blocked</th>
                    <th class="num">Failure rate</th>
                    <th class="num">Avg duration</th>
                  </tr></thead>
                  <tbody>
                    ${rows.map(r => `
                      <tr>
                        <td><strong>${escapeHtml(r.toolId)}</strong></td>
                        <td class="num">${fmt.num(r.count)}</td>
                        <td class="num">${fmt.num(r.failed)}</td>
                        <td class="num">${fmt.num(r.blocked)}</td>
                        <td class="num"><span class="pill ${r.failureRate > 0.1 ? 'red' : r.failureRate > 0.03 ? 'yellow' : 'green'}">${fmt.pct(r.failureRate)}</span></td>
                        <td class="num">${fmt.ms(r.avgDurationMs)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table></div>
              `;
            }
          }

          const legacyTable = document.getElementById('legacySkillsTable');
          if (!legacyTable) return;
          if (!legacy.length) {
            legacyTable.innerHTML = '<div class="empty">No legacy skill_used events. Skill coverage is currently inferred from tool envelopes.</div>';
            return;
          }
          legacyTable.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Skill</th>
                <th class="num">Uses</th>
                <th>Agents</th>
              </tr></thead>
              <tbody>
                ${legacy.map(r => `
                  <tr>
                    <td><strong>${escapeHtml(r.skillId)}</strong></td>
                    <td class="num">${fmt.num(r.uses)}</td>
                    <td>${escapeHtml((r.agents || []).slice(0, 3).join(', '))}${(r.agents || []).length > 3 ? ' +' + ((r.agents || []).length - 3) : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderScoresTable(rows) {
          if (!rows.length) {
            document.getElementById('scoresTable').innerHTML =
              '<div class="empty">No scorer evaluations in this window. This is a quality coverage gap, not a healthy signal.</div>';
            return;
          }
          const html = `
            <table>
              <thead><tr>
                <th>Scorer</th>
                <th class="num">N</th>
                <th class="num">Avg score</th>
                <th class="num">Pass rate</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td><strong>${r.scorerId}</strong></td>
                    <td class="num">${fmt.num(r.totalEvaluations)}</td>
                    <td class="num"><span class="pill ${rateClass(r.avgScore)}">${(r.avgScore ?? 0).toFixed(2)}</span></td>
                    <td class="num">${fmt.pct(r.passRate)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `;
          document.getElementById('scoresTable').innerHTML = html;
        }

        function renderQuality(data) {
          if (!data) return;
          renderQualityCards(data);
          renderQualityDistributionChart(data);
          renderQualityCoverageChart(data);
          renderQualityScorersTable(data);
          renderQualityFailuresTable(data);
          renderQualityGapsTable(data);
        }

        function renderQualityCards(data) {
          const el = document.getElementById('qualityCards');
          if (!el) return;
          const totals = data.totals || {};
          const coverage = data.coverage || {};
          const outcome = data.outcome || {};
          const gaps = data.coverageGaps || [];
          const trend = data.trend || {};
          el.innerHTML = `
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Task Coverage</div>
              <div class="analytics-signal-value ${qualityCoverageClass(coverage.taskCoverage)}">${fmt.pct(coverage.taskCoverage)}</div>
              <div class="analytics-signal-note">${fmt.num(totals.scoredTasks)} scored of ${fmt.num(totals.tasks)} tasks ${deltaBadge(trend.taskCoverage, fmtPctPoint)}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Pass Rate</div>
              <div class="analytics-signal-value ${qualityRateClass(outcome.passRate)}">${fmt.pct(outcome.passRate)}</div>
              <div class="analytics-signal-note">${fmt.num(outcome.passed)} passed · ${fmt.num(outcome.failed)} failed ${deltaBadge(trend.passRate, fmtPctPoint)}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Avg Score</div>
              <div class="analytics-signal-value ${qualityRateClass(outcome.avgScore)}">${(outcome.avgScore || 0).toFixed(2)}</div>
              <div class="analytics-signal-note">${fmt.num(outcome.evaluated)} normalized quality evaluations ${deltaBadge(trend.avgScore, fmtScoreDelta)}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Quality Sources</div>
              <div class="analytics-signal-value">${fmt.num((totals.nativeScorerRecords || 0) + (totals.outputScoreEvents || 0) + (totals.goalEvaluations || 0))}</div>
              <div class="analytics-signal-note">native ${fmt.num(totals.nativeScorerRecords)} · output ${fmt.num(totals.outputScoreEvents)} · goal ${fmt.num(totals.goalEvaluations)} ${deltaBadge(trend.evaluated, fmt.num)}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Coverage Gaps</div>
              <div class="analytics-signal-value ${gaps.length ? 'yellow' : 'green'}">${fmt.num(gaps.length)}</div>
              <div class="analytics-signal-note">agents below 20% quality coverage</div>
            </div>
          `;
        }

        function renderQualityDistributionChart(data) {
          const rows = data.distribution || [];
          makeOrUpdate('qualityDistributionChart', 'bar', {
            labels: rows.map(r => r.bucket),
            datasets: [{
              label: 'Evaluations',
              data: rows.map(r => r.count),
              backgroundColor: rows.map(r => r.bucket === '0.7-1.0' ? COLORS.green : r.bucket === '0.3-0.7' ? COLORS.yellow : COLORS.red),
            }],
          }, {
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } },
          });
        }

        function renderQualityCoverageChart(data) {
          const rows = [...(data.byAgent || [])]
            .filter(r => (r.tasks || 0) > 0)
            .sort((a, b) => (a.coverage || 0) - (b.coverage || 0) || (b.tasks || 0) - (a.tasks || 0))
            .slice(0, 12);

          if (!rows.length) {
            makeOrUpdate('qualityCoverageChart', 'bar', {
              labels: ['No task coverage data'],
              datasets: [{ label: 'Coverage', data: [0], backgroundColor: COLORS.yellow }],
            }, {
              indexAxis: 'y',
              plugins: { legend: { display: false } },
              scales: { x: { beginAtZero: true, max: 1, ticks: { callback: (v) => fmt.pct(Number(v)) } } },
            });
            return;
          }

          makeOrUpdate('qualityCoverageChart', 'bar', {
            labels: rows.map(r => r.agentId),
            datasets: [{
              label: 'Coverage',
              data: rows.map(r => r.coverage || 0),
              backgroundColor: rows.map(r => qualityColor(r.coverage || 0)),
            }],
          }, {
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const row = rows[ctx.dataIndex] || {};
                    return `${fmt.pct(row.coverage)} · ${fmt.num(row.scoredTasks)} / ${fmt.num(row.tasks)} tasks scored`;
                  },
                },
              },
            },
            scales: { x: { beginAtZero: true, max: 1, ticks: { callback: (v) => fmt.pct(Number(v)) } } },
          });
        }

        function renderQualityScorersTable(data) {
          const el = document.getElementById('qualityScorersTable');
          if (!el) return;
          const rows = data.scorerSummaries || [];
          if (!rows.length) {
            el.innerHTML = '<div class="empty">No quality evaluations in this window</div>';
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Scorer / eval</th>
                <th>Source</th>
                <th class="num">N</th>
                <th class="num">Avg</th>
                <th class="num">Pass</th>
                <th class="num">High</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td><strong>${escapeHtml(r.scorerId)}</strong></td>
                    <td><span class="pill gray">${escapeHtml(r.source)}</span></td>
                    <td class="num">${fmt.num(r.totalEvaluations)}</td>
                    <td class="num"><span class="pill ${qualityRateClass(r.avgScore)}">${(r.avgScore || 0).toFixed(2)}</span></td>
                    <td class="num">${fmt.pct(r.passRate)}</td>
                    <td class="num">${barCell(fmt.num(r.high || 0), (r.totalEvaluations || 0) > 0 ? (r.high || 0) / r.totalEvaluations : 0, 'quality')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderQualityFailuresTable(data) {
          const el = document.getElementById('qualityFailuresTable');
          if (!el) return;
          const rows = data.recentFailures || [];
          if (!rows.length) {
            el.innerHTML = data.outcome?.evaluated
              ? '<div class="empty">No failed quality evaluations in this window</div>'
              : '<div class="empty">No quality evaluations in this window</div>';
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Failure</th>
                <th>Agent / task</th>
                <th class="num">Score</th>
                <th>Reason</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr ${traceDrillAttrs({ taskId: r.taskId })}>
                    <td>
                      <strong>${escapeHtml(r.scorerId || r.source)}</strong>
                      <div class="analytics-subtle">${escapeHtml(r.source)} · ${escapeHtml(formatTimestamp(r.timestamp))}</div>
                    </td>
                    <td>
                      ${escapeHtml(r.agentId || 'unknown')}
                      <div class="analytics-subtle">${escapeHtml(shortId(r.taskId || '-'))}</div>
                    </td>
                    <td class="num"><span class="pill ${qualityRateClass(r.score || 0)}">${(r.score || 0).toFixed(2)}</span></td>
                    <td>${escapeHtml(r.reason || '-').slice(0, 180)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderQualityGapsTable(data) {
          const el = document.getElementById('qualityGapsTable');
          if (!el) return;
          const rows = data.coverageGaps || [];
          if (!rows.length) {
            el.innerHTML = '<div class="empty">No agents below 20% quality coverage in this window</div>';
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Agent</th>
                <th class="num">Tasks</th>
                <th class="num">Scored</th>
                <th class="num">Coverage</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td><strong>${escapeHtml(r.agentId)}</strong></td>
                    <td class="num">${fmt.num(r.tasks)}</td>
                    <td class="num">${fmt.num(r.scoredTasks)}</td>
                    <td class="num"><span class="pill ${qualityCoverageClass(r.coverage)}">${fmt.pct(r.coverage)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function qualityRateClass(rate) {
          if ((rate || 0) >= 0.8) return 'green';
          if ((rate || 0) >= 0.5) return 'yellow';
          return 'red';
        }

        function qualityCoverageClass(rate) {
          if ((rate || 0) >= 0.4) return 'green';
          if ((rate || 0) > 0) return 'yellow';
          return 'red';
        }

        function qualityColor(rate) {
          if ((rate || 0) >= 0.4) return COLORS.green;
          if ((rate || 0) > 0) return COLORS.yellow;
          return COLORS.red;
        }

        // ────────────────────────────────────────────────────────
        // Code Graph Trend (Graphify Phase 2, Stream C)
        // Source: src/mastra/graphify-out/trend.jsonl — one entry per graph
        // refresh (git commit/merge), no time-window filter (whatever history
        // has accumulated on disk).
        // ────────────────────────────────────────────────────────
        function renderCodeGraph(data) {
          if (!data) return;
          renderCodeGraphCards(data);
          renderCodeGraphTrendChart(data);
          renderCodeGraphHubsTable(data);
        }

        function renderCodeGraphCards(data) {
          const el = document.getElementById('codeGraphCards');
          if (!el) return;
          const latest = data.latest;
          const earliest = data.earliest;
          if (!latest) {
            el.innerHTML = '<div class="empty">No graph trend data yet — trend.jsonl is written on the next commit/merge.</div>';
            return;
          }
          const spanDays = earliest && earliest.date !== latest.date
            ? Math.round((new Date(latest.date) - new Date(earliest.date)) / 86_400_000)
            : 0;
          el.innerHTML = `
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Nodes</div>
              <div class="analytics-signal-value">${fmt.num(latest.nodes)}</div>
              <div class="analytics-signal-note">as of ${escapeHtml(latest.date)}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Edges</div>
              <div class="analytics-signal-value">${fmt.num(latest.links)}</div>
              <div class="analytics-signal-note">${escapeHtml(latest.commit.slice(0, 7))}</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Communities</div>
              <div class="analytics-signal-value">${fmt.num(latest.communities)}</div>
              <div class="analytics-signal-note">clustered modules</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Tracked Since</div>
              <div class="analytics-signal-value">${spanDays > 0 ? spanDays + 'd' : '—'}</div>
              <div class="analytics-signal-note">${data.entries.length} snapshot${data.entries.length === 1 ? '' : 's'} recorded</div>
            </div>
          `;
        }

        function renderCodeGraphTrendChart(data) {
          const rows = data.entries || [];
          if (!rows.length) return;
          makeOrUpdate('codeGraphTrendChart', 'line', {
            labels: rows.map(r => r.date),
            datasets: [
              {
                label: 'Nodes',
                data: rows.map(r => r.nodes),
                borderColor: COLORS.blue,
                backgroundColor: COLORS.blue + '33',
                pointRadius: 2,
                tension: 0.25,
                yAxisID: 'y',
              },
              {
                label: 'Edges',
                data: rows.map(r => r.links),
                borderColor: COLORS.purple,
                backgroundColor: COLORS.purple + '33',
                pointRadius: 2,
                tension: 0.25,
                yAxisID: 'yLinks',
              },
            ],
          }, {
            plugins: { legend: { position: 'top' } },
            scales: {
              y: { position: 'left', beginAtZero: false, title: { display: true, text: 'Nodes' } },
              yLinks: { position: 'right', beginAtZero: false, grid: { drawOnChartArea: false }, title: { display: true, text: 'Edges' } },
            },
          });
        }

        function renderCodeGraphHubsTable(data) {
          const el = document.getElementById('codeGraphHubsTable');
          if (!el) return;
          const rows = data.fastestGrowingHubs || [];
          if (!rows.length) {
            el.innerHTML = '<div class="empty">Not enough history yet to compute growth (need at least two tracked snapshots).</div>';
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>File / Symbol</th>
                <th class="num">Before</th>
                <th class="num">Now</th>
                <th class="num">Δ</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td><strong>${escapeHtml(r.label)}</strong></td>
                    <td class="num">${fmt.num(r.edgesBefore)}</td>
                    <td class="num">${fmt.num(r.edgesNow)}</td>
                    <td class="num"><span class="pill ${r.delta > 0 ? 'green' : 'gray'}">${r.delta > 0 ? '+' : ''}${fmt.num(r.delta)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderTraces(data) {
          const rows = data?.traces || [];
          renderTraceList(rows, data?.hasMore);
          const selectedExists = rows.some(row => row.traceId === state.selectedTraceId);
          if (!selectedExists) state.selectedTraceId = rows[0]?.traceId || '';
          renderTraceListSelection();
          updateTraceMeta(rows.length, data?.hasMore);
        }

        function renderTraceList(rows, hasMore = false) {
          const el = document.getElementById('traceListTable');
          if (!el) return;
          if (!rows.length) {
            el.innerHTML = '<div class="empty">No traces match the current filters.</div>';
            renderTraceDetail(null);
            return;
          }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Trace</th>
                <th>Status</th>
                <th>Agent</th>
                <th class="num">Events</th>
                <th class="num">Tools</th>
                <th class="num">Latency</th>
              </tr></thead>
              <tbody>
                ${rows.map(row => `
                  <tr class="trace-row" data-trace-row="${escapeHtml(row.traceId)}">
                    <td>
                      <button type="button" class="trace-id-button" data-trace-id="${escapeHtml(row.traceId)}">${escapeHtml(shortId(row.traceId))}</button>
                      <div class="analytics-subtle">${escapeHtml(formatTimestamp(row.updatedAt))}</div>
                      ${row.firstError ? `<div class="analytics-subtle">${escapeHtml(row.firstError).slice(0, 120)}</div>` : ''}
                    </td>
                    <td><span class="pill ${traceStatusClass(row.status)}">${escapeHtml(row.status || 'unknown')}</span></td>
                    <td>${escapeHtml(row.agentId || 'unknown')}</td>
                    <td class="num">${fmt.num(row.eventCount || 0)}</td>
                    <td class="num">${fmt.num(row.toolExecutions || 0)}</td>
                    <td class="num">${fmt.ms(row.latencyMs || 0)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
            ${hasMore ? '<div class="analytics-subtle">More traces are available; increase the limit or narrow filters.</div>' : ''}
          `;
        }

        async function loadTraceDetail(traceId) {
          if (!traceId) {
            renderTraceDetail(null);
            return;
          }
          state.selectedTraceId = traceId;
          renderTraceListSelection();
          const panel = document.getElementById('traceDetailPanel');
          if (panel) panel.innerHTML = '<div class="loading">Loading trace detail...</div>';
          try {
            const res = await fetchEndpoint(`/v2/traces/${encodeURIComponent(traceId)}`, buildTraceParams());
            renderTraceDetail(res.data);
            updateTraceMeta(undefined, undefined, traceId);
          } catch (err) {
            if (panel) panel.innerHTML = `<div class="error">${escapeHtml(err.message || String(err))}</div>`;
          }
        }

        function renderTraceDetail(detail) {
          const el = document.getElementById('traceDetailPanel');
          if (!el) return;
          if (!detail) {
            el.innerHTML = '<div class="empty">Select a trace to inspect events, tool envelopes and scorer outcomes.</div>';
            return;
          }
          const summary = detail.summary || {};
          el.innerHTML = `
            <div class="trace-detail-grid">
              ${traceKv('Trace', shortId(summary.traceId))}
              ${traceKv('Status', `<span class="pill ${traceStatusClass(summary.status)}">${escapeHtml(summary.status || 'unknown')}</span>`, true)}
              ${traceKv('Agent', summary.agentId || 'unknown')}
              ${traceKv('Model', summary.model || '-')}
              ${traceKv('Cost', fmt.usd(summary.costUsd || 0))}
              ${traceKv('Latency', fmt.ms(summary.latencyMs || 0))}
            </div>
            ${summary.firstError ? `<div class="analytics-alert warning"><div><div class="analytics-alert-code">trace_error</div><div class="analytics-alert-message">${escapeHtml(summary.firstError)}</div></div></div>` : ''}
            <div class="chart-title">Events</div>
            ${renderTraceEvents(detail.events || [])}
            <div class="chart-title trace-section-title">Tool Envelopes</div>
            ${renderTraceTools(detail.tools || [])}
            <div class="chart-title trace-section-title">Scores</div>
            ${renderTraceScores(detail.scores || [])}
          `;
        }

        function traceKv(key, value, raw = false) {
          return `
            <div class="trace-detail-kv">
              <div class="k">${escapeHtml(key)}</div>
              <div class="v">${raw ? value : escapeHtml(value)}</div>
            </div>
          `;
        }

        function renderTraceEvents(events) {
          if (!events.length) return '<div class="empty">No events for this trace.</div>';
          return `<div class="trace-event-list">
            ${events.slice(0, 80).map(event => `
              <div class="trace-event-card ${traceEventClass(event)}">
                <div class="trace-event-head">
                  <div class="trace-event-title">${escapeHtml(event.type || 'event')}</div>
                  <div class="trace-event-time">${escapeHtml(formatTimestamp(event.timestamp))}</div>
                </div>
                <div class="trace-event-meta">
                  ${escapeHtml(event.agentId || 'unknown')}
                  ${event.model ? ` · ${escapeHtml(event.model)}` : ''}
                  ${event.durationMs ? ` · ${fmt.ms(event.durationMs)}` : ''}
                  ${event.toolId ? ` · ${escapeHtml(event.toolId)}` : ''}
                </div>
                <div class="trace-preview">
                  ${escapeHtml([
                    event.runId ? `run ${shortId(event.runId)}` : '',
                    event.taskId ? `task ${shortId(event.taskId)}` : '',
                    event.threadId ? `thread ${shortId(event.threadId)}` : '',
                  ].filter(Boolean).join(' · ') || event.eventId || '')}
                </div>
                ${event.errorMessage ? `<div class="trace-preview">${escapeHtml(event.errorMessage)}</div>` : ''}
              </div>
            `).join('')}
          </div>`;
        }

        function renderTraceTools(tools) {
          if (!tools.length) return '<div class="empty">No tool envelopes linked to this trace.</div>';
          return `<div class="trace-event-list">
            ${tools.slice(0, 50).map(tool => `
              <div class="trace-event-card ${tool.status === 'failed' || tool.status === 'blocked' ? 'failed' : ''}">
                <div class="trace-event-head">
                  <div class="trace-event-title">${escapeHtml(tool.toolId || 'tool')}</div>
                  <div class="trace-event-time">${escapeHtml(formatTimestamp(tool.createdAt))}</div>
                </div>
                <div class="trace-event-meta">
                  <span class="pill ${traceToolStatusClass(tool.status)}">${escapeHtml(tool.status || 'unknown')}</span>
                  ${escapeHtml(tool.category || 'other')} · ${escapeHtml(tool.risk || 'unknown')}
                  ${tool.durationMs ? ` · ${fmt.ms(tool.durationMs)}` : ''}
                </div>
                ${tool.errorMessage || tool.errorClass ? `<div class="trace-preview">${escapeHtml(tool.errorMessage || tool.errorClass)}</div>` : ''}
                ${tool.inputPreview ? `<div class="trace-preview"><strong>Input:</strong> ${escapeHtml(tool.inputPreview)}</div>` : ''}
                ${tool.outputPreview ? `<div class="trace-preview"><strong>Output:</strong> ${escapeHtml(tool.outputPreview)}</div>` : ''}
                ${tool.outputArtifactId ? `<div class="trace-preview">artifact ${escapeHtml(shortId(tool.outputArtifactId))}</div>` : ''}
              </div>
            `).join('')}
          </div>`;
        }

        function renderTraceScores(scores) {
          if (!scores.length) return '<div class="empty">No scorer outcomes linked to this trace.</div>';
          return `<div class="trace-event-list">
            ${scores.slice(0, 50).map(score => `
              <div class="trace-event-card ${score.passed ? '' : 'failed'}">
                <div class="trace-event-head">
                  <div class="trace-event-title">${escapeHtml(score.scorerId || score.source || 'score')}</div>
                  <div class="trace-event-time">${escapeHtml(formatTimestamp(score.timestamp))}</div>
                </div>
                <div class="trace-event-meta">
                  <span class="pill ${score.passed ? 'green' : 'red'}">${score.passed ? 'passed' : 'failed'}</span>
                  ${score.score === undefined ? '' : ` score ${(score.score || 0).toFixed(2)}`}
                  ${score.agentId ? ` · ${escapeHtml(score.agentId)}` : ''}
                </div>
                ${score.reason ? `<div class="trace-preview">${escapeHtml(score.reason)}</div>` : ''}
              </div>
            `).join('')}
          </div>`;
        }

        function renderTraceListSelection() {
          document.querySelectorAll('#traceListTable .trace-row').forEach(row => {
            row.classList.toggle('active', row.getAttribute('data-trace-row') === state.selectedTraceId);
          });
        }

        function updateTraceMeta(count, hasMore, selectedTraceId = state.selectedTraceId) {
          const el = document.getElementById('traceExplorerMeta');
          if (!el) return;
          const parts = [];
          if (typeof count === 'number') parts.push(`${fmt.num(count)} trace(s)`);
          if (hasMore) parts.push('more available');
          if (selectedTraceId) parts.push(`selected ${shortId(selectedTraceId)}`);
          el.textContent = parts.join(' · ') || 'No trace selected';
        }

        function traceStatusClass(status) {
          if (status === 'completed') return 'green';
          if (status === 'failed') return 'red';
          if (status === 'running') return 'yellow';
          return 'gray';
        }

        function traceToolStatusClass(status) {
          if (status === 'completed') return 'green';
          if (status === 'failed' || status === 'blocked') return 'red';
          if (status === 'started') return 'yellow';
          return 'gray';
        }

        function traceEventClass(event) {
          const type = event.type || '';
          return event.errorMessage || type.includes('failed') || type.includes('error') ? 'failed' : '';
        }

        function renderTools(data) {
          if (!data) return;
          renderToolsPolicyCards(data);
          renderToolsStatusChart(data.byStatus || []);
          renderToolsCategoryChart(data.byCategory || []);
          renderToolsTable(data.topTools || []);
          renderToolFailuresTable(data.topFailures || []);
          renderHangingToolsTable(data.hangingStarted || []);
        }

        function renderToolsPolicyCards(data) {
          const el = document.getElementById('toolsPolicyCards');
          if (!el) return;
          const policy = data.policy || {};
          const highRisk = (data.byRisk || []).find(r => r.risk === 'high') || {};
          const failedOrBlocked = (highRisk.failed || 0) + (highRisk.blocked || 0);
          const highRiskRate = highRisk.count > 0 ? failedOrBlocked / highRisk.count : 0;
          const statusStarted = (data.byStatus || []).find(r => r.status === 'started')?.count || 0;
          const hanging = data.hangingStarted || [];
          el.innerHTML = `
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Approval Gates</div>
              <div class="analytics-signal-value">${fmt.num(policy.requiresApproval || 0)}</div>
              <div class="analytics-signal-note">tool executions required approval</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">High-risk Blocks</div>
              <div class="analytics-signal-value ${policy.highRiskBlocked > 0 ? 'yellow' : 'green'}">${fmt.num(policy.highRiskBlocked || 0)}</div>
              <div class="analytics-signal-note">${fmt.pct(highRiskRate)} failed/blocked high-risk executions</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Hanging Started</div>
              <div class="analytics-signal-value ${hanging.length > 0 ? 'red' : 'green'}">${fmt.num(hanging.length)}</div>
              <div class="analytics-signal-note">${fmt.num(statusStarted)} total executions still started</div>
            </div>
            <div class="analytics-signal-card">
              <div class="analytics-signal-label">Policy Blocks</div>
              <div class="analytics-signal-value">${fmt.num(policy.blocked || 0)}</div>
              <div class="analytics-signal-note">effective deny decisions recorded</div>
            </div>
          `;
        }

        function renderToolsStatusChart(rows) {
          makeOrUpdate('toolsStatusChart', 'doughnut', {
            labels: rows.map(r => r.status),
            datasets: [{
              data: rows.map(r => r.count),
              backgroundColor: rows.map(r => statusColor(r.status)),
            }],
          }, {
            plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } },
          });
        }

        function renderToolsCategoryChart(rows) {
          const top = rows.slice(0, 10);
          makeOrUpdate('toolsCategoryChart', 'bar', {
            labels: top.map(r => r.category),
            datasets: [
              { label: 'Completed/other', data: top.map(r => Math.max(0, r.count - r.failed - r.blocked)), backgroundColor: COLORS.blue },
              { label: 'Failed', data: top.map(r => r.failed), backgroundColor: COLORS.red },
              { label: 'Blocked', data: top.map(r => r.blocked), backgroundColor: COLORS.yellow },
            ],
          }, {
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
            plugins: { legend: { position: 'top' } },
          });
        }

        function renderToolsTable(rows) {
          const el = document.getElementById('toolsTable');
          if (!el) return;
          if (!rows.length) { el.innerHTML = '<div class="empty">No tool envelope data</div>'; return; }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Tool</th>
                <th class="num">Runs</th>
                <th class="num">Failed</th>
                <th class="num">Blocked</th>
                <th class="num">Failure rate</th>
                <th class="num">Avg duration</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(r.toolId)}</strong>
                      <div class="analytics-subtle">${escapeHtml((r.categories || []).join(', '))} · ${escapeHtml((r.risks || []).join(', '))}</div>
                    </td>
                    <td class="num">${fmt.num(r.count)}</td>
                    <td class="num">${fmt.num(r.failed)}</td>
                    <td class="num">${fmt.num(r.blocked)}</td>
                    <td class="num"><span class="pill ${r.failureRate > 0.1 ? 'red' : r.failureRate > 0.03 ? 'yellow' : 'green'}">${fmt.pct(r.failureRate)}</span></td>
                    <td class="num">${fmt.ms(r.avgDurationMs)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderToolFailuresTable(rows) {
          const el = document.getElementById('toolFailuresTable');
          if (!el) return;
          if (!rows.length) { el.innerHTML = '<div class="empty">No failures in this window</div>'; return; }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Failure</th>
                <th class="num">Count</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(r.toolId)}</strong>
                      <div class="analytics-subtle">${escapeHtml(r.errorClass || 'unknown')}</div>
                      ${r.lastError ? `<div class="analytics-subtle">${escapeHtml(r.lastError).slice(0, 160)}</div>` : ''}
                    </td>
                    <td class="num">${fmt.num(r.count)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function renderHangingToolsTable(rows) {
          const el = document.getElementById('hangingToolsTable');
          if (!el) return;
          if (!rows.length) { el.innerHTML = '<div class="empty">No hanging executions older than 5 minutes</div>'; return; }
          el.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr>
                <th>Execution</th>
                <th class="num">Age</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => `
                  <tr ${traceDrillAttrs({ runId: r.runId, taskId: r.taskId, threadId: r.threadId })}>
                    <td>
                      <strong>${escapeHtml(r.toolId)}</strong>
                      <div class="analytics-subtle">${escapeHtml(r.agentId || 'unknown')} &middot; ${escapeHtml(r.id || '')}</div>
                    </td>
                    <td class="num"><span class="pill red">${fmt.duration(r.ageMs)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          `;
        }

        function statusColor(status) {
          if (status === 'completed') return COLORS.green;
          if (status === 'failed') return COLORS.red;
          if (status === 'blocked') return COLORS.yellow;
          if (status === 'started') return COLORS.purple;
          return COLORS.blue;
        }

        // ────────────────────────────────────────────────────────
        // Loaders (parallel)
        // ────────────────────────────────────────────────────────
        async function loadAll() {
          clearError();
          setStatus('Loading...', 'loading');
          if (!state.autoRefresh) setLoadingState();

          const params = buildParams();
          const traceParams = buildTraceParams();

          const [
            summaryV2,
            agents,
            models,
            latency,
            timeline,
            skills,
            quality,
            codeGraph,
            traces,
            scores,
            tools,
          ] = await Promise.all([
            settleEndpoint(fetchEndpoint('/v2/summary', params)),
            settleEndpoint(fetchEndpoint('/v2/agents', params)),
            settleEndpoint(fetchEndpoint('/v2/models', params)),
            settleEndpoint(fetchEndpoint('/v2/latency', params)),
            settleEndpoint(fetchEndpoint('/v2/timeline', buildParams({ granularity: state.granularity }))),
            settleEndpoint(fetchEndpoint('/v2/skills', params)),
            settleEndpoint(fetchEndpoint('/v2/quality', params)),
            settleEndpoint(fetchEndpoint('/v2/code-graph')),
            settleEndpoint(fetchEndpoint('/v2/traces', traceParams)),
            settleEndpoint(fetchEndpoint('/scores', { since: state.window })),
            settleEndpoint(fetchEndpoint('/v2/tools', params)),
          ]);

          let failures = 0;
          const fail = (result, ids, label) => {
            failures += 1;
            renderSectionError(ids, label, result.error);
          };

          if (summaryV2.ok) {
            renderOverview(summaryV2.value);
            renderAlerts(summaryV2.value.alerts);
          } else {
            fail(summaryV2, ['overviewCards', 'analyticsAlerts'], 'System Health');
          }

          if (agents.ok) {
            renderAgentsChart(agents.value.data);
            renderAgentsTable(agents.value.data);
          } else {
            fail(agents, ['agentsTable'], 'Agents');
          }

          if (models.ok) {
            renderModelFinopsCards(models.value.data);
            renderModelsChart(models.value.data);
            renderModelsTable(models.value.data);
          } else {
            fail(models, ['modelFinopsCards', 'modelsTable'], 'Models');
          }

          if (latency.ok) {
            renderLatencySummary(latency.value.data);
            renderLatencyChart(latency.value.data);
            renderSlowestRunsTable(latency.value.data);
          } else {
            fail(latency, ['latencySummaryCards', 'slowestRunsTable'], 'Latency');
          }

          if (timeline.ok) {
            renderCostChart(timeline.value.data);
            renderTimelineChart(timeline.value.data);
            renderTimelineAnnotations(timeline.value.data);
          } else {
            fail(timeline, ['timelineAnnotationsTable'], 'Timeline');
          }

          if (skills.ok) {
            renderSkillsChart(skills.value.data);
            renderSkillsDetails(skills.value.data);
          } else {
            fail(skills, ['skillsTable', 'legacySkillsTable'], 'Skills');
          }

          if (quality.ok) {
            renderQuality(quality.value.data);
          } else {
            fail(quality, ['qualityCards', 'qualityScorersTable', 'qualityFailuresTable', 'qualityGapsTable'], 'Quality');
          }

          if (codeGraph.ok) {
            renderCodeGraph(codeGraph.value.data);
          } else {
            fail(codeGraph, ['codeGraphCards', 'codeGraphHubsTable'], 'Code Graph Trend');
          }

          if (traces.ok) {
            renderTraces(traces.value.data);
            if (state.selectedTraceId) await loadTraceDetail(state.selectedTraceId);
          } else {
            fail(traces, ['traceListTable', 'traceDetailPanel'], 'Trace Explorer');
          }

          if (scores.ok) {
            renderScoresTable(scores.value.data);
          } else {
            fail(scores, ['scoresTable'], 'Legacy Scorers');
          }

          if (tools.ok) {
            renderTools(tools.value.data);
          } else {
            fail(tools, ['toolsPolicyCards', 'toolsTable', 'toolFailuresTable', 'hangingToolsTable'], 'Tool Envelopes');
          }

          if (failures > 0) {
            showError(`${failures} analytics section(s) failed; other sections were updated.`);
            setStatus(`Updated with ${failures} section error(s)`, 'error');
          } else {
            setStatus(`Updated ${new Date().toLocaleTimeString()}`, 'ok');
          }
        }

        // ────────────────────────────────────────────────────────
        // Live Activity (delegacje + tool calls live timeline)
        // ────────────────────────────────────────────────────────
        const liveState = {
          timer: null,
          windowSec: 300,
          autoRefresh: true,
          events: new Map(),       // eventId → event (do dedup)
          lastFetchTs: null,
        };

        const AGENT_BADGE_CLASS = (agentId) => {
          const id = (agentId || '').toLowerCase();
          if (id.includes('meta')) return 'meta';
          if (id.includes('coding') || id.includes('code-review')) return id.includes('review') ? 'review' : 'coding';
          return '';
        };

        const fmtLocalTime = (iso) => {
          const d = new Date(iso);
          return d.toLocaleTimeString('pl-PL', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
        };

        const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        function renderLiveEvent(ev) {
          const badgeClass = AGENT_BADGE_CLASS(ev.agentId);
          const isError = ev.status === 'error' || ev.errorMessage;
          const isDelegation = ev.type === 'delegation';
          const arrow = isDelegation ? '<span class="live-event-arrow">→</span>' : '';

          let label;
          if (ev.type === 'delegation') label = 'delegation';
          else if (ev.type === 'task_completed') label = 'task ✓';
          else if (ev.type === 'task_failed') label = 'task ✗';
          else if (ev.toolId) label = ev.toolId;
          else label = ev.type;

          const detailsParts = [];
          if (ev.errorMessage) detailsParts.push(`<span class="label err">ERROR:</span>${escapeHtml(ev.errorMessage)}`);
          if (ev.input) detailsParts.push(`<span class="label">IN:</span>${escapeHtml(ev.input)}`);
          if (ev.output) detailsParts.push(`<span class="label">OUT:</span>${escapeHtml(ev.output)}`);
          if (ev.model) detailsParts.push(`<span class="label">model:</span>${escapeHtml(ev.model)}`);
          if (ev.tokenUsage) detailsParts.push(`<span class="label">tokens:</span>prompt=${ev.tokenUsage.prompt} completion=${ev.tokenUsage.completion}`);
          const details = detailsParts.length
            ? `<div class="live-event-details">${detailsParts.join('')}</div>`
            : '';

          return `
            <div class="live-event ${isError ? 'has-error' : ''}" data-event-id="${ev.eventId}">
              <span class="live-event-time">${fmtLocalTime(ev.timestamp)}</span>
              <span class="live-agent-badge ${badgeClass}">${escapeHtml(ev.agentId || 'unknown')}</span>
              ${arrow}
              <span class="live-event-tool">${escapeHtml(label)}</span>
              <span class="live-event-status ${isError ? 'error' : 'success'}">${ev.status || '-'}</span>
              <span class="live-event-duration">${ev.durationMs ? ev.durationMs + 'ms' : ''}</span>
            </div>
            ${details}
          `;
        }

        function renderLiveActivity() {
          const list = document.getElementById('liveActivityList');
          const allEvents = Array.from(liveState.events.values())
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

          if (!allEvents.length) {
            list.innerHTML = '<div class="empty">Brak aktywności w wybranym oknie</div>';
            return;
          }

          // Group by taskId (trace id) preserving newest-first order
          const groups = new Map();
          for (const ev of allEvents) {
            const key = ev.taskId || ev.eventId;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(ev);
          }

          const html = Array.from(groups.entries()).map(([taskId, events]) => {
            const hasError = events.some(e => e.status === 'error' || e.errorMessage);
            const hasDelegation = events.some(e => e.type === 'delegation');
            const cls = hasError ? 'has-error' : (hasDelegation ? 'has-delegation' : '');
            const headerAgent = events[events.length - 1].agentId || 'unknown'; // root agent
            const eventCount = events.length;
            return `
              <div class="live-trace ${cls}">
                <div class="live-trace-header">
                  <span class="live-agent-badge ${AGENT_BADGE_CLASS(headerAgent)}">${escapeHtml(headerAgent)}</span>
                  <button type="button" class="live-trace-link" data-drill="trace" data-trace-id="${escapeHtml(taskId)}" title="Open in Trace Explorer">trace ${escapeHtml(taskId.slice(0, 12))} ↳</button>
                  <span style="color: var(--text-dim); margin-left: auto">${eventCount} event(s)</span>
                </div>
                ${events.map(renderLiveEvent).join('')}
              </div>
            `;
          }).join('');

          list.innerHTML = html;

          // Click handler for event expand/collapse
          list.querySelectorAll('.live-event').forEach(el => {
            el.addEventListener('click', () => el.classList.toggle('expanded'));
          });
        }

        async function loadLiveActivity() {
          try {
            const since = new Date(Date.now() - liveState.windowSec * 1000).toISOString();
            const res = await fetchEndpoint('/agent-activity', { since, limit: '200' });

            // Drop events outside window, then upsert fresh ones
            const cutoff = Date.now() - liveState.windowSec * 1000;
            for (const [id, ev] of liveState.events) {
              if (new Date(ev.timestamp).getTime() < cutoff) liveState.events.delete(id);
            }
            for (const ev of res.events) {
              liveState.events.set(ev.eventId, ev);
            }
            liveState.lastFetchTs = new Date();

            document.getElementById('liveMeta').textContent =
              `${liveState.events.size} eventów · odświeżono ${liveState.lastFetchTs.toLocaleTimeString('pl-PL', {hour12: false})}`;
            renderLiveActivity();
          } catch (err) {
            document.getElementById('liveMeta').textContent = `Błąd: ${err.message}`;
          }
        }

        function startLivePolling() {
          if (liveState.timer) clearInterval(liveState.timer);
          if (!liveState.autoRefresh) return;
          loadLiveActivity();
          liveState.timer = setInterval(loadLiveActivity, 2000);
          document.getElementById('liveDot').classList.remove('paused');
        }

        function stopLivePolling() {
          if (liveState.timer) clearInterval(liveState.timer);
          liveState.timer = null;
          document.getElementById('liveDot').classList.add('paused');
        }

        document.getElementById('liveAutoRefresh').addEventListener('change', (e) => {
          liveState.autoRefresh = e.target.checked;
          if (liveState.autoRefresh) startLivePolling();
          else stopLivePolling();
        }, eventOptions);

        document.getElementById('liveWindow').addEventListener('change', (e) => {
          liveState.windowSec = parseInt(e.target.value, 10);
          liveState.events.clear();
          loadLiveActivity();
        }, eventOptions);

        document.getElementById('liveClearBtn').addEventListener('click', () => {
          liveState.events.clear();
          renderLiveActivity();
          document.getElementById('liveMeta').textContent = 'Wyczyszczone';
        }, eventOptions);

        // Live rail open/close (narrow auxiliary panel, collapsed by default)
        function setLiveRailOpen(open) {
          const rail = document.getElementById('liveRail');
          const toggle = document.getElementById('liveRailToggle');
          if (rail) {
            rail.classList.toggle('collapsed', !open);
            rail.setAttribute('aria-hidden', open ? 'false' : 'true');
          }
          if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        document.getElementById('liveRailToggle')?.addEventListener('click', () => {
          const rail = document.getElementById('liveRail');
          setLiveRailOpen(!rail || rail.classList.contains('collapsed'));
        }, eventOptions);
        document.getElementById('liveRailClose')?.addEventListener('click', () => setLiveRailOpen(false), eventOptions);

        // ────────────────────────────────────────────────────────
        // Wire up
        // ────────────────────────────────────────────────────────
        // Delegated drill-downs: alerts → section, tables/timeline → trace,
        // agent/model rows → global filter. One listener for the whole tab.
        root.addEventListener('click', handleDrillClick, eventOptions);
        root.addEventListener('keydown', handleDrillKeydown, eventOptions);
        document.getElementById('windowSelect').addEventListener('change', (e) => {
          state.window = e.target.value;
          loadAll();
        }, eventOptions);
        document.getElementById('granularitySelect').addEventListener('change', (e) => {
          state.granularity = e.target.value;
          loadAll();
        }, eventOptions);
        for (const id of ['agentFilterInput', 'modelFilterInput', 'toolCategoryFilterInput', 'toolRiskFilter', 'toolStatusFilter']) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.addEventListener('change', () => loadAll(), eventOptions);
          el.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') loadAll();
          }, eventOptions);
        }
        document.getElementById('clearFiltersBtn')?.addEventListener('click', clearFilters, eventOptions);
        for (const id of ['traceRunFilterInput', 'traceTaskFilterInput', 'traceThreadFilterInput', 'traceStatusFilter', 'traceLimitSelect']) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.addEventListener('change', () => {
            state.selectedTraceId = '';
            loadAll();
          }, eventOptions);
          el.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              state.selectedTraceId = '';
              loadAll();
            }
          }, eventOptions);
        }
        document.getElementById('traceSearchBtn')?.addEventListener('click', () => {
          state.selectedTraceId = '';
          loadAll();
        }, eventOptions);
        document.getElementById('traceClearBtn')?.addEventListener('click', clearTraceFilters, eventOptions);
        document.getElementById('traceListTable')?.addEventListener('click', (event) => {
          const target = event.target instanceof Element ? event.target.closest('[data-trace-id]') : null;
          const traceId = target?.getAttribute('data-trace-id');
          if (traceId) loadTraceDetail(traceId);
        }, eventOptions);
        document.getElementById('refreshBtn').addEventListener('click', () => loadAll(), eventOptions);
        document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
          state.autoRefresh = e.target.checked;
          if (state.autoRefreshTimer) {
            clearInterval(state.autoRefreshTimer);
            state.autoRefreshTimer = null;
          }
          if (state.autoRefresh) {
            state.autoRefreshTimer = setInterval(() => loadAll(), 30000);
          }
        }, eventOptions);

        // Initial load
        loadAll();
        startLivePolling();

    window.analyticsState = state;
    window.analyticsLiveState = liveState;

    refreshImpl = loadAll;
    destroyImpl = () => {
      events.abort();
      if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
      if (liveState.timer) clearInterval(liveState.timer);
      state.autoRefreshTimer = null;
      liveState.timer = null;
      for (const chart of Object.values(state.charts)) {
        if (chart && typeof chart.destroy === 'function') chart.destroy();
      }
      state.charts = {};
    };

    return { initialized: true, ownsRendering: true, version: VERSION };
  }

  function refresh() {
    if (!initialized) init();
    return refreshImpl ? refreshImpl() : undefined;
  }

  function destroy() {
    if (destroyImpl) destroyImpl();
    initialized = false;
    refreshImpl = null;
    destroyImpl = null;
  }

  window.MastraAnalytics = {
    destroy,
    init,
    refresh,
    version: VERSION,
    get initialized() {
      return initialized;
    },
    get ownsRendering() {
      return true;
    },
  };

  const boot = () => window.MastraAnalytics.init({
    apiBase: (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:4111/dashboard' : '/dashboard',
    rootId: 'tab-analytics',
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();


// === DASHBOARD TAB SCRIPT ===

const API = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:4111' : '';
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function qualifyMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const base = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:4111' : '';
  return base + (url.startsWith('/') ? url : '/' + url);
}

async function api(path, opts) {
  const r = await fetch(API + path, { headers: {'Content-Type':'application/json'}, ...opts });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Workspace project removal uses one custom modal rather than browser confirm()
// dialogs. This keeps the destructive action explicit and offers the optional
// generated-media cleanup used by filmmaker and musician projects.
let pendingWorkspaceDeletion = null;

function settleWorkspaceDeletion(result) {
  const pending = pendingWorkspaceDeletion;
  if (!pending) return;
  pendingWorkspaceDeletion = null;
  pending.modal.classList.remove('open');
  pending.resolve(result);
}

function confirmWorkspaceProjectDeletion({ title, message }) {
  if (pendingWorkspaceDeletion) return pendingWorkspaceDeletion.promise;

  const modal = $('#modal-workspace-delete');
  const titleEl = $('#workspace-delete-title');
  const messageEl = $('#workspace-delete-message');
  const cancelButton = $('#btn-workspace-delete-cancel');
  const confirmButton = $('#btn-workspace-delete-confirm');

  if (!modal || !titleEl || !messageEl || !cancelButton || !confirmButton) {
    console.error('[workspace] Missing project-delete confirmation modal.');
    return Promise.resolve({ confirmed: false });
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmButton.textContent = 'Usuń projekt';

  let resolveDeletion;
  const promise = new Promise((resolve) => {
    resolveDeletion = resolve;
  });
  pendingWorkspaceDeletion = { modal, resolve: resolveDeletion, promise };
  {
    cancelButton.onclick = () => settleWorkspaceDeletion({ confirmed: false });
    confirmButton.onclick = () => settleWorkspaceDeletion({ confirmed: true });
    modal.onclick = (event) => {
      if (event.target === modal) settleWorkspaceDeletion({ confirmed: false });
    };
    modal.classList.add('open');
    confirmButton.focus();
  }
  return promise;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingWorkspaceDeletion) {
    settleWorkspaceDeletion({ confirmed: false, deleteFiles: false });
  }
});

// ── Tabs ──
const TABS = ['crm','outreach','content','packs','chef','books','writer','designer','filmmaker','musician','scheduler','approvals'];
$$('#tab-workspace nav button').forEach(b => { if (b.dataset.tab) b.onclick = () => switchTab(b.dataset.tab); });
function switchTab(t) {
  $$('#tab-workspace nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  TABS.forEach(x => $('#tab-'+x).classList.toggle('hidden', x !== t));
  if (t === 'crm') loadCRM();
  if (t === 'outreach') loadOutreach();
  if (t === 'content') loadContent();
  if (t === 'packs') loadPacks();
  if (t === 'chef') loadChef();
  if (t === 'books') loadBooks();
  if (t === 'writer') loadWriter();
  if (t === 'designer') loadDesigner();
  if (t === 'filmmaker') loadFilmmaker();
  if (t === 'musician') loadMusician();
  if (t === 'scheduler') loadScheduler();
  if (t === 'approvals') loadApprovals();
}

// ══════════════ APPROVALS ══════════════
async function loadApprovals() {
  const host = $('#approvalsList');
  if (!host) return;
  host.innerHTML = '<div class="empty">Ładowanie…</div>';
  try {
    const res = await api('/dashboard/approvals');
    const rows = res.data || [];
    if (!rows.length) { host.innerHTML = '<div class="empty">Brak oczekujących zatwierdzeń.</div>'; return; }
    host.innerHTML = rows.map(a => {
      const proj = a.args && a.args.projectId ? esc(a.args.projectId) : '';
      const clip = a.args && a.args.clipId ? esc(a.args.clipId) : '';
      const when = a.createdAt ? esc(new Date(a.createdAt).toLocaleString('pl-PL')) : '';
      return `<div style="border:1px solid rgba(0,240,255,0.15);border-radius:8px;padding:12px;margin-bottom:10px;background:rgba(10,15,28,0.5)">
        <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:6px">
          <span style="color:var(--jarvis-meta,#00f0ff);font-weight:600">${esc(a.tool || '—')}</span>
          <span>${esc(a.agentId || '')}</span>
          <span style="margin-left:auto">${when}</span>
        </div>
        <div style="font-size:13px;margin-bottom:6px">${esc(a.action || '')}</div>
        ${proj ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">projekt: ${proj}${clip ? ' · klip: ' + clip : ''}</div>` : ''}
        <div style="font-family:monospace;font-size:11px;opacity:0.6;margin-bottom:8px">${esc(a.id)}</div>
        <button class="btn" onclick="approveApproval('${esc(a.id)}', this)">✓ Zatwierdź</button>
      </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = '<div class="empty">Błąd: ' + esc(e.message) + '</div>';
  }
}
async function approveApproval(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await api('/dashboard/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
    loadApprovals();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Zatwierdź'; }
    alert('Nie udało się zatwierdzić: ' + e.message);
  }
}

// ══════════════ SCHEDULER ══════════════
async function loadScheduler() {
  const host = $('#schedulerList');
  const summary = $('#schedulerSummary');
  if (!host) return;
  host.innerHTML = '<div class="empty">Ładowanie…</div>';
  if (summary) summary.innerHTML = '';
  try {
    const params = new URLSearchParams({ limit: '50' });
    const status = $('#schedulerStatus')?.value || '';
    if (status) params.set('status', status);
    const res = await api('/dashboard/scheduled-tasks?' + params.toString());
    const counts = res.counts || {};
    if (summary) {
      summary.innerHTML = ['scheduled','running','failed','completed','cancelled'].map(k =>
        `<span style="display:inline-block;border:1px solid rgba(0,240,255,0.16);border-radius:6px;padding:4px 8px;margin-right:6px;font-size:12px">${esc(k)}: <b>${counts[k] || 0}</b></span>`
      ).join('');
    }
    const rows = res.data || [];
    if (!rows.length) { host.innerHTML = '<div class="empty">Brak scheduled tasks.</div>'; return; }
    host.innerHTML = rows.map(t => {
      const when = t.schedule?.fireAt ? new Date(t.schedule.fireAt).toLocaleString('pl-PL') : (t.schedule?.cronExpression || '—');
      const statusClass = t.status === 'failed' ? '#ef4444' : t.status === 'completed' ? '#22c55e' : t.status === 'running' ? '#eab308' : 'var(--jarvis-meta,#00f0ff)';
      return `<div style="border:1px solid rgba(0,240,255,0.15);border-radius:8px;padding:10px;margin-bottom:10px;background:rgba(10,15,28,0.5)">
        <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:5px">
          <span style="color:${statusClass};font-weight:700">${esc(t.status)}</span>
          <span>${esc(t.targetType)}:${esc(t.targetIdentifier)}</span>
          <span style="margin-left:auto">${esc(when)}</span>
        </div>
        <div style="font-size:13px;margin-bottom:5px">${esc(t.chainName || t.chainId || 'single task')} ${t.stepName ? '· ' + esc(t.stepName) : ''}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${esc(t.promptPreview || '')}</div>
        <div style="font-family:monospace;font-size:11px;opacity:0.65;margin-bottom:8px">${esc(t.taskId)}</div>
        <button class="btn ghost" onclick="inspectScheduledTask('${esc(t.taskId)}')">Szczegóły</button>
        <button class="btn ghost" onclick="rescheduleScheduledTaskUi('${esc(t.taskId)}')">Przesuń</button>
        <button class="btn ghost" onclick="cancelScheduledTaskUi('${esc(t.taskId)}', this)">Anuluj</button>
      </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = '<div class="empty">Błąd: ' + esc(e.message) + '</div>';
  }
}
async function inspectScheduledTask(id) {
  const host = $('#schedulerDetail');
  if (!host) return;
  host.innerHTML = '<div class="empty">Ładowanie…</div>';
  try {
    const res = await api('/dashboard/scheduled-tasks/' + encodeURIComponent(id));
    const t = res.task;
    host.innerHTML = `<h3>Scheduled Task</h3>
      <div style="font-family:monospace;font-size:11px;color:var(--muted);margin-bottom:10px">${esc(t.taskId)}</div>
      <div class="field"><label>Status</label><div class="v">${esc(t.status)}</div></div>
      <div class="field"><label>Target</label><div class="v">${esc(t.targetType)}:${esc(t.targetIdentifier)}</div></div>
      <div class="field"><label>Schedule</label><div class="v">${esc(t.schedule?.fireAt || t.schedule?.cronExpression || '—')}</div></div>
      <div class="field"><label>Chain</label><div class="v">${esc(t.chainName || '')}<br>${esc(t.chainId || '')}<br>${esc(t.stepName || '')}</div></div>
      <div class="field"><label>Retry</label><div class="v">${esc(JSON.stringify(t.retry || {}))}</div></div>
      <div class="field"><label>Prompt preview</label><div class="v">${esc(t.promptPreview || '')}</div></div>
      ${t.lastError ? `<div class="field"><label>Last error</label><div class="v">${esc(t.lastError)}</div></div>` : ''}
      ${t.resultPreview ? `<div class="field"><label>Result</label><pre>${esc(t.resultPreview)}</pre></div>` : ''}
      ${t.payloadPreview ? `<div class="field"><label>Payload</label><pre>${esc(t.payloadPreview)}</pre></div>` : ''}`;
  } catch (e) {
    host.innerHTML = '<div class="empty">Błąd: ' + esc(e.message) + '</div>';
  }
}
async function cancelScheduledTaskUi(id, btn) {
  if (!confirm('Anulować scheduled task ' + id + '?')) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await api('/dashboard/scheduled-tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
    loadScheduler();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Anuluj'; }
    alert('Nie udało się anulować: ' + e.message);
  }
}
async function rescheduleScheduledTaskUi(id) {
  const fireAt = prompt('Nowy fireAt ISO 8601', new Date(Date.now() + 3600_000).toISOString());
  if (!fireAt) return;
  try {
    await api('/dashboard/scheduled-tasks/' + encodeURIComponent(id) + '/reschedule', {
      method: 'POST',
      body: JSON.stringify({ fireAt, resetRetry: true }),
    });
    loadScheduler();
    inspectScheduledTask(id);
  } catch (e) {
    alert('Nie udało się przesunąć: ' + e.message);
  }
}

// ── Drawer ──
function openDrawer(html) {
  $('#drawerHost').innerHTML =
    `<div class="drawer-bg" onclick="closeDrawer()"></div><div class="drawer"><span class="close" onclick="closeDrawer()">×</span>${html}</div>`;
}
function closeDrawer() { $('#drawerHost').innerHTML = ''; }

// Słownik statusów pochodzi z backendu (/ws/leads/statuses → config/crm-statuses.ts).
// Kopia trzymana tutaj rozjechała się z tym, co zapisuje wysyłka: lead dostawał
// status 'contacted', pętla renderująca iterowała po TEJ liście, więc karta nie
// miała kolumny i znikała z tablicy. Licznik u góry nadal ją liczył.
let STATUSES = [];
let STATUS_LABEL = {};
const UNKNOWN_STATUS_COL = '__inne__';
let statusVocabularyLoaded = false;
async function loadStatusVocabulary() {
  if (statusVocabularyLoaded) return;
  try {
    const res = await api('/ws/leads/statuses');
    STATUSES = (res.statuses || []).map(s => s.value);
    STATUS_LABEL = Object.fromEntries((res.statuses || []).map(s => [s.value, s.label]));
    statusVocabularyLoaded = STATUSES.length > 0;
  } catch {
    // Serwer bez tego endpointu (np. jeszcze nie zrestartowany po deployu).
    // Zostawiamy pustą listę: renderKanban zbuduje kolumny z tego, co realnie
    // jest w danych, więc żaden lead nie zniknie — a to jest cała stawka.
    STATUSES = [];
    STATUS_LABEL = {};
  }
}

// ══════════════ CRM ══════════════
let crmLeads = [];
async function loadCRM() {
  await loadStatusVocabulary();
  const stats = await api('/ws/leads/stats');
  $('#crmStats').innerHTML = [
    ['Leady', stats.total],
    ['Draft gotowy', stats.byStatus['draft_gotowy'] || 0],
    ['Research', (stats.byStatus['research_needed']||0)+(stats.byStatus['research_enriched']||0)],
    ['Gastro', stats.bySegment['gastro-producer'] || 0],
    ['Automation', stats.bySegment['automation-prospect'] || 0],
  ].map(([l,n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const srcSel = $('#crmSource');
  if (srcSel.options.length <= 1) {
    Object.keys(stats.bySource).sort().forEach(s => {
      if (s === '(brak)') return;
      const o = document.createElement('option'); o.value = s; o.textContent = s; srcSel.appendChild(o);
    });
  }
  await reloadLeads();
}
async function reloadLeads() {
  const q = $('#crmSearch').value.trim();
  const segment = $('#crmSegment').value, source = $('#crmSource').value;
  const params = new URLSearchParams({ limit: '1000' });
  if (q) params.set('q', q);
  if (segment) params.set('segment', segment);
  if (source) params.set('source', source);
  const res = await api('/ws/leads?' + params);
  crmLeads = res.data;
  renderKanban();
}
function renderKanban() {
  const byStatus = {}; STATUSES.forEach(s => byStatus[s] = []);
  // Lead ze statusem spoza słownika dostaje własną kolumnę zamiast wypaść z
  // tablicy. Nieznany status to coś do obejrzenia, nie do ukrycia.
  const unknown = [];
  crmLeads.forEach(l => { (byStatus[l.status] || unknown).push(l); });
  const columns = STATUSES.map(s => ({ key: s, label: STATUS_LABEL[s] || s, leads: byStatus[s], drop: true }));
  if (unknown.length) {
    if (STATUSES.length === 0) {
      // Bez słownika z backendu: kolumny wprost ze statusów obecnych w danych.
      const seen = [...new Set(unknown.map(l => l.status || '(brak)'))].sort();
      seen.forEach(st => columns.push({
        key: st,
        label: st,
        leads: unknown.filter(l => (l.status || '(brak)') === st),
        drop: true,
      }));
    } else {
      columns.push({ key: UNKNOWN_STATUS_COL, label: 'Inne (nieznany status)', leads: unknown, drop: false });
    }
  }
  $('#kanban').innerHTML = columns.map(col => `
    <div class="col" data-status="${col.key}" ${col.drop
      ? `ondragover="event.preventDefault();this.classList.add('dragover')"
         ondragleave="this.classList.remove('dragover')" ondrop="dropLead(event,'${col.key}')"`
      : ''}>
      <h3><span>${col.label}</span><span>${col.leads.length}</span></h3>
      <div class="body">${col.leads.map(l => cardHTML(l, col.key === UNKNOWN_STATUS_COL)).join('') || '<div class="empty" style="font-size:12px">—</div>'}</div>
    </div>`).join('');
  $$('.card').forEach(c => {
    c.draggable = true;
    c.ondragstart = e => e.dataTransfer.setData('id', c.dataset.id);
    c.onclick = () => openLead(c.dataset.id);
  });
}
const SEGMENT_MAP = {
  'supplier_gb': { cls: 'supplier_gb', label: 'Dostawca GB' },
  'restaurant_gb': { cls: 'restaurant_gb', label: 'Restauracja GB' },
  'automation': { cls: 'automation', label: 'Automatyzacje' },
  'web_dev': { cls: 'web_dev', label: 'Strony WWW' },
  'gastro_consulting': { cls: 'gastro_consulting', label: 'Konsulting Gastro' },
  'career_it_pl': { cls: 'career_it', label: 'Kariera IT (PL)' },
  'career_it_is': { cls: 'career_it', label: 'Kariera IT (IS)' },
  'career_chef_pl': { cls: 'career_chef', label: 'Chef (PL)' },
  'career_chef_is': { cls: 'career_chef', label: 'Chef (IS)' },
  'gastro-producer': { cls: 'supplier_gb', label: 'Dostawca GB' },
  'automation-prospect': { cls: 'automation', label: 'Automatyzacja' },
};

/**
 * Opcje statusu z bieżącym stanem leada włącznie.
 *
 * Gdy lead ma status spoza słownika, samo `STATUSES.map` nie zaznaczyłoby
 * niczego — przeglądarka pokazałaby pierwszą opcję, a zapis po cichu zmieniłby
 * stan, którego nikt nie tknął. Nieznana wartość dostaje własną, oznaczoną
 * pozycję.
 */
function statusOptions(current) {
  const known = STATUSES.includes(current);
  const options = STATUSES.map(s =>
    `<option value="${s}" ${s === current ? 'selected' : ''}>${STATUS_LABEL[s] || s}</option>`);
  if (!known && current) {
    options.unshift(`<option value="${esc(current)}" selected>${esc(current)} (nieznany)</option>`);
  }
  return options.join('');
}

function cardHTML(l, showRawStatus) {
  const segInfo = SEGMENT_MAP[l.segment] || { cls: 'other', label: l.segment || 'Inne' };
  return `<div class="card" data-id="${esc(l.id)}">
    <div class="name">${esc(l.companyName)}</div>
    <div class="meta">
      <span class="badge ${segInfo.cls}">${segInfo.label}</span>
      ${showRawStatus ? `<span class="badge" title="status spoza słownika">${esc(l.status || '(brak)')}</span>` : ''}
      ${l.region ? `<span class="badge">${esc(l.region)}</span>` : ''}
      ${l.draft && l.draft.gmailDraftId ? '<span class="dot" title="ma draft"></span>' : ''}
    </div></div>`;
}
async function dropLead(e, status) {
  e.preventDefault();
  $$('.col').forEach(c => c.classList.remove('dragover'));
  if (status === UNKNOWN_STATUS_COL) return; // kolumna diagnostyczna, nie stan
  const id = e.dataTransfer.getData('id');
  const lead = crmLeads.find(l => l.id === id);
  if (!lead || lead.status === status) return;
  lead.status = status; renderKanban();
  await api('/ws/leads/' + encodeURIComponent(id), { method:'PATCH', body: JSON.stringify({ status }) });
}
async function openLead(id) {
  const l = await api('/ws/leads/' + encodeURIComponent(id));
  const c = l.contact || {};
  const olx = l.details?.olx, auto = l.details?.automation;
  const segInfo = SEGMENT_MAP[l.segment] || { cls: 'other', label: l.segment || 'Inne' };
  openDrawer(`
    <h2>${esc(l.companyName)}</h2>
    <div class="field"><span class="badge ${segInfo.cls}">${esc(segInfo.label)}</span></div>
    <div class="field"><label>Status</label>
      <select id="leadStatus">${statusOptions(l.status)}</select></div>
    ${c.email?`<div class="field"><label>Email</label><div class="v">${esc(c.email)}</div></div>`:''}
    ${c.phone?`<div class="field"><label>Telefon</label><div class="v">${esc(c.phone)}</div></div>`:''}
    ${c.website?`<div class="field"><label>WWW</label><div class="v"><a href="${esc(c.website)}" target="_blank">${esc(c.website)}</a></div></div>`:''}
    ${l.region?`<div class="field"><label>Region</label><div class="v">${esc(l.region)}</div></div>`:''}
    ${olx?`<div class="field"><label>OLX</label><div class="v">${esc(olx.title||'')} — ${esc(olx.price||'')} (${esc(olx.city||'')})<br><a href="${esc(olx.url)}" target="_blank">ogłoszenie ↗</a></div></div>`:''}
    ${auto?`<div class="field"><label>Automation</label><div class="v">Score: ${auto.qualityScore??'?'} · ~${auto.estimatedHoursSaved??'?'}h/mc<br>${esc(auto.useCaseIdea||'')}</div></div>`:''}
    ${l.draft&&l.draft.gmailDraftId?`<div class="field"><label>Gmail draft</label><div class="v">${esc(l.draft.subject||'(bez tematu)')}<br><code>${esc(l.draft.gmailDraftId)}</code></div>${l.draft.body?`<pre class="body" style="margin-top:6px">${esc(l.draft.body)}</pre>`:''}</div>`:''}
    <div class="field"><label>Dodaj notatkę</label>
      <textarea id="leadNote" style="min-height:60px" placeholder="Notatka do historii…"></textarea>
      <button class="btn" style="margin-top:6px" onclick="saveLead('${esc(l.id)}')">Zapisz</button></div>
    <div class="field"><label>Historia (${l.history.length})</label>
      <div class="timeline">${l.history.slice().reverse().map(h=>`
        <div class="tl-item"><div class="ta">${esc(h.action||'')}</div>
          <div class="td">${esc(h.description||'')}</div>
          <div class="tt">${h.timestamp?new Date(h.timestamp).toLocaleString('pl-PL'):''} · ${esc(h.agentId||'')}</div></div>`).join('') || '<div class="empty">brak</div>'}</div></div>
  `);
}
async function saveLead(id) {
  const status = $('#leadStatus').value, note = $('#leadNote').value.trim();
  await api('/ws/leads/' + encodeURIComponent(id), { method:'PATCH', body: JSON.stringify({ status, note: note||undefined }) });
  closeDrawer(); reloadLeads();
}
$('#crmReload').onclick = reloadLeads;
$('#crmSearch').addEventListener('keydown', e => { if (e.key==='Enter') reloadLeads(); });
$('#crmSegment').onchange = reloadLeads;
$('#crmSource').onchange = reloadLeads;

// ══════════════ CONTENT STUDIO ══════════════
async function loadContent() { await Promise.all([loadSignals(), loadCalendar()]); }
async function loadSignals() {
  const used = $('#onlyUnused').checked ? '&used=false' : '';
  const res = await api('/ws/content/signals?limit=60' + used);
  $('#signalsList').innerHTML = res.data.map(s => `
    <div class="signal" onclick='openSignal(${JSON.stringify(s.signalId)})'>
      <div class="t">${esc(s.title)}</div>
      <div class="s">${esc(s.source||'')} · <span class="score">rel ${(s.scores?.relevance??0).toFixed?.(2) ?? s.scores?.relevance}</span>${s.used?' · ✓ użyte':''}</div>
    </div>`).join('') || '<div class="empty">Brak sygnałów.</div>';
}
window.openSignal = async (id) => {
  const s = await api('/ws/content/signals/' + encodeURIComponent(id));
  openDrawer(`
    <h2>${esc(s.title)}</h2>
    <div class="field"><div class="s">${esc(s.sourceName||s.source||'')} · ${s.publishedAt?new Date(s.publishedAt).toLocaleDateString('pl-PL'):''}</div></div>
    <div class="field"><label>Podsumowanie</label><div class="v">${esc(s.summary||'')}</div></div>
    <div class="field"><label>Dlaczego ważne</label><div class="v">${esc(s.whyItMatters||'')}</div></div>
    <div class="field"><label>Hooki</label>${(s.hooks||[]).map(h=>`<div class="hook"><b>${esc(h.hook)}</b><br><span class="s">${esc(h.bestFor||'')} · ${esc(h.angle||'')}</span></div>`).join('')||'—'}</div>
    <div class="field"><label>Angle treści</label><div class="v">${(s.contentAngles||[]).map(a=>'• '+esc(a)).join('<br>')||'—'}</div></div>
    <div class="field"><label>Tagi</label><div class="v">${(s.tags||[]).map(t=>`<span class="badge">${esc(t)}</span>`).join(' ')}</div></div>
    ${s.canonicalUrl||s.url?`<div class="field"><a href="${esc(s.canonicalUrl||s.url)}" target="_blank">Źródło ↗</a></div>`:''}
  `);
};
$('#onlyUnused').onchange = loadSignals;

async function loadCalendar() {
  const cal = await api('/ws/drafts/calendar');
  const weeks = Object.keys(cal).sort().reverse();
  if (!weeks.length) { $('#calendar').innerHTML = '<div class="empty">Brak draftów social. Kliknij „Reindex draftów".</div>'; return; }
  $('#calendar').innerHTML = weeks.map(w => `
    <div class="week"><h4>Tydzień: ${esc(w)}</h4><div class="week-grid">
      ${cal[w].map(postCard).join('')}</div></div>`).join('');
}
const CH_CLASS = { linkedin:'li', instagram:'ig', tiktok:'tt', email:'email' };
const CH_LABEL = { linkedin:'LinkedIn', instagram:'Instagram', tiktok:'TikTok', email:'Email' };
function postCard(d) {
  const ch = CH_CLASS[d.channel] || 'other';
  const chL = CH_LABEL[d.channel] || d.channel;
  return `<div class="post-card" onclick='openDraft(${JSON.stringify(d.draftId)})'>
    <span class="badge ${ch}">${chL}</span> <span class="badge lang">${esc(d.language)}</span>
    <div class="pt">${esc(d.title)}</div>
    <div class="pb">${esc((d.body||'').slice(0,140))}</div>
    <div class="s" style="margin-top:6px;font-size:11px">${d.charCount}${d.limit?'/'+d.limit:''} zn. · ${esc(d.status)}</div></div>`;
}
window.openDraft = async (id) => {
  const d = await api('/ws/drafts/' + encodeURIComponent(id));
  const over = d.limit && d.charCount > d.limit;
  openDrawer(`
    <h2>${esc(d.title)}</h2>
    <div class="field">
      <span class="badge ${CH_CLASS[d.channel]||'other'}">${esc(d.channel)}</span>
      <span class="badge lang">${esc(d.language)}</span> <span class="badge">${esc(d.status)}</span></div>
    ${d.imagePrompt?`<div class="field"><label>Image prompt</label><div class="v">${esc(d.imagePrompt)}</div></div>`:''}
    <div class="field"><label>Treść (markdown)</label>
      <textarea id="draftBody" oninput="updCount()">${esc(d.body)}</textarea>
      <div class="charcount ${over?'over':''}" id="charcount">${d.charCount}${d.limit?' / '+d.limit:''} znaków</div></div>
    ${(d.hashtags&&d.hashtags.length)?`<div class="field"><label>Hashtagi</label><div class="v">${esc(d.hashtags.join(' '))}</div></div>`:''}
    ${d.rationale?`<div class="field"><label>Rationale</label><div class="v">${esc(d.rationale)}</div></div>`:''}
    <div class="field">
      <button class="btn" onclick="saveDraft('${esc(d.draftId)}')">💾 Zapisz</button>
      <button class="btn ghost" onclick="setStatus('${esc(d.draftId)}','approved')">✓ Zatwierdź</button>
    </div>`);
  window.__draftLimit = d.limit;
};
window.updCount = () => {
  const n = $('#draftBody').value.length, lim = window.__draftLimit;
  const el = $('#charcount'); el.textContent = n + (lim?' / '+lim:'') + ' znaków';
  el.classList.toggle('over', lim && n > lim);
};
window.saveDraft = async (id) => {
  await api('/ws/drafts/' + encodeURIComponent(id), { method:'PATCH', body: JSON.stringify({ body: $('#draftBody').value }) });
  closeDrawer(); loadCalendar();
};
window.setStatus = async (id, status) => {
  await api('/ws/drafts/' + encodeURIComponent(id) + '/status', { method:'POST', body: JSON.stringify({ status }) });
  closeDrawer(); loadCalendar();
};

// ══════════════ OUTREACH ══════════════
let outreachDrafts = [];
let outreachCurrentId = null;
let outreachStatusFilter = 'all';
let outreachSegmentFilter = '';
let outreachSortMode = 'newest';
let outreachSearchQuery = '';
let outreachSearchTimer = null;

const SEGMENT_LABELS = {
  career_it_pl: '🇵🇱 IT Polska',
  career_it_is: '🇮🇸 IT Islandia',
  career_chef_is: '🍽️ Gastro Islandia',
  career_chef_pl: '🍽️ Gastro Polska',
  supplier_gb: '🏢 B2B GastroBridge',
  restaurant_gb: '🍽️ GastroBridge Rest',
  automation: '🤖 Automatyzacje',
  other: 'Inne',
};

async function loadOutreach() {
  try {
    const res = await api('/ws/drafts?channel=email&limit=500');
    outreachDrafts = res.data || [];
    const countEl = $('#outreachCountBadge');
    if (countEl) countEl.textContent = outreachDrafts.length;
    renderOutreachList();
  } catch (err) {
    $('#emailList').innerHTML = `<div class="empty">Błąd ładowania draftów: ${esc(err.message)}</div>`;
  }
}

function renderOutreachList() {
  let items = [...outreachDrafts];

  // 1. Filtr Statusu
  if (outreachStatusFilter !== 'all') {
    items = items.filter(d => (d.status || 'draft') === outreachStatusFilter);
  }

  // 2. Filtr Segmentu
  if (outreachSegmentFilter) {
    items = items.filter(d => {
      const seg = (d.meta && d.meta.segment) || d.type || '';
      return seg === outreachSegmentFilter;
    });
  }

  // 3. Wyszukiwanie
  if (outreachSearchQuery.trim()) {
    const q = outreachSearchQuery.toLowerCase().trim();
    items = items.filter(d => {
      const title = (d.title || '').toLowerCase();
      const body = (d.body || '').toLowerCase();
      const recipient = ((d.enrichment && d.enrichment.email) || (d.meta && d.meta.sourceContact) || '').toLowerCase();
      const company = ((d.meta && d.meta.company) || '').toLowerCase();
      return title.includes(q) || body.includes(q) || recipient.includes(q) || company.includes(q);
    });
  }

  // 4. Sortowanie
  items.sort((a, b) => {
    if (outreachSortMode === 'newest') {
      return new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0);
    }
    if (outreachSortMode === 'oldest') {
      return new Date(a.createdAt || a.updatedAt || 0) - new Date(b.createdAt || b.updatedAt || 0);
    }
    if (outreachSortMode === 'status') {
      return (a.status || 'draft').localeCompare(b.status || 'draft');
    }
    if (outreachSortMode === 'title') {
      return (a.title || '').localeCompare(b.title || '');
    }
    return 0;
  });

  const countEl = $('#outreachCountBadge');
  if (countEl) countEl.textContent = items.length;

  if (!items.length) {
    $('#emailList').innerHTML = '<div class="empty">Brak wiadomości dla wybranych filtrów.</div>';
    return;
  }

  $('#emailList').innerHTML = items.map(d => {
    const isCurrent = d.draftId === outreachCurrentId;
    const isSent = d.status === 'sent';
    const status = d.status || 'draft';
    const seg = (d.meta && d.meta.segment) || '';
    const segLabel = SEGMENT_LABELS[seg] || seg;
    const recipient = (d.enrichment && d.enrichment.email) || (d.meta && (d.meta.company || d.meta.sourceContact)) || '';
    const dateStr = d.createdAt ? new Date(d.createdAt).toLocaleDateString('pl-PL') : '';

    let statusBadge = `<span class="badge-status-draft">📝 Draft</span>`;
    if (status === 'approved') statusBadge = `<span class="badge-status-approved">⏳ Approved</span>`;
    if (status === 'sent') statusBadge = `<span class="badge-status-sent">🚀 Wysłano</span>`;

    return `
      <div class="outreach-card ${isCurrent ? 'active' : ''} ${isSent ? 'is-sent' : ''}" onclick='showEmail(${JSON.stringify(d.draftId)})'>
        <div class="card-title">${esc(d.title || '(Bez tematu)')}</div>
        ${recipient ? `<div class="card-recipient">👤 ${esc(recipient)}</div>` : ''}
        <div class="card-meta">
          ${statusBadge}
          ${segLabel ? `<span class="badge-segment">${esc(segLabel)}</span>` : ''}
          ${d.gmailDraftId ? `<span class="badge-gmail" title="Połączono z Gmail ID: ${esc(d.gmailDraftId)}">📧 Gmail</span>` : ''}
          <span style="margin-left:auto;font-size:10px;">${esc(dateStr)}</span>
        </div>
      </div>
    `;
  }).join('');
}

window.setOutreachStatusFilter = (status) => {
  outreachStatusFilter = status;
  $$('#tab-outreach .status-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  renderOutreachList();
};

window.setOutreachSegmentFilter = (segment) => {
  outreachSegmentFilter = segment;
  renderOutreachList();
};

window.setOutreachSort = (mode) => {
  outreachSortMode = mode;
  renderOutreachList();
};

window.debounceOutreachSearch = () => {
  clearTimeout(outreachSearchTimer);
  outreachSearchTimer = setTimeout(() => {
    outreachSearchQuery = ($('#outreachSearchInput')?.value || '');
    renderOutreachList();
  }, 200);
};

window.syncGmailDrafts = async () => {
  const btn = $('#btnSyncGmail');
  const oldText = btn.textContent;
  btn.textContent = '⏳ Synchronizacja…';
  btn.disabled = true;
  try {
    const res = await api('/ws/drafts/sync-gmail', { method: 'POST' });
    btn.textContent = `✓ Zsynchronizowano (${res.synced || 0})`;
    setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2500);
    await loadOutreach();
  } catch (err) {
    alert('Błąd synchronizacji z Gmail: ' + err.message);
    btn.textContent = oldText;
    btn.disabled = false;
  }
};

window.saveDraftContent = async (id) => {
  const body = $('#outreachDraftBody')?.value;
  if (typeof body !== 'string') return;
  const btn = $('#btnSaveBody');
  if (btn) { btn.textContent = '⏳ Zapisywanie…'; btn.disabled = true; }
  try {
    await api(`/ws/drafts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    if (btn) {
      btn.textContent = '✓ Zapisano w Gmail & Splot OS!';
      setTimeout(() => { if (btn) { btn.textContent = '💾 Zapisz treść w Gmail'; btn.disabled = false; } }, 2000);
    }
  } catch (err) {
    alert('Błąd zapisu w Gmail: ' + err.message);
    if (btn) { btn.textContent = '💾 Zapisz treść w Gmail'; btn.disabled = false; }
  }
};

window.sendEmailDraft = async (id) => {
  if (!confirm('Czy na pewno chcesz wysłać ten email bezpośrednio przez Gmail?')) return;
  
  // Auto-save latest body changes from textarea if present
  const currentBody = $('#outreachDraftBody')?.value;
  if (typeof currentBody === 'string') {
    try {
      await api(`/ws/drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: currentBody }),
      });
    } catch {}
  }

  const preview = $('#emailPreview');
  const originalHTML = preview.innerHTML;
  preview.innerHTML = '<div class="empty">⏳ Wysyłanie wiadomości przez Gmail…</div>';
  try {
    const res = await api(`/ws/drafts/${encodeURIComponent(id)}/send`, { method: 'POST' });
    if (res.success) {
      await loadOutreach();
      await showEmail(id);
    } else {
      alert('Błąd wysyłki: ' + (res.error || 'Nieznany błąd'));
      preview.innerHTML = originalHTML;
    }
  } catch (err) {
    alert('Błąd wysyłki: ' + err.message);
    preview.innerHTML = originalHTML;
  }
};

window.approveEmailDraft = async (id) => {
  // Auto-save body first
  const currentBody = $('#outreachDraftBody')?.value;
  if (typeof currentBody === 'string') {
    try {
      await api(`/ws/drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: currentBody }),
      });
    } catch {}
  }
  await setStatus(id, 'approved');
  await showEmail(id);
};

window.deleteEmailDraft = async (id) => {
  if (!confirm('Czy na pewno chcesz usunąć ten draft z systemu i z Gmaila?')) return;
  try {
    await api(`/ws/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    outreachCurrentId = null;
    $('#emailPreview').innerHTML = '<div class="empty">Draft został usunięty.</div>';
    await loadOutreach();
  } catch (err) {
    alert('Błąd usuwania draftu: ' + err.message);
  }
};

window.showEmail = async (id) => {
  outreachCurrentId = id;
  renderOutreachList();
  $('#emailPreview').innerHTML = '<div class="empty">Ładowanie szczegółów draftu…</div>';

  try {
    const d = await api('/ws/drafts/' + encodeURIComponent(id));
    const enr = d.enrichment || {};
    const meta = d.meta || {};
    const status = d.status || 'draft';
    const isSent = status === 'sent';
    const isApproved = status === 'approved';
    const attachments = (enr.attachments || meta.attachments || []);

    let actionsHtml = '';
    if (isSent) {
      actionsHtml = `
        <div class="sent-banner">
          <span>✅ Wiadomość została wysłana przez Gmail</span>
          <span style="font-size:11px;font-weight:400;margin-left:auto;">${d.sentAt ? new Date(d.sentAt).toLocaleString('pl-PL') : ''}</span>
        </div>
        <div class="preview-actions-bar">
          <button class="btn ghost" onclick="deleteEmailDraft('${esc(d.draftId)}')">🗑️ Usuń z listy</button>
        </div>
      `;
    } else if (isApproved) {
      actionsHtml = `
        <div class="preview-actions-bar">
          <button class="btn btn-send-gmail" onclick="sendEmailDraft('${esc(d.draftId)}')">🚀 Wyślij teraz przez Gmail</button>
          <button class="btn ghost" onclick="saveDraftContent('${esc(d.draftId)}'); setStatus('${esc(d.draftId)}','draft'); showEmail('${esc(d.draftId)}');">↩️ Cofnij do Draftu</button>
          <button class="btn ghost" onclick="deleteEmailDraft('${esc(d.draftId)}')">🗑️ Usuń</button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="preview-actions-bar">
          <button class="btn ghost" onclick="approveEmailDraft('${esc(d.draftId)}')">✓ Zatwierdź do wysyłki</button>
          <button class="btn btn-send-gmail" onclick="sendEmailDraft('${esc(d.draftId)}')">🚀 Wyślij teraz przez Gmail</button>
          <button class="btn ghost" onclick="deleteEmailDraft('${esc(d.draftId)}')">🗑️ Usuń</button>
        </div>
      `;
    }

    let statusBadge = `<span class="badge-status-draft">📝 DRAFT</span>`;
    if (isApproved) statusBadge = `<span class="badge-status-approved">⏳ ZATWIERDZONY</span>`;
    if (isSent) statusBadge = `<span class="badge-status-sent">🚀 WYSŁANO</span>`;

    const bodySection = isSent
      ? `<div class="field"><label>Wysłana treść</label><pre class="body">${esc(d.body || '')}</pre></div>`
      : `
        <div class="field">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <label style="margin:0;">Treść wiadomości (<span id="draftCharCount">${d.body?.length || 0}</span> znaków)</label>
            <button class="btn ghost btn-sm" id="btnSaveBody" onclick="saveDraftContent('${esc(d.draftId)}')">💾 Zapisz treść w Gmail</button>
          </div>
          <textarea id="outreachDraftBody" style="width:100%;min-height:220px;font-family:inherit;font-size:13px;line-height:1.5;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);resize:vertical;" oninput="$('#draftCharCount').textContent = this.value.length">${esc(d.body || '')}</textarea>
        </div>
      `;

    $('#emailPreview').innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <h3 style="margin:0;font-size:16px;color:var(--text);">${esc(d.title || '(Bez tematu)')}</h3>
        ${statusBadge}
      </div>

      <div class="field" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        ${d.gmailDraftId ? `<span class="badge-gmail">📧 Gmail ID: <code>${esc(d.gmailDraftId)}</code></span>` : ''}
        ${meta.segment ? `<span class="badge-segment">${esc(SEGMENT_LABELS[meta.segment] || meta.segment)}</span>` : ''}
        <span class="badge lang">Język: ${esc(d.language?.toUpperCase() || 'PL')}</span>
      </div>

      ${enr.email || meta.company ? `
        <div class="field">
          <label>Odbiorca i Kontakt</label>
          <div class="v"><b>${esc(enr.email || meta.sourceContact || meta.company)}</b> ${enr.website ? `· <a href="${esc(enr.website)}" target="_blank" rel="noopener">${esc(enr.website)}</a>` : ''}</div>
        </div>
      ` : ''}

      ${attachments.length ? `
        <div class="field">
          <label>Załączniki (${attachments.length})</label>
          <div class="v">
            ${attachments.map(att => `<div style="font-size:12px;color:var(--accent);margin:2px 0;">📎 ${esc(att.filename || att.name || 'Plik')}</div>`).join('')}
          </div>
        </div>
      ` : ''}

      ${d.rationale || enr.reason ? `
        <div class="field">
          <label>Uzasadnienie / Dlaczego ten lead</label>
          <div class="v" style="color:var(--muted);font-size:12px;">${esc(d.rationale || enr.reason)}</div>
        </div>
      ` : ''}

      ${bodySection}

      ${actionsHtml}
    `;
  } catch (err) {
    $('#emailPreview').innerHTML = `<div class="empty">Błąd ładowania draftu: ${esc(err.message)}</div>`;
  }
};


// ══════════════ CHEF ══════════════
async function loadChef() {
  const res = await api('/ws/chef/projects');
  $('#chefList').innerHTML = res.data.map(p => `
    <div class="signal" onclick='showChef(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name||'(projekt)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteChefProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(p.status||'')} · ${esc(p.profile?.establishmentType||'')}</div>
    </div>`).join('') || '<div class="empty">Brak projektów.</div>';
}
window.deleteChefProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć projekt Chef?',
    message: `Projekt ${id}, jego menu i Księga Menu zostaną usunięte z bazy oraz dysku. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try {
    await api('/ws/chef/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    $('#chefMenus').innerHTML = '<div class="empty">Projekt został usunięty.</div>';
    $('#bookView').innerHTML = '<div class="empty">Księga menu została usunięta.</div>';
    await loadChef();
    await loadBooks();
  } catch (err) {
    alert('Błąd podczas usuwania projektu chef.');
  }
};
window.showChef = async (id) => {
  $('#chefMenus').innerHTML = '<div class="empty">Ładuję menu…</div>';
  // Quick menu preview (structured chef_menus — the dish list, as before). The
  // fully branded document/PDF lives in the "Księgi Menu" tab; here we just add a
  // shortcut button so both views are one click apart.
  try {
    const res = await api('/ws/chef/menus/' + encodeURIComponent(id));
    const bookHtmlUrl = qualifyMediaUrl(`/ws/chef/book/${encodeURIComponent(id)}/html`);
    const bookBtn = `<a href="${bookHtmlUrl}" target="_blank" rel="noopener"
        class="btn ghost" style="text-decoration:none">📖 Otwórz Księgę Menu (HTML)</a>
        <button class="btn ghost" onclick="switchTab('books'); showBook('${esc(id)}');" style="margin-left:8px">📖 Zobacz w Księgach Menu</button>
        <button class="btn ghost danger" onclick="deleteChefProject('${esc(id)}');" style="margin-left:8px">Usuń projekt</button>`;
    const list = res.data.map(m => `
      <div class="field"><h3>${esc(m.title)} (v${m.version})</h3>
        <div class="v" style="color:var(--muted);margin-bottom:8px">${esc(m.narrative||'')}</div>
        ${(m.sections||[]).map(sec=>`<div style="margin:8px 0"><b>${esc(sec.name)}</b>${(sec.dishes||[]).map(dish=>`
          <div class="hook"><b>${esc(dish.name)}</b><br><span class="s">${esc(dish.description||'')}</span></div>`).join('')}</div>`).join('')}
      </div>`).join('');
    $('#chefMenus').innerHTML =
      `<div style="margin-bottom:10px">${bookBtn}</div>` +
      (list || '<div class="empty">Brak ustrukturyzowanego menu (chef_menus) w tym projekcie.</div>');
  } catch (err) {
    $('#chefMenus').innerHTML = '<div class="empty">Brak danych menu dla tego projektu.</div>';
  }
};

// ══════════════ MENU BOOKS (chefAgent — deliverables + PDF) ══════════════
async function loadBooks() {
  const res = await api('/ws/chef/books');
  $('#booksList').innerHTML = res.data.map(b => {
    const tags = [b.hasPdf ? '✓ PDF' : 'tylko MD', b.profile?.establishmentType].filter(Boolean).join(' · ');
    const when = b.pdfUpdatedAt || b.mdUpdatedAt || b.updatedAt;
    return `<div class="signal" onclick='showBook(${JSON.stringify(b.id)})'>
      <div class="signal-head">
        <div class="t">${esc(b.name||'(projekt)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteChefProject(${JSON.stringify(b.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(b.status||'')}${tags?' · '+esc(tags):''}${when?' · '+esc(String(when).slice(0,10)):''}</div>
    </div>`;
  }).join('') || '<div class="empty">Brak Ksiąg Menu na dysku. Uruchom chefAgenta.</div>';
}
window.showBook = async (id) => {
  $('#bookView').innerHTML = '<div class="empty">Ładuję Księgę Menu…</div>';
  try {
    const res = await api('/ws/chef/book/' + encodeURIComponent(id));
    // Probe PDF availability so the button only shows when a render exists.
    let pdfUrl = '/ws/chef/book/' + encodeURIComponent(id) + '/pdf';
    try {
      const head = await fetch(pdfUrl, { method: 'HEAD' });
      if (!head.ok) pdfUrl = null;
    } catch { pdfUrl = null; }
    mountDocViewer('#bookView', {
      title: '📖 Księga Menu',
      htmlUrl: '/ws/chef/book/' + encodeURIComponent(id) + '/html',
      rawText: res.data.content,
      path: res.data.path,
      pdfUrl,
    });
  } catch (err) {
    $('#bookView').innerHTML = `<div class="empty">Brak Księgi Menu na dysku dla tego projektu.</div>`;
  }
};

// ══════════════ CONTENT PACKS (contentAgent) ══════════════
async function loadPacks() {
  const res = await api('/ws/content/projects');
  $('#packsList').innerHTML = res.data.map(p => {
    const t = p.targets || {};
    const tline = ['linkedin','instagram','tiktok'].map(k => {
      const n = t[k] || (t.targets && t.targets[k]);
      return n ? `${k[0].toUpperCase()}${k.slice(1)}: ${typeof n==='object'?(n.count??'?'):n}` : null;
    }).filter(Boolean).join(' · ');
    return `<div class="signal" onclick='showPack(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name||'(projekt)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteContentProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(p.status||'')}${p.weekDate?' · '+esc(p.weekDate):''}${tline?' · '+esc(tline):''}</div>
    </div>`;
  }).join('') || '<div class="empty">Brak projektów content. Uruchom contentAgenta.</div>';
}
window.deleteContentProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć Content Pack?',
    message: `Pakiet ${id} zostanie usunięty z bazy oraz dysku. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try {
    await api('/ws/content/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    $('#packView').innerHTML = '<div class="empty">Pakiet treści został usunięty.</div>';
    await loadPacks();
  } catch (err) {
    alert('Błąd podczas usuwania pakietu treści.');
  }
};
// Shared branded-document viewer: iframe (HTML) + Markdown toggle + open-in-new-tab
// + optional PDF button. Used by Content Packs, Chef menus and Menu Books.
let docViewerSeq = 0;
function mountDocViewer(containerSel, opts) {
  // opts: { title, htmlUrl, rawText, path, pdfUrl, markdownUrl }
  const uid = 'dv' + (++docViewerSeq);
  const htmlUrl = qualifyMediaUrl(opts.htmlUrl);
  const pdfUrl = qualifyMediaUrl(opts.pdfUrl);
  const standaloneHtmlUrl = qualifyMediaUrl(opts.standaloneHtmlUrl);
  const markdownUrl = qualifyMediaUrl(opts.markdownUrl);
  const pdfBtn = pdfUrl
    ? `<a href="${pdfUrl}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">📕 Otwórz PDF</a>`
    : '';
  const standaloneBtn = standaloneHtmlUrl
    ? `<a href="${standaloneHtmlUrl}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">📖 Wydanie HTML</a>`
    : '';
  const mdBtn = markdownUrl
    ? `<a href="${markdownUrl}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">⬇ Markdown</a>`
    : '';
  $(containerSel).innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
      <h3 style="margin:0">${esc(opts.title)}</h3>
      <a href="${htmlUrl}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">↗ Otwórz w nowej karcie</a>
      ${pdfBtn}
      ${standaloneBtn}
      ${mdBtn}
      <button id="${uid}-btn" class="btn ghost" data-raw="0">📄 Markdown</button>
    </div>
    ${opts.path ? `<div class="s" style="margin-bottom:8px;color:var(--muted)">${esc(opts.path)}</div>` : ''}
    <iframe id="${uid}-frame" src="${htmlUrl}" title="${esc(opts.title)}"
      style="width:100%;height:72vh;border:1px solid var(--line);border-radius:12px;background:#ffffff"></iframe>
    <pre id="${uid}-raw" class="body" style="display:none"></pre>`;
  const btn = document.getElementById(uid + '-btn');
  const frame = document.getElementById(uid + '-frame');
  const raw = document.getElementById(uid + '-raw');
  raw.textContent = opts.rawText || '';
  btn.onclick = () => {
    const showingRaw = btn.dataset.raw === '1';
    btn.dataset.raw = showingRaw ? '0' : '1';
    frame.style.display = showingRaw ? '' : 'none';
    raw.style.display = showingRaw ? 'none' : '';
    btn.textContent = showingRaw ? '📄 Markdown' : '🎨 Widok HTML';
  };
}

// ══════════════ WRITER MANUSCRIPTS (writerAgent) ══════════════
function writerDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toLocaleDateString('pl-PL');
}

function writerQualityLabel(summary) {
  if (!summary || !summary.total) return 'bez audytów';
  const parts = [];
  if (summary.latestSlopScore != null) parts.push('slop ' + summary.latestSlopScore);
  if (summary.blockingCount) parts.push(summary.blockingCount + ' blok.');
  if (summary.latestRevisionDecision) parts.push(String(summary.latestRevisionDecision).slice(0, 24));
  return parts.join(' · ') || (summary.latest?.ok === false ? 'wymaga uwagi' : 'OK');
}

async function loadWriter() {
  const res = await api('/ws/writer/projects?limit=100');
  $('#writerList').innerHTML = res.data.map(p => {
    const tags = [
      p.type,
      p.deliverableLanguage,
      p.hasDocument ? `${p.wordCount || 0} słów` : 'brak pliku',
      writerQualityLabel(p.auditSummary),
    ].filter(Boolean).join(' · ');
    const when = p.documentUpdatedAt || p.updatedAt;
    return `<div class="signal" onclick='showWriter(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name || '(projekt writer)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteWriterProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(p.status || '')}${tags ? ' · ' + esc(tags) : ''}${when ? ' · ' + esc(writerDate(when)) : ''}</div>
    </div>`;
  }).join('') || '<div class="empty">Brak projektów writerAgent. Zleć writerAgentowi opowiadanie, książkę, raport lub artykuł.</div>';
}
window.deleteWriterProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć projekt Writer?',
    message: `Projekt ${id}, manuskrypt i powiązane dane zostaną usunięte z bazy oraz dysku. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try {
    await api('/ws/writer/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    $('#writerView').innerHTML = '<div class="empty">Projekt pisarza został usunięty.</div>';
    await loadWriter();
  } catch (err) {
    alert('Błąd podczas usuwania projektu pisarza.');
  }
};

function writerMetric(label, value) {
  return `<div class="stat"><div class="n">${esc(value ?? '—')}</div><div class="l">${esc(label)}</div></div>`;
}

function writerPanel(bundle) {
  const p = bundle.project || {};
  const continuity = bundle.continuity || {};
  const claimSummary = bundle.claimSummary || {};
  const auditSummary = bundle.auditSummary || {};
  const characters = Array.isArray(continuity.characters) ? continuity.characters.length : 0;
  const timeline = Array.isArray(continuity.timeline) ? continuity.timeline.length : 0;
  const openPromises = (continuity.promises || []).filter(x => x.status === 'open').length;
  const openQuestions = (continuity.questions || []).filter(x => x.status === 'open').length;
  const latestAudit = auditSummary.latest?.summary || '';
  return `
    <div class="stats" style="margin-bottom:12px">
      ${writerMetric('Typ', p.type)}
      ${writerMetric('Status', p.status)}
      ${writerMetric('Język', p.deliverableLanguage)}
      ${writerMetric('Słowa', p.wordCount || 0)}
    </div>
    <div class="panes" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:12px">
      <div class="pane">
        <h3>Fiction / continuity</h3>
        <div class="s">Postacie: ${characters} · timeline: ${timeline}</div>
        <div class="s">Otwarte obietnice: ${openPromises} · pytania: ${openQuestions}</div>
      </div>
      <div class="pane">
        <h3>Fakty / claims</h3>
        <div class="s">Źródła: ${(bundle.sources || []).length} · claims: ${claimSummary.total || 0}</div>
        <div class="s">Unsupported high-risk: ${claimSummary.highRiskUnsupported || 0} · konflikty: ${claimSummary.conflicting || 0}</div>
      </div>
      <div class="pane">
        <h3>Quality</h3>
        <div class="s">Slop: ${auditSummary.latestSlopScore ?? '—'} · blokujące audyty: ${auditSummary.blockingCount || 0}</div>
        <div class="s">${esc(latestAudit || writerQualityLabel(auditSummary))}</div>
      </div>
    </div>`;
}

window.showWriter = async (id) => {
  $('#writerView').innerHTML = '<div class="empty">Ładuję projekt writerAgent…</div>';
  try {
    const res = await api('/ws/writer/projects/' + encodeURIComponent(id));
    const bundle = res.data;
    const doc = bundle.document;
    $('#writerView').innerHTML = writerPanel(bundle) + '<div id="writerDocView"></div>';
    if (doc && doc.content) {
      mountDocViewer('#writerDocView', {
        title: '✍️ Manuskrypt Writer',
        htmlUrl: '/ws/writer/projects/' + encodeURIComponent(id) + '/html',
        markdownUrl: '/ws/writer/projects/' + encodeURIComponent(id) + '/markdown',
        pdfUrl: bundle.hasPdf ? ('/ws/writer/projects/' + encodeURIComponent(id) + '/pdf') : undefined,
        standaloneHtmlUrl: bundle.hasStandaloneHtml ? ('/ws/writer/projects/' + encodeURIComponent(id) + '/standalone-html') : undefined,
        rawText: doc.content,
        path: doc.path,
      });
    } else {
      $('#writerDocView').innerHTML = `<div class="empty">Ten projekt nie ma jeszcze pliku manuscript.md w ${esc(bundle.project?.projectDir || '')}.</div>`;
    }
  } catch (err) {
    $('#writerView').innerHTML = '<div class="empty">Brak danych projektu writerAgent.</div>';
  }
};

// ══════════════ DESIGNER OUTPUTS (designAgent) ══════════════
let designBundle = null;
function designDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toLocaleString('pl-PL');
}
function designBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function designMetric(label, value) {
  return `<div class="stat"><div class="n">${esc(value ?? '—')}</div><div class="l">${esc(label)}</div></div>`;
}
function designKindLabel(kind) {
  return ({
    html: 'HTML',
    image: 'Obraz',
    video: 'Wideo',
    audio: 'Audio',
    pdf: 'PDF',
    pptx: 'PPTX',
    support: 'Plik',
  })[kind] || kind || 'Plik';
}
function designProjectSubline(p) {
  return [
    p.type,
    `${p.artifactCount || 0} artef.`,
    p.htmlCount ? `${p.htmlCount} HTML` : null,
    p.mediaCount ? `${p.mediaCount} media` : null,
    p.exportCount ? `${p.exportCount} export` : null,
    p.updatedAt ? designDate(p.updatedAt) : null,
  ].filter(Boolean).join(' · ');
}
async function loadDesigner() {
  const res = await api('/ws/design/projects?limit=100');
  const projects = res.data || [];
  const selectedId = window.__designSelectedId && projects.some(p => p.id === window.__designSelectedId)
    ? window.__designSelectedId
    : projects[0]?.id;
  $('#designList').innerHTML = projects.map(p => `
    <div class="signal ${p.id === selectedId ? 'active' : ''}" data-design-id="${esc(p.id)}" onclick='showDesignProject(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name || '(projekt designer)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteDesignProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(designProjectSubline(p))}${p.previewAsset ? ' · preview' : ''}</div>
    </div>`).join('') || '<div class="empty">Brak projektów designAgent. Artefakty pojawią się po utworzeniu HTML/prototypu/decku w design-work albo design-demos.</div>';
  if (selectedId) showDesignProject(selectedId);
  else $('#designView').innerHTML = '<div class="empty">Brak artefaktów do podglądu.</div>';
}
window.showDesignProject = async (id) => {
  window.__designSelectedId = id;
  $$('#designList .signal').forEach(el => el.classList.toggle('active', el.dataset.designId === id));
  $('#designView').innerHTML = '<div class="empty">Ładuję projekt designAgent…</div>';
  try {
    const res = await api('/ws/design/projects/' + encodeURIComponent(id));
    designBundle = res.data;
    renderDesignProject(designBundle);
  } catch (err) {
    $('#designView').innerHTML = '<div class="empty">Brak danych projektu designAgent.</div>';
  }
};
window.deleteDesignProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć projekt Designer?',
    message: `Projekt ${id} i wszystkie jego artefakty zostaną usunięte z dysku. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try {
    await api('/ws/design/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    if (window.__designSelectedId === id) window.__designSelectedId = null;
    $('#designView').innerHTML = '<div class="empty">Projekt designera został usunięty.</div>';
    await loadDesigner();
  } catch (err) {
    alert('Błąd podczas usuwania projektu designera.');
  }
};
window.showDesignAsset = (assetId) => {
  if (!designBundle) return;
  renderDesignProject(designBundle, assetId);
};
function designPreviewHtml(asset) {
  if (!asset) return '<div class="empty">Ten projekt nie ma jeszcze pliku do podglądu.</div>';
  const rawUrl = qualifyMediaUrl(asset.url);
  const url = esc(rawUrl);
  if (asset.kind === 'html') {
    return `<iframe src="${url}" title="${esc(asset.name)}" sandbox="allow-scripts allow-forms allow-popups allow-downloads" style="width:100%;height:68vh;border:1px solid var(--line);border-radius:8px;background:#ffffff;"></iframe>`;
  }
  if (asset.kind === 'image') return `<img src="${url}" alt="${esc(asset.name)}" style="max-width:100%;border-radius:8px;">`;
  if (asset.kind === 'video') return `<video controls preload="metadata" src="${url}#t=0.1" style="width:100%;border-radius:8px;"></video>`;
  if (asset.kind === 'audio') return `<audio controls preload="metadata" src="${url}" style="width:100%;"></audio>`;
  if (asset.kind === 'pdf') return `<iframe src="${url}" title="${esc(asset.name)}" style="width:100%;height:68vh;border-radius:8px;"></iframe>`;
  return `<div class="empty">Ten typ pliku otwórz w nowej karcie: ${esc(asset.name)}</div>`;
}
function designAssetCard(asset, selectedAssetId) {
  const active = asset.id === selectedAssetId ? 'active' : '';
  const when = asset.updatedAt ? ' · ' + designDate(asset.updatedAt) : '';
  const canPreview = asset.previewable ? '' : ' · download';
  return `<div class="design-asset ${active}" onclick='showDesignAsset(${JSON.stringify(asset.id)})'>
    <div class="t">${esc(designKindLabel(asset.kind))} · ${esc(asset.name)}</div>
    <div class="s">${esc(asset.relativePath)}</div>
    <div class="s">${esc(designBytes(asset.bytes))}${when}${canPreview}</div>
  </div>`;
}
function renderDesignProject(bundle, assetId) {
  const project = bundle.project || {};
  const assets = bundle.assets || [];
  const selectedAsset = assets.find(a => a.id === assetId)
    || assets.find(a => a.id === project.previewAsset?.id)
    || assets[0]
    || null;
  const openBtn = selectedAsset
    ? `<a href="${esc(selectedAsset.url)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">Otwórz podgląd</a>`
    : '';
  const deleteBtn = project.id
    ? `<button class="btn ghost danger" onclick='deleteDesignProject(${JSON.stringify(project.id)})'>Usuń projekt</button>`
    : '';
  const openDir = project.relativeProjectDir
    ? `<span class="badge lang">${esc(project.relativeProjectDir)}</span>`
    : '';
  $('#designView').innerHTML = `
    <div class="film-titlebar">
      <div>
        <h2>🎨 ${esc(project.name || '(projekt designer)')}</h2>
        <div class="s">${esc(project.type || '')} ${openDir}</div>
      </div>
      <div class="design-toolbar">
        ${openBtn}
        ${deleteBtn}
      </div>
    </div>
    <div class="design-stage">
      <div>
        <div class="design-preview">${designPreviewHtml(selectedAsset)}</div>
        <div class="film-prompt">${esc(selectedAsset?.relativePath || project.projectDir || 'Brak wybranego artefaktu.')}</div>
      </div>
      <div class="film-sidebar">
        <div class="film-kv">
          ${designMetric('Typ', project.type)}
          ${designMetric('Artefakty', project.artifactCount || 0)}
          ${designMetric('HTML', project.htmlCount || 0)}
          ${designMetric('Obrazy', project.imageCount || 0)}
          ${designMetric('Media', project.mediaCount || 0)}
          ${designMetric('Export', project.exportCount || 0)}
        </div>
        <div class="field">
          <label>Wybrany artefakt</label>
          <div class="v">${esc(selectedAsset ? selectedAsset.name : '—')}</div>
          ${selectedAsset ? `<div class="s">${esc(designKindLabel(selectedAsset.kind))} · ${esc(designBytes(selectedAsset.bytes))}</div>` : ''}
        </div>
        <h3>Artefakty</h3>
        ${assets.map(asset => designAssetCard(asset, selectedAsset?.id)).join('') || '<div class="empty">Brak artefaktów.</div>'}
      </div>
    </div>`;
}

// ══════════════ FILMMAKER VIDEOS (filmmakerAgent) ══════════════
let filmBundle = null;
function filmDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toLocaleString('pl-PL');
}
function filmShortId(value) {
  const s = String(value || '');
  return s.length > 18 ? s.slice(0, 8) + '…' + s.slice(-6) : s || '—';
}
function filmMetric(label, value) {
  return `<div class="stat"><div class="n">${esc(value ?? '—')}</div><div class="l">${esc(label)}</div></div>`;
}
function filmProjectSubline(p) {
  return [
    p.status,
    p.projectMode,
    `${p.generatedRunCount || 0} wideo`,
    `${p.clipCount || 0} klipów`,
    p.updatedAt ? filmDate(p.updatedAt) : null,
  ].filter(Boolean).join(' · ');
}
async function loadFilmmaker() {
  const res = await api('/ws/filmmaker/projects?limit=100');
  const projects = res.data || [];
  const selectedId = window.__filmSelectedId && projects.some(p => p.id === window.__filmSelectedId)
    ? window.__filmSelectedId
    : projects[0]?.id;
  $('#filmList').innerHTML = projects.map(p => `
    <div class="signal ${p.id === selectedId ? 'active' : ''}" data-film-id="${esc(p.id)}" onclick='showFilmProject(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name || '(projekt filmmaker)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteFilmProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(filmProjectSubline(p))}${p.latestVideoUrl ? ' · MP4' : ''}</div>
    </div>`).join('') || '<div class="empty">Brak projektów filmmakerAgent. Wygenerowane filmy pojawią się tutaj po runie film_generate.</div>';
  if (selectedId) showFilmProject(selectedId);
  else $('#filmView').innerHTML = '<div class="empty">Brak filmów do podglądu.</div>';
}
window.showFilmProject = async (id) => {
  window.__filmSelectedId = id;
  $$('#filmList .signal').forEach(el => el.classList.toggle('active', el.dataset.filmId === id));
  $('#filmView').innerHTML = '<div class="empty">Ładuję projekt filmmakerAgent…</div>';
  try {
    const res = await api('/ws/filmmaker/projects/' + encodeURIComponent(id));
    filmBundle = res.data;
    renderFilmProject(filmBundle);
  } catch (err) {
    $('#filmView').innerHTML = '<div class="empty">Brak danych projektu filmmakerAgent.</div>';
  }
};
function filmRunCard(run, selectedRunId) {
  const active = run.runId === selectedRunId ? 'active' : '';
  const status = run.resultStatus || 'unknown';
  return `<div class="film-run ${active}" onclick='showFilmRun(${JSON.stringify(run.runId)})'>
    <div class="t">${esc(run.clipId || 'clip')} · ${esc(status)}</div>
    <div class="s">${esc(run.inputMode || '')}${run.surface ? ' · ' + esc(run.surface) : ''}${run.hasVideo ? ' · MP4' : ''}</div>
    <div class="s">${esc(filmShortId(run.runId))}${run.createdAt ? ' · ' + esc(filmDate(run.createdAt)) : ''}</div>
  </div>`;
}
window.showFilmRun = (runId) => {
  if (!filmBundle) return;
  renderFilmProject(filmBundle, runId);
};
window.showFilmRef = (projectId, tag) => {
  const url = '/ws/filmmaker/projects/' + encodeURIComponent(projectId) + '/reference?tag=' + encodeURIComponent(tag);
  window.open(url, '_blank', 'noopener');
};
window.deleteFilmProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć projekt Filmmaker?',
    message: `Projekt ${id} i wszystkie jego runy generowania (wraz z wygenerowanymi plikami MP4) zostaną usunięte. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try {
    await api('/ws/filmmaker/projects/' + encodeURIComponent(id) + '?files=1', { method: 'DELETE' });
    if (window.__filmSelectedId === id) window.__filmSelectedId = null;
    await loadFilmmaker();
  } catch (err) {
    alert('Błąd usuwania projektu filmmaker.');
  }
};
function renderFilmProject(bundle, runId) {
  const project = bundle.project || {};
  const story = project.story || {};
  const rawRuns = bundle.runs || [];
  const runs = [...rawRuns].sort((a, b) => {
    if (!!b.hasVideo !== !!a.hasVideo) return (b.hasVideo ? 1 : 0) - (a.hasVideo ? 1 : 0);
    return 0;
  });
  const selectedRun = runs.find(r => r.runId === runId)
    || runs.find(r => r.hasVideo)
    || runs[0]
    || null;
  const videoUrl = qualifyMediaUrl(selectedRun?.videoUrl);
  const video = videoUrl
    ? `<video controls preload="metadata" src="${esc(videoUrl)}#t=0.1"></video>`
    : '<div class="empty">Ten projekt nie ma jeszcze pobranego MP4.</div>';
  const openBtn = videoUrl
    ? `<a href="${esc(videoUrl)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">Otwórz MP4</a>`
    : '';
  const refs = bundle.references || [];
  const refBtns = refs.filter(r => r?.tag).map(r =>
    `<button class="btn ghost" onclick='showFilmRef(${JSON.stringify(project.id)}, ${JSON.stringify(r.tag)})'>Zdjęcie wejściowe ${esc(r.tag)}</button>`
  ).join('');
  const deleteBtn = project.id
    ? `<button class="btn ghost danger" onclick='deleteFilmProject(${JSON.stringify(project.id)})'>Usuń projekt</button>`
    : '';
  const runTask = selectedRun?.taskId ? ` · task ${filmShortId(selectedRun.taskId)}` : '';
  $('#filmView').innerHTML = `
    <div class="film-titlebar">
      <div>
        <h2>🎬 ${esc(project.name || '(projekt filmmaker)')}</h2>
        <div class="s">${esc(story.objective || story.logline || '')}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${openBtn}
        ${refBtns}
        ${selectedRun?.outputUrl ? `<a href="${esc(selectedRun.outputUrl)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">Źródło FAL</a>` : ''}
        ${deleteBtn}
      </div>
    </div>
    <div class="film-stage">
      <div>
        <div class="film-screen">${video}</div>
        <div class="film-prompt">${esc(selectedRun?.prompt || story.objective || 'Brak promptu dla wybranego runu.')}</div>
      </div>
      <div class="film-sidebar">
        <div class="film-kv">
          ${filmMetric('Status', project.status)}
          ${filmMetric('Tryb', project.projectMode)}
          ${filmMetric('Klipy', project.clipCount || 0)}
          ${filmMetric('Runy', project.runCount || 0)}
          ${filmMetric('Accepted', project.acceptedClipCount || 0)}
          ${filmMetric('Surface', project.surface?.surface || selectedRun?.surface || '—')}
        </div>
        <div class="field">
          <label>Wybrany run</label>
          <div class="v">${esc(selectedRun ? filmShortId(selectedRun.runId) + runTask : '—')}</div>
          ${selectedRun?.modelId ? `<div class="s">${esc(selectedRun.modelId)}</div>` : ''}
          ${selectedRun?.error ? `<div class="hook" style="border-left-color:var(--red)">${esc(selectedRun.error)}</div>` : ''}
        </div>
        <h3>Generation runs</h3>
        ${runs.map(run => filmRunCard(run, selectedRun?.runId)).join('') || '<div class="empty">Brak runów generowania.</div>'}
      </div>
    </div>`;
}

// ══════════════ MUSICIAN TRACKS (musicianAgent) ══════════════
let musicBundle = null;
function musicDate(value){ if(!value) return ''; const d=new Date(value); return Number.isNaN(d.getTime())?String(value).slice(0,10):d.toLocaleString('pl-PL'); }
function musicShortId(value){ const s=String(value||''); return s.length>18?s.slice(0,8)+'…'+s.slice(-6):s||'—'; }
function musicMetric(label,value){ return `<div class="stat"><div class="n">${esc(value??'—')}</div><div class="l">${esc(label)}</div></div>`; }
function musicProjectSubline(p){ return [p.status,p.projectMode,`${p.generatedRunCount||0} audio`,`${p.trackCount||0} ścieżek`,p.updatedAt?musicDate(p.updatedAt):null].filter(Boolean).join(' · '); }
async function loadMusician(){
  const res = await api('/ws/musician/projects?limit=100');
  const projects = res.data || [];
  const selectedId = window.__musicSelectedId && projects.some(p=>p.id===window.__musicSelectedId) ? window.__musicSelectedId : projects[0]?.id;
  $('#musicList').innerHTML = projects.map(p=>`
    <div class="signal ${p.id===selectedId?'active':''}" data-music-id="${esc(p.id)}" onclick='showMusicProject(${JSON.stringify(p.id)})'>
      <div class="signal-head">
        <div class="t">${esc(p.name||'(projekt musician)')}</div>
        <button class="btn ghost danger signal-delete" onclick='event.stopPropagation(); deleteMusicProject(${JSON.stringify(p.id)})'>Usuń</button>
      </div>
      <div class="s">${esc(musicProjectSubline(p))}${p.latestAudioUrl?' · audio':''}</div>
    </div>`).join('') || '<div class="empty">Brak projektów musicianAgent. Wygenerowane utwory pojawią się tutaj po runie music_generate.</div>';
  if (selectedId) showMusicProject(selectedId);
  else $('#musicView').innerHTML = '<div class="empty">Brak utworów do odtworzenia.</div>';
}
window.showMusicProject = async (id) => {
  window.__musicSelectedId = id;
  $$('#musicList .signal').forEach(el=>el.classList.toggle('active', el.dataset.musicId===id));
  $('#musicView').innerHTML = '<div class="empty">Ładuję projekt musicianAgent…</div>';
  try { const res = await api('/ws/musician/projects/'+encodeURIComponent(id)); musicBundle=res.data; renderMusicProject(musicBundle); }
  catch(err){ $('#musicView').innerHTML='<div class="empty">Brak danych projektu musicianAgent.</div>'; }
};
function musicRunCard(run, selectedRunId){
  const active = run.runId===selectedRunId?'active':'';
  const status = run.resultStatus||'unknown';
  return `<div class="film-run ${active}" onclick='showMusicRun(${JSON.stringify(run.runId)})'>
    <div class="t">${esc(run.trackId||'track')} · ${esc(status)}</div>
    <div class="s">${esc(run.inputMode||'')}${run.surface?' · '+esc(run.surface):''}${run.hasAudio?' · audio':''}</div>
    <div class="s">${esc(musicShortId(run.runId))}${run.createdAt?' · '+esc(musicDate(run.createdAt)):''}</div>
  </div>`;
}
window.showMusicRun = (runId) => { if(!musicBundle) return; renderMusicProject(musicBundle, runId); };
window.deleteMusicProject = async (id) => {
  const { confirmed } = await confirmWorkspaceProjectDeletion({
    title: 'Usunąć projekt Musician?',
    message: `Projekt ${id} i wszystkie jego runy generowania (wraz z wygenerowanymi plikami audio) zostaną usunięte. Tej operacji nie można cofnąć.`,
  });
  if (!confirmed) return;
  try { await api('/ws/musician/projects/'+encodeURIComponent(id)+'?files=1',{method:'DELETE'}); if(window.__musicSelectedId===id) window.__musicSelectedId=null; await loadMusician(); }
  catch(err){ alert('Błąd usuwania projektu musician.'); }
};
function renderMusicProject(bundle, runId){
  const project = bundle.project||{};
  const rawRuns = bundle.runs||[];
  const runs = [...rawRuns].sort((a,b)=>{ if(!!b.hasAudio!==!!a.hasAudio) return (b.hasAudio?1:0)-(a.hasAudio?1:0); return 0; });
  const selectedRun = runs.find(r=>r.runId===runId) || runs.find(r=>r.hasAudio) || runs[0] || null;
  const audioUrl = qualifyMediaUrl(selectedRun?.audioUrl);
  const player = audioUrl
    ? `<audio controls preload="metadata" src="${esc(audioUrl)}" style="width:100%"></audio>`
    : '<div class="empty">Ten projekt nie ma jeszcze pobranego audio.</div>';
  const openBtn = audioUrl ? `<a href="${esc(audioUrl)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">Otwórz audio</a>` : '';
  const deleteBtn = project.id ? `<button class="btn ghost danger" onclick='deleteMusicProject(${JSON.stringify(project.id)})'>Usuń projekt</button>` : '';
  const runTask = selectedRun?.taskId ? ` · task ${musicShortId(selectedRun.taskId)}` : '';
  $('#musicView').innerHTML = `
    <div class="film-titlebar">
      <div>
        <h2>🎵 ${esc(project.name||'(projekt musician)')}</h2>
        <div class="s">${esc(selectedRun?.inputMode || project.status || '')}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${openBtn}
        ${selectedRun?.outputUrl ? `<a href="${esc(selectedRun.outputUrl)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none">Źródło</a>` : ''}
        ${deleteBtn}
      </div>
    </div>
    <div class="film-stage">
      <div>
        <div class="film-screen">${player}</div>
        <div class="film-prompt">${esc(selectedRun?.prompt || 'Brak promptu dla wybranego runu.')}</div>
      </div>
      <div class="film-sidebar">
        <div class="film-kv">
          ${musicMetric('Status', project.status)}
          ${musicMetric('Tryb', project.projectMode)}
          ${musicMetric('Ścieżki', project.trackCount||0)}
          ${musicMetric('Runy', project.runCount||0)}
          ${musicMetric('Accepted', project.acceptedTrackCount||0)}
          ${musicMetric('Surface', project.surface?.surface || selectedRun?.surface || '—')}
        </div>
        <div class="field">
          <label>Wybrany run</label>
          <div class="v">${esc(selectedRun ? musicShortId(selectedRun.runId)+runTask : '—')}</div>
          ${selectedRun?.modelId ? `<div class="s">${esc(selectedRun.modelId)}</div>` : ''}
          ${selectedRun?.error ? `<div class="hook" style="border-left-color:var(--red)">${esc(selectedRun.error)}</div>` : ''}
        </div>
        <h3>Generation runs</h3>
        ${runs.map(run=>musicRunCard(run, selectedRun?.runId)).join('') || '<div class="empty">Brak runów generowania.</div>'}
      </div>
    </div>`;
}

window.showPack = async (id) => {
  $('#packView').innerHTML = '<div class="empty">Ładuję Content Pack…</div>';
  try {
    const res = await api('/ws/content/pack/' + encodeURIComponent(id));
    mountDocViewer('#packView', {
      title: '📣 Content Pack',
      htmlUrl: '/ws/content/pack/' + encodeURIComponent(id) + '/html',
      rawText: res.data.content,
      path: res.data.path,
    });
  } catch (err) {
    $('#packView').innerHTML = `<div class="empty">Brak Content Packu na dysku dla tego projektu (jeszcze nie zainicjowany).</div>`;
  }
};

// ── Reindex ──
$('#reindexBtn').onclick = async () => {
  $('#reindexBtn').textContent = '↻ Indeksuję…';
  const r = await api('/ws/drafts/reindex', { method:'POST' });
  $('#reindexBtn').textContent = `↻ Reindex (${r.indexed})`;
  setTimeout(() => $('#reindexBtn').textContent = '↻ Reindex draftów', 2500);
  if (!$('#tab-content').classList.contains('hidden')) loadCalendar();
  if (!$('#tab-outreach').classList.contains('hidden')) loadOutreach();
};

// ── init ──
try { loadCRM(); } catch(e) {}

// TAB LOGIC
    document.querySelectorAll('.top-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.app-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const targetId = tab.getAttribute('data-target');
        document.getElementById(targetId).classList.add('active');
      });
    });

    // CLOCK
    setInterval(() => {
      const now = new Date();
      const st = document.getElementById('sys-time');
      if (st) st.textContent = now.toLocaleTimeString('en-US', { hour12: false });
    }, 1000);

    // ── CINEMATIC BOOT SEQUENCE ──
    const BOOT_STEPS = [
      { t: 'IGNITION',      l: 'powering arc-reactor core…',     p: 12 },
      { t: 'CALIBRATING',   l: 'aligning orbital lattice…',      p: 34 },
      { t: 'LINKING',       l: 'establishing agent uplinks…',    p: 58 },
      { t: 'SYNCING',       l: 'streaming telemetry · n8n · mastra…', p: 80 },
      { t: 'ONLINE',        l: 'all systems nominal',            p: 100 },
    ];
    function runBootSequence() {
      const overlay = document.getElementById('boot-overlay');
      if (!overlay) return;
      const txt = document.getElementById('boot-text');
      const log = document.getElementById('boot-log');
      const bar = document.getElementById('boot-bar-fill');
      let i = 0;
      const tick = () => {
        if (i >= BOOT_STEPS.length) {
          setTimeout(() => overlay.classList.add('hidden'), 520);
          return;
        }
        const s = BOOT_STEPS[i++];
        txt.textContent = s.t;
        log.textContent = s.l;
        bar.style.width = s.p + '%';
        setTimeout(tick, i === BOOT_STEPS.length ? 480 : 560);
      };
      tick();
    }
    if (!sessionStorage.getItem('jarvis-booted')) {
      runBootSequence();
      sessionStorage.setItem('jarvis-booted', '1');
    } else {
      const overlay = document.getElementById('boot-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    // PAN/ZOOM
    const svgContainer = document.getElementById('jarvis-canvas-container');
    const svgTransform = document.getElementById('canvas-transform-svg');
    const htmlTransform = document.getElementById('canvas-transform-html');
    let panX = 0, panY = 0, scale = 1;
    let isDragging = false, startX, startY;

    // world-space center of the reactor core (see topology engine below)
    const WORLD_CX = 700, WORLD_CY = 560;
    function fitView() {
      const h = svgContainer.clientHeight || (window.innerHeight - 80);
      const w = svgContainer.clientWidth || (window.innerWidth - 300);
      if (h > 0 && w > 0) {
        scale = Math.min(1, Math.max(0.4, h / 1180));
        panX = w / 2 - WORLD_CX * scale;
        panY = h / 2 - WORLD_CY * scale;
        updateTransform();
      }
    }
    window.fitJarvisView = fitView;
    window.fetchJarvisTopology = fetchTopology;
    setTimeout(fitView, 100);
    window.addEventListener('resize', fitView);

    function updateTransform() {
      svgTransform.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
      htmlTransform.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    svgContainer.addEventListener('mousedown', (e) => {
      isDragging = true; startX = e.clientX - panX; startY = e.clientY - panY;
      svgContainer.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => {
        isDragging = false;
        svgContainer.style.cursor = 'grab';
    });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panX = e.clientX - startX; panY = e.clientY - startY;
      updateTransform();
    });
    svgContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomIntensity = 0.05;
      const wheel = e.deltaY < 0 ? 1 : -1;
      const zoom = Math.exp(wheel * zoomIntensity);
      
      const rect = svgContainer.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      panX = mouseX - (mouseX - panX) * zoom;
      panY = mouseY - (mouseY - panY) * zoom;
      scale *= zoom;
      
      scale = Math.max(0.15, Math.min(scale, 4));
      updateTransform();
    });

    // VOICE WAVEFORM
    const voiceCanvas = document.getElementById('voice-canvas');
    const vctx = voiceCanvas.getContext('2d');
    let vPhase = 0;
    function drawVoice() {
      vctx.clearRect(0, 0, voiceCanvas.width, voiceCanvas.height);
      const cx = voiceCanvas.width / 2;
      const cy = voiceCanvas.height / 2;
      
      vctx.strokeStyle = 'rgba(103, 232, 249, 0.15)';
      vctx.lineWidth = 2;
      for (let i = 1; i <= 5; i++) {
        vctx.beginPath();
        vctx.arc(cx, cy, 20 * i + Math.sin(vPhase + i) * 5, 0, Math.PI * 2);
        vctx.stroke();
      }
      
      vctx.strokeStyle = '#67e8f9';
      vctx.lineWidth = 3;
      vctx.shadowBlur = 15;
      vctx.shadowColor = '#67e8f9';
      vctx.beginPath();
      vctx.arc(cx, cy, 30 + Math.sin(vPhase * 3) * 8, 0, Math.PI * 2);
      vctx.stroke();
      vctx.shadowBlur = 0;
      
      vPhase += 0.04;
      requestAnimationFrame(drawVoice);
    }
    drawVoice();

    // JARVIS TOPOLOGY LOGIC
    async function fetchTopology() {
      try {
        const res = await fetch(API + '/dashboard/active-topology');
        if (!res.ok) return;
        const data = await res.json();
        renderTopologyV2(data);
      } catch (e) { console.error('Topology error:', e); }
    }
    
    let nodePositions = {};

    function renderTopology(data) {
      const nodesLayer = document.getElementById('nodes-layer');
      const connLayer = document.getElementById('connections-layer');
      const harnessLayer = document.getElementById('harness-layer');
      const particleLayer = document.getElementById('particles-layer');
      
      let nodesHtml = '';
      let cx = 400; // Base X
      let cy = 80; // Base Y (Meta Agent)

      // Meta Agent
      nodePositions['metaAgent'] = {x: cx, y: cy};
      nodesHtml += `
        <div class="jarvis-node node-tier-meta" style="left: ${cx}px; top: ${cy}px;">
          <div class="node-header">ORCHESTRATOR</div>
          <div class="node-title">META</div>
        </div>
      `;

      // Domain Agents (Single Horizontal Line)
      const domainAgents = data.agents.filter(a => a.tier === 'domain');
      const spacingX = 170;
      const startX = cx - ((domainAgents.length - 1) * spacingX) / 2;
      
      domainAgents.forEach((a, i) => {
        const nx = startX + i * spacingX;
        const ny = cy + 240; 
        
        nodePositions[a.id] = {x: nx, y: ny};
        
        const activeClass = a.active ? 'active' : '';
        const name = a.id.replace('Agent', '');
        
        nodesHtml += `
          <div class="jarvis-node node-tier-domain ${activeClass}" style="left: ${nx}px; top: ${ny}px;">
            <div class="node-header">DOMAIN</div>
            <div class="node-title">${name}</div>
          </div>
        `;
      });
      
      // Workers (Bottom Center Grid)
      const workers = data.workers || [];
      const workerCols = Math.min(8, Math.max(1, workers.length));
      const wSpacingX = 140;
      const wStartX = cx - ((workerCols - 1) * wSpacingX) / 2;
      
      workers.forEach((w, i) => {
        const row = Math.floor(i / workerCols);
        const col = i % workerCols;
        const nx = wStartX + col * wSpacingX;
        const ny = cy + 460 + row * 70;
        nodePositions[w.id] = {x: nx, y: ny};
        
        nodesHtml += `
          <div class="jarvis-node node-tier-worker" style="left: ${nx}px; top: ${ny}px;">
            <div class="node-header">WORKER</div>
            <div class="node-title" style="font-size:12px;">${w.preset}</div>
          </div>
        `;
      });
      
      // Mastra Workflows (Bottom Left Stack)
      const mwfs = data.workflows.mastra || [];
      mwfs.forEach((wf, i) => {
        const nx = cx - 380;
        const ny = cy + 460 + i * 65;
        nodePositions[wf.id] = {x: nx, y: ny};
        
        nodesHtml += `
          <div class="jarvis-node node-tier-mastra" style="left: ${nx}px; top: ${ny}px;">
            <div style="font-size:16px;">⚡</div>
            <div class="node-title" style="font-size:10px; text-align:left;">${wf.name}</div>
          </div>
        `;
      });
      
      // N8n Workflows (Bottom Right Stack)
      const n8ns = data.workflows.n8n || [];
      n8ns.forEach((wf, i) => {
        const nx = cx + 380;
        const ny = cy + 460 + i * 65;
        nodePositions[wf.id] = {x: nx, y: ny};
        
        const activeClass = wf.active ? '' : 'inactive';
        nodesHtml += `
          <div class="jarvis-node node-tier-n8n ${activeClass}" style="left: ${nx}px; top: ${ny}px;">
            <div style="font-size:16px;">☁️</div>
            <div class="node-title" style="font-size:10px; text-align:left;">${wf.name.slice(0, 15)}</div>
          </div>
        `;
      });
      
      nodesLayer.innerHTML = nodesHtml;
      
      // Draw Connections (SVG)
      let connHtml = '';
      let harnessHtml = '';
      let particleHtml = '';
      
      const HARNESS_STAGES = [
        'depth_classified',
        'precontext_injected',
        'llm_call_started',
        'reflector_triggered',
        'auto_review_started',
        'goal_completion_gate_started'
      ];
      
      (data.connections || []).forEach((c, idx) => {
        const p1 = nodePositions[c.from];
        const p2 = nodePositions[c.to];
        if (!p1 || !p2) return;
        
        const isWorker = c.type === 'worker_spawn';
        const activeClass = c.status === 'active' ? 'conn-active' : '';
        const lineClass = isWorker ? 'conn-worker' : 'conn-delegation';
        
        // Smooth bezier curve
        const dy = Math.abs(p2.y - p1.y);
        const cpOffset = Math.max(dy * 0.4, 50);
        const pathData = `M ${p1.x} ${p1.y} C ${p1.x} ${p1.y + cpOffset}, ${p2.x} ${p2.y - cpOffset}, ${p2.x} ${p2.y}`;
        
        connHtml += `<path id="path-${idx}" d="${pathData}" class="conn-line ${lineClass} ${activeClass}" />`;
        
        if (c.status === 'active') {
          particleHtml += `
            <circle r="4" class="particle">
              <animateMotion dur="1.5s" repeatCount="indefinite">
                <mpath href="#path-${idx}" />
              </animateMotion>
            </circle>
            <circle r="4" class="particle">
              <animateMotion dur="1.5s" begin="0.75s" repeatCount="indefinite">
                <mpath href="#path-${idx}" />
              </animateMotion>
            </circle>
          `;
        }
        
        if (c.hasHarness) {
          const t = 0.5; // center of bezier
          // Approximation of center for simplicity, or we can just use linear mid
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2;
          
          const targetAgent = data.agents.find(a => a.id === c.to);
          const currentPhaseIndex = targetAgent ? HARNESS_STAGES.indexOf(targetAgent.harnessPhase) : -1;
          
          let stagesHtml = '';
          for (let i = 0; i < 6; i++) {
            let stageClass = 'harness-stage';
            if (i < currentPhaseIndex) stageClass += ' completed';
            else if (i === currentPhaseIndex) stageClass += ' active';
            
            stagesHtml += `<rect x="${15 + i * 28}" y="-8" width="22" height="16" class="${stageClass}" />`;
          }
          
          harnessHtml += `
            <g transform="translate(${mx - 100}, ${my})">
              <rect x="0" y="-15" width="200" height="30" class="harness-tube-bg" />
              ${stagesHtml}
              <text x="100" y="25" class="harness-label">HARNESS PIPELINE</text>
            </g>
          `;
        }
      });
      connLayer.innerHTML = connHtml;
      harnessLayer.innerHTML = harnessHtml;
      particleLayer.innerHTML = particleHtml;
      
      const activeAgentsCount = data.agents.filter(a => a.active).length;
      document.getElementById('hud-agents').textContent = `${activeAgentsCount}/${data.agents.length}`;
      document.getElementById('hud-workers').textContent = workers.length;
      document.getElementById('hud-mwfs').textContent = mwfs.length;
      document.getElementById('hud-n8n').textContent = `${n8ns.filter(w=>w.active).length} active`;
      document.getElementById('hud-tasks').textContent = data.stats?.tasks || 0;
      document.getElementById('hud-latency').textContent = (data.stats?.latency || 0) + 'ms';
      
      const activeDels = (data.connections || []).filter(c => c.type === 'delegation' && c.status === 'active');
      const delContainer = document.getElementById('active-delegations');
      if (activeDels.length === 0) {
        delContainer.innerHTML = `<div style="color:rgba(255,255,255,0.3); font-size:13px; font-style:italic; text-align:center; margin-top:20px;">No active delegations</div>`;
      } else {
        delContainer.innerHTML = activeDels.map(d => `
          <div style="background:linear-gradient(90deg, rgba(0,240,255,0.1) 0%, transparent 100%); border-left:3px solid var(--jarvis-meta); padding:12px; border-radius:6px;">
            <div style="font-family:'Rajdhani', sans-serif; font-size:16px; font-weight:600; color:#fff;">${d.to.replace('Agent','').toUpperCase()}</div>
            <div style="font-size:11px; color:rgba(255,255,255,0.6); margin-top:4px;">${d.from.replace('Agent','')} → ${d.to.replace('Agent','')}</div>
            <div style="font-size:11px; color:var(--jarvis-meta); margin-top:6px; font-weight:600; letter-spacing:1px;">● ACTIVE</div>
          </div>
        `).join('');
      }
    }

    // ════════ RADIAL REACTOR ENGINE (V2) — replaces the legacy horizontal layout ════════
    const R1 = 390;            // domain-agent orbit radius
    const R2 = 560;            // workflow orbit radius
    const nodeEls = {};        // id -> DOM element, persisted across refreshes (smooth, no re-mount flicker)
    let agentStatus = {};      // agentId -> latest action label (from live feed)
    let orbitsBuilt = false;
    const HZ_STAGES = ['depth_classified','precontext_injected','llm_call_started','reflector_triggered','auto_review_started','goal_completion_gate_started'];

    const polar = (r, deg) => { const a = deg * Math.PI / 180; return { x: WORLD_CX + r * Math.cos(a), y: WORLD_CY + r * Math.sin(a) }; };
    const jesc = s => String(s == null ? '' : s);
    const shortName = id => jesc(id).replace('Agent', '').replace(/([a-z])([A-Z])/g, '$1 $2');

    function buildOrbits() {
      document.getElementById('orbits-layer').innerHTML =
        `<div class="orbit-ring r-domain" style="left:${WORLD_CX}px;top:${WORLD_CY}px;width:${R1*2}px;height:${R1*2}px;"></div>` +
        `<div class="orbit-ring r-outer" style="left:${WORLD_CX}px;top:${WORLD_CY}px;width:${R2*2}px;height:${R2*2}px;"></div>` +
        `<div class="orbit-ring spin-cw" style="left:${WORLD_CX}px;top:${WORLD_CY}px;width:${(R1+115)*2}px;height:${(R1+115)*2}px;border-color:rgba(0,240,255,0.06);"></div>`;
      const rr = R2 + 70;
      const a0 = -15 * Math.PI / 180;
      const x0 = (rr * Math.cos(a0)).toFixed(1), y0 = (rr * Math.sin(a0)).toFixed(1);
      document.getElementById('radar-layer').innerHTML =
        `<defs><radialGradient id="radarGrad" cx="0" cy="0" r="${rr}" gradientUnits="userSpaceOnUse">
           <stop offset="0%" stop-color="rgba(0,240,255,0.18)"/><stop offset="100%" stop-color="rgba(0,240,255,0)"/>
         </radialGradient></defs>
         <g transform="translate(${WORLD_CX},${WORLD_CY})">
           <circle r="${rr}" fill="none" stroke="rgba(0,240,255,0.05)"/>
           <g class="radar-sweep" style="transform-origin:0 0;">
             <path d="M0 0 L ${rr} 0 A ${rr} ${rr} 0 0 0 ${x0} ${y0} Z" fill="url(#radarGrad)"/>
           </g>
         </g>`;
      orbitsBuilt = true;
    }

    function upsertNode(id, cls, x, y, inner, active, withStatus, createIdx) {
      nodePositions[id] = { x, y };
      let el = nodeEls[id];
      if (!el) {
        el = document.createElement('div');
        el.style.animationDelay = (createIdx * 0.04) + 's';   // staggered materialization
        document.getElementById('nodes-layer').appendChild(el);
        nodeEls[id] = el;
      }
      el.className = 'jarvis-node ' + cls + (active ? ' active' : '');
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.innerHTML = inner +
        (withStatus ? '<div class="node-spinner"></div>' + `<div class="node-status">${jesc(agentStatus[id] || 'standby')}</div>` : '');
    }

    function applyStatuses() {
      for (const id in nodeEls) {
        const s = nodeEls[id].querySelector('.node-status');
        if (s && agentStatus[id]) s.textContent = agentStatus[id];
      }
    }

    function renderTopologyV2(data) {
      if (!orbitsBuilt) buildOrbits();
      let idx = 0;
      const alive = new Set();

      // ── META CORE ──
      alive.add('metaAgent');
      const metaActive = (data.agents.find(a => a.id === 'metaAgent') || {}).active;
      upsertNode('metaAgent', 'node-tier-meta', WORLD_CX, WORLD_CY,
        `<div class="node-header">ORCHESTRATOR</div><div class="node-title">META</div>`, metaActive, true, idx++);

      // ── DOMAIN AGENTS on the inner orbit ──
      const domain = data.agents.filter(a => a.tier === 'domain');
      const n = domain.length || 1;
      domain.forEach((a, i) => {
        const p = polar(R1, -90 + i * (360 / n));
        alive.add(a.id);
        upsertNode(a.id, 'node-tier-domain', p.x, p.y,
          `<div class="node-header">DOMAIN</div><div class="node-title">${shortName(a.id).toUpperCase()}</div>`,
          a.active, true, idx++);
      });

      // ── WORKERS radiating outward from their parent agent ──
      const workers = data.workers || [];
      const parentOf = {};
      (data.connections || []).forEach(c => { if (c.type === 'worker_spawn') parentOf[c.to] = c.from; });
      const wCount = {}, wSeen = {};
      workers.forEach(w => { const pp = parentOf[w.id] || 'metaAgent'; wCount[pp] = (wCount[pp] || 0) + 1; });
      workers.forEach(w => {
        const pid = parentOf[w.id] || 'metaAgent';
        const pp = nodePositions[pid] || { x: WORLD_CX, y: WORLD_CY };
        const base = Math.atan2(pp.y - WORLD_CY, pp.x - WORLD_CX);
        const cnt = wCount[pid] || 1;
        const k = (wSeen[pid] = (wSeen[pid] || 0)); wSeen[pid] = k + 1;
        const ang = base + (k - (cnt - 1) / 2) * 0.4;
        alive.add(w.id);
        upsertNode(w.id, 'node-tier-worker', pp.x + Math.cos(ang) * 112, pp.y + Math.sin(ang) * 112,
          `<div class="node-header">WORKER</div><div class="node-title">${jesc(w.preset)}</div>`, true, false, idx++);
      });

      // ── WORKFLOWS on the outer orbit (Mastra = left arc, n8n = right arc) ──
      const mwfs = (data.workflows && data.workflows.mastra) || [];
      const n8ns = (data.workflows && data.workflows.n8n) || [];
      const placeArc = (list, centerDeg, spreadDeg, fn) => {
        const m = list.length || 1, start = centerDeg - spreadDeg / 2;
        list.forEach((wf, i) => { alive.add(wf.id); fn(wf, polar(R2, m === 1 ? centerDeg : start + i * (spreadDeg / (m - 1)))); });
      };
      placeArc(mwfs, 180, 90, (wf, p) => upsertNode(wf.id, 'node-tier-mastra', p.x, p.y,
        `<div style="font-size:15px;">⚡</div><div class="node-title" style="font-size:10px;text-align:left;">${jesc(wf.name)}</div>`, false, false, idx++));
      placeArc(n8ns, 0, 90, (wf, p) => upsertNode(wf.id, 'node-tier-n8n' + (wf.active ? '' : ' inactive'), p.x, p.y,
        `<div style="font-size:15px;">☁️</div><div class="node-title" style="font-size:10px;text-align:left;">${jesc(wf.name).slice(0,14)}</div>`, wf.active, false, idx++));

      // ── prune nodes that vanished (e.g. despawned workers) ──
      for (const id in nodeEls) {
        if (!alive.has(id)) { nodeEls[id].remove(); delete nodeEls[id]; delete nodePositions[id]; }
      }

      // ════ ENERGY BEAMS / DATA TRANSFER ════
      let beams = '', flows = '', particles = '', harness = '';
      const core = nodePositions['metaAgent'];
      const line = (p1, p2) => `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;

      domain.forEach(a => { const p = nodePositions[a.id]; if (p) beams += `<path d="${line(core, p)}" class="conn-line conn-delegation"/>`; });
      mwfs.forEach(wf => { const p = nodePositions[wf.id]; if (p) beams += `<path d="${line(core, p)}" class="conn-line conn-workflow"/>`; });
      n8ns.forEach(wf => { const p = nodePositions[wf.id]; if (p) beams += `<path d="${line(core, p)}" class="conn-line conn-workflow n8n"/>`; });

      (data.connections || []).forEach((c, i) => {
        const p1 = nodePositions[c.from], p2 = nodePositions[c.to];
        if (!p1 || !p2) return;
        const isWorker = c.type === 'worker_spawn';
        const d = line(p1, p2), pid = 'beam-' + i;
        beams += `<path id="${pid}" d="${d}" class="conn-line ${isWorker ? 'conn-worker' : 'conn-delegation'}${c.status === 'active' ? ' conn-active' : ''}"/>`;
        if (c.status === 'active') {
          const cls = isWorker ? 'worker' : 'delegation';
          flows += `<path d="${d}" class="conn-flow ${cls}"/>`;
          // stream of 3 glowing data-packet comets travelling from source → target
          for (let k = 0; k < 3; k++) {
            particles += `<g class="data-packet ${cls}">
              <circle class="halo" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
              <circle r="${k === 0 ? 5 : 3.2}"/>
              <animateMotion dur="1.25s" begin="${(k * 0.42).toFixed(2)}s" repeatCount="indefinite"><mpath href="#${pid}"/></animateMotion>
            </g>`;
          }
        }
        if (c.hasHarness) {
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
          const ta = data.agents.find(a => a.id === c.to);
          const cur = ta ? HZ_STAGES.indexOf(ta.harnessPhase) : -1;
          let st = '';
          for (let s = 0; s < 6; s++) { let cl = 'harness-stage'; if (s < cur) cl += ' completed'; else if (s === cur) cl += ' active'; st += `<rect x="${15 + s * 28}" y="-8" width="22" height="16" class="${cl}"/>`; }
          harness += `<g transform="translate(${mx - 100},${my})"><rect x="0" y="-15" width="200" height="30" class="harness-tube-bg"/>${st}<text x="100" y="25" class="harness-label">HARNESS PIPELINE</text></g>`;
        }
      });

      document.getElementById('connections-layer').innerHTML = beams;
      document.getElementById('flow-layer').innerHTML = flows;
      document.getElementById('particles-layer').innerHTML = particles;
      document.getElementById('harness-layer').innerHTML = harness;

      // ════ HUD + DELEGATIONS ════
      const activeCount = data.agents.filter(a => a.active).length;
      document.getElementById('hud-agents').textContent = `${activeCount}/${data.agents.length}`;
      document.getElementById('hud-workers').textContent = workers.length;
      document.getElementById('hud-mwfs').textContent = mwfs.length;
      document.getElementById('hud-n8n').textContent = `${n8ns.filter(w => w.active).length} active`;
      document.getElementById('hud-tasks').textContent = (data.stats && data.stats.tasks) || 0;
      document.getElementById('hud-latency').textContent = ((data.stats && data.stats.latency) || 0) + 'ms';

      const dels = (data.connections || []).filter(c => c.type === 'delegation' && c.status === 'active');
      document.getElementById('active-delegations').innerHTML = dels.length === 0
        ? `<div style="color:rgba(255,255,255,0.3);font-size:13px;font-style:italic;text-align:center;margin-top:20px;">No active delegations</div>`
        : dels.map(d => `
          <div style="background:linear-gradient(90deg,rgba(0,240,255,0.1) 0%,transparent 100%);border-left:3px solid var(--jarvis-meta);padding:12px;border-radius:6px;">
            <div style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:600;color:#fff;">${shortName(d.to).toUpperCase()}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-top:4px;">${shortName(d.from)} → ${shortName(d.to)}</div>
            <div style="font-size:11px;color:var(--jarvis-meta);margin-top:6px;font-weight:600;letter-spacing:1px;">● TRANSMITTING</div>
          </div>`).join('');

      applyStatuses();
    }

    setInterval(fetchTopology, 3000);
    fetchTopology();

    async function updateJarvisFeed() {
      try {
        const since = new Date(Date.now() - 300 * 1000).toISOString();
        const res = await fetch(`${API}/dashboard/agent-activity?since=${since}&limit=50`);
        if (!res.ok) return;
        const data = await res.json();
        const feed = document.getElementById('jarvis-event-feed');
        if (data.events.length === 0) return;

        // events are newest-first → capture each agent's most recent action for the live node ticker
        const seenAgents = new Set();
        for (const ev of data.events) {
          if (ev.agentId && !seenAgents.has(ev.agentId)) {
            seenAgents.add(ev.agentId);
            agentStatus[ev.agentId] = jesc(ev.toolId || ev.type).slice(0, 22) || 'working';
          }
        }
        if (typeof applyStatuses === 'function') applyStatuses();

        feed.innerHTML = data.events.map(ev => {
          const d = new Date(ev.timestamp);
          const time = d.toLocaleTimeString('en-US', {hour12:false}) + '.' + String(d.getMilliseconds()).padStart(3,'0');
          let typeClass = 'type-tool';
          if (ev.type === 'delegation') typeClass = 'type-delegation';
          if (ev.type.includes('worker')) typeClass = 'type-worker';
          if (ev.status === 'error') typeClass = 'type-error';
          
          let label = ev.toolId || ev.type;
          
          return `
            <div class="event-item ${typeClass}">
              <span class="event-time">${time}</span>
              <span class="event-agent">${(ev.agentId||'UNKNOWN').replace('Agent','').toUpperCase()}</span>
              <span class="event-desc">${label}</span>
            </div>
          `;
        }).join('');
      } catch(e) {}
    }
    setInterval(updateJarvisFeed, 3000);
    updateJarvisFeed();
