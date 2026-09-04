/**
 * STATE - AGENT CHAT PANEL (SPLOT OS)
 * Kompletna lista 18 agentów Splot OS, modele, ikony SVG, dynamiczna synchronizacja
 * wątków i wiadomości z bazą danych MongoDB Mastra oraz pamięć podręczna szkiców.
 */

export const AGENT_ICONS = {
  meta: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11l-5.5 4M12 11l5.5 4"/>',
  res:  '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  cod:  '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  des:  '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  chef: '<path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6z"/><line x1="6" x2="18" y1="17" y2="17"/>',
  wri:  '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" x2="2" y1="8" y2="22"/><line x1="17.5" x2="9" y1="15" y2="15"/>',
  ana:  '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  crm:  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  rev:  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  auto: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'
};

export function getAgentSvg(iconKey, strokeWidth = 1.8) {
  const path = AGENT_ICONS[iconKey] || AGENT_ICONS.meta;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:100%;height:100%;display:block;">${path}</svg>`;
}

// KOMPLETNA LISTA WSZYSTKICH 18 AGENTÓW SYSTEMU SPLOT OS / MASTRA
export const AGENTS = [
  { id: 'metaAgent', full: 'metaAgent', iconKey: 'meta', role: 'Orkiestrator', accent: '#FF4D00', model: 'gemini-3.6-flash', desc: 'Główny dyspozytor intencji, planowanie i delegacja zadań', suggestions: ['Przygotuj raport o dostawcach', 'Zaplanuj workflow dla zamówień', 'Przeanalizuj logi orkiestracji'], unread: 0 },
  { id: 'researcherAgent', full: 'researcherAgent', iconKey: 'res', role: 'Research Głęboki', accent: '#5B8DEF', model: 'gemini-3.6-flash', desc: 'Autonomiczny wywiad sieciowy PSEV, menu, rejestry, analizy', suggestions: ['Zbadaj ofertę producentów nabiału', 'Pobierz dane z KRS i CEIDG', 'Wyciągnij menu z URL restauracji'], unread: 0 },
  { id: 'codingAgent', full: 'codingAgent', iconKey: 'cod', role: 'Programowanie', accent: '#2EE6A8', model: 'gemini-3.6-flash', desc: 'Praca na repozytorium, LSP, diffy, testy i terminal', suggestions: ['Sprawdź diffy w repozytorium', 'Uruchom npx tsc --noEmit', 'Zaprojektuj patch dla routera'], unread: 0 },
  { id: 'automationArchitect', full: 'automationArchitect', iconKey: 'auto', role: 'Automatyzacja', accent: '#EAB308', model: 'gemini-3.6-flash', desc: 'n8n workflow design, guardraile, Golden Path i naprawa webhooków', suggestions: ['Zbuduj webhook dla Telegrama', 'Zweryfikuj przepływ n8n', 'Wdróż Golden Path z MCP'], unread: 0 },
  { id: 'analyticsAgent', full: 'analyticsAgent', iconKey: 'ana', role: 'Analityka & KPI', accent: '#A855F7', model: 'gemini-3.6-flash', desc: 'Raporty KPI, marżowość, anomalie i telemetria systemu', suggestions: ['Oblicz marżę per kategoria', 'Wykryj anomalie w cennikach', 'Wygeneruj raport sprzedaży'], unread: 0 },
  { id: 'crmAgent', full: 'crmAgent', iconKey: 'crm', role: 'CRM Lookup', accent: '#FACC15', model: 'gemini-3.6-flash', desc: 'Błyskawiczne odczytywanie leadów i kontaktów z lokalnej bazy', suggestions: ['Wyszukaj firmę po NIP', 'Pobierz ostatnie kontakty', 'Sprawdź status leada w Subiekcie'], unread: 0 },
  { id: 'salesAgent', full: 'salesAgent', iconKey: 'crm', role: 'Sprzedaż & Pipeline', accent: '#10B981', model: 'gemini-3.6-flash', desc: 'Pipeline CRM, oferty handlowe, onboarding i spotkania', suggestions: ['Przygotuj draft oferty B2B', 'Zaplanuj follow-up w kalendarzu', 'Zaktualizuj status w pipeline'], unread: 0 },
  { id: 'marketingAgent', full: 'marketingAgent', iconKey: 'des', role: 'Marketing & Cold Mail', accent: '#F97316', model: 'gemini-3.6-flash', desc: 'Cold email, RSS digest, szkice Gmail, wpisy CRM marketingu', suggestions: ['Przygotuj kampanię cold mail', 'Stwórz digest z RSS', 'Sformatuj newsletter branżowy'], unread: 0 },
  { id: 'knowledgeAgent', full: 'knowledgeAgent', iconKey: 'res', role: 'NotebookLM & Wiedza', accent: '#06B6D4', model: 'gemini-3.6-flash', desc: 'Google NotebookLM, synteza źródeł i artefakty wiedzy Studio', suggestions: ['Przeszukaj notatniki wiedzy', 'Zsyntetyzuj źródła PDF', 'Stwórz dokument FAQ ze źródeł'], unread: 0 },
  { id: 'chefAgent', full: 'chefAgent', iconKey: 'chef', role: 'Kulinaria & Menu', accent: '#F59E0B', model: 'gemini-3.6-flash', desc: 'Inżynieria menu, receptury, kalkulacja BOM i Księga Menu', suggestions: ['Skomponuj menu degustacyjne', 'Przelicz food cost dla pozycji', 'Wygeneruj Księgę Menu'], unread: 0 },
  { id: 'contentAgent', full: 'contentAgent', iconKey: 'wri', role: 'Social Media', accent: '#10B981', model: 'gemini-3.6-flash', desc: 'Wieloplatformowy kontent (LinkedIn, Instagram, TikTok, rolki)', suggestions: ['Napisz post na LinkedIn', 'Przygotuj scenariusz rolki IG', 'Zaplanuj tygodniowy harmonogram'], unread: 0 },
  { id: 'huntAgent', full: 'huntAgent', iconKey: 'res', role: 'Lead Hunting', accent: '#EC4899', model: 'gemini-3.6-flash', desc: 'Odkrywanie producentów B2B, scoring, weryfikacja i outreach', suggestions: ['Znajdź 10 hurtowni nabiału', 'Zweryfikuj adresy email leadów', 'Przeprowadź scoring dostawców'], unread: 0 },
  { id: 'designAgent', full: 'designAgent', iconKey: 'des', role: 'Design & UI/UX', accent: '#06B6D4', model: 'gemini-3.6-flash', desc: 'Makiety HTML, infografiki, slajdy i eksporty wizualne', suggestions: ['Zaprojektuj dashboard w HTML', 'Stwórz schemat architektury', 'Przygotuj slajd prezentacji'], unread: 0 },
  { id: 'writerAgent', full: 'writerAgent', iconKey: 'wri', role: 'Pisarz & Książki', accent: '#F97316', model: 'gemini-3.6-flash', desc: 'Długie formy tekstowe, rozdziały, manuskrypty i eseje', suggestions: ['Napisz wstęp do rozdziału', 'Opracuj narrację raportu', 'Zredaguj manuskrypt'], unread: 0 },
  { id: 'deliberationAgent', full: 'deliberationAgent', iconKey: 'rev', role: 'Debata & Design Council', accent: '#8B5CF6', model: 'deepseek-v4-flash', desc: 'Ustrukturyzowana debata, analiza kompromisów architektonicznych', suggestions: ['Rozważ warianty bazy danych', 'Podważ architekturę mikroserwisów', 'Oceń kompromisy wydajności'], unread: 0 },
  { id: 'filmmakerAgent', full: 'filmmakerAgent', iconKey: 'auto', role: 'Wideo & Seedance', accent: '#EF4444', model: 'or-claude-sonnet-5', desc: 'Generowanie klipów wideo, prompt-spec, ujęcia i spójność kadrów', suggestions: ['Stwórz storyboard dla klipu', 'Sformatuj prompt dla T2V Seedance', 'Skontroluj spójność ujęć'], unread: 0 },
  { id: 'musicianAgent', full: 'musicianAgent', iconKey: 'ana', role: 'Muzyka & Audio', accent: '#8B5CF6', model: 'or-claude-sonnet-5', desc: 'Generowanie utworów muzycznych, teksty, ścieżki i mastering', suggestions: ['Napisz tekst utworu', 'Wygeneruj prompt instrumentalny', 'Przygotuj master ścieżki'], unread: 0 },
  { id: 'capabilitySmith', full: 'capabilitySmith', iconKey: 'rev', role: 'Capability Smith', accent: '#94A3B8', model: 'gemini-3.6-flash', desc: 'Protokół luki możliwości: dołączanie serwerów MCP i budowa narzędzi', suggestions: ['Wykryj brakujące narzędzie', 'Dołącz serwer MCP z rejestru', 'Wygeneruj specyfikację nowego toolu'], unread: 0 }
];

