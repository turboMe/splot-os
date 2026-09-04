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
        const API_BASE = options.apiBase || '/dashboard';

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
    apiBase: '/dashboard',
    rootId: 'tab-analytics',
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