export const AppState = {
  activeAgent: AGENTS[0],
  sideAgent: AGENTS[1],
  activeThreadId: null,
  sideThreadId: null,
  activeTab: 'view-chat',
  splitActive: false,
  activeDrawer: null,
  turns: new Map(),

  threads: [],
  threadMessagesCache: new Map(),

  mainDrafts: new Map(),
  sideDrafts: new Map(),
  
  getAgent(nameOrId) {
    if (!nameOrId) return AGENTS[0];
    const clean = String(nameOrId).trim();
    return AGENTS.find(a => 
      a.id === clean || 
      a.full === clean ||
      a.id.toLowerCase() === clean.toLowerCase() ||
      a.id.replace(/Agent$/, '').toLowerCase() === clean.toLowerCase()
    ) || AGENTS[0];
  },

  getThread(threadId) {
    if (!threadId) return null;
    return this.threads.find(t => t.id === threadId) || null;
  },

  getThreadsForAgent(agentId) {
    if (!agentId) return this.threads;
    const target = this.getAgent(agentId);
    return this.threads.filter(t => {
      const threadAgent = this.getAgent(t.agent);
      return threadAgent.id === target.id;
    });
  },

  async loadThreadsFromBackend(agentId = null) {
    try {
      const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}&limit=100` : '?limit=100';
      const res = await fetch(`/splot/api/threads${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.threads = json.data || [];
      return this.threads;
    } catch (err) {
      console.warn('[AppState] Failed to fetch threads from backend:', err);
      return this.threads;
    }
  },

  async loadThreadMessagesFromBackend(threadId) {
    if (!threadId) return [];
    try {
      const res = await fetch(`/splot/api/threads/${encodeURIComponent(threadId)}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const messages = json.data || [];
      this.threadMessagesCache.set(threadId, messages);
      return messages;
    } catch (err) {
      console.warn(`[AppState] Failed to fetch messages for ${threadId}:`, err);
      return this.threadMessagesCache.get(threadId) || [];
    }
  },

  async deleteThread(threadId) {
    try {
      const res = await fetch(`/splot/api/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.threads = this.threads.filter(t => t.id !== threadId);
      this.threadMessagesCache.delete(threadId);
      if (this.activeThreadId === threadId) this.activeThreadId = null;
      if (this.sideThreadId === threadId) this.sideThreadId = null;
      return true;
    } catch (err) {
      console.error('[AppState] Delete thread failed:', err);
      return false;
    }
  },

  async batchDeleteThreads(threadIds) {
    try {
      const res = await fetch('/splot/api/threads/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const idSet = new Set(threadIds);
      this.threads = this.threads.filter(t => !idSet.has(t.id));
      threadIds.forEach(id => this.threadMessagesCache.delete(id));
      if (idSet.has(this.activeThreadId)) this.activeThreadId = null;
      if (idSet.has(this.sideThreadId)) this.sideThreadId = null;
      return true;
    } catch (err) {
      console.error('[AppState] Batch delete threads failed:', err);
      return false;
    }
  },

  createLocalThreadForAgent(agentId, initialPrompt) {
    const agent = this.getAgent(agentId);
    const shortTitle = initialPrompt.length > 38 ? initialPrompt.substring(0, 38) + '...' : initialPrompt;
    const newThread = {
      id: 't_' + Date.now(),
      title: shortTitle,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      unread: 0,
      agent: agent.id,
      messages: []
    };
    this.threads.unshift(newThread);
    return newThread;
  }
};
