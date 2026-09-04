# Plan Naprawy Workflowów Marketingowych, Zgodności RODO oraz Architektury Skilli i Głosu Patryka

**Data sporządzenia:** 2026-08-29  
**Autorzy:** Patryk & Principal Agentic Systems Engineer  
**Status:** Zaakceptowane założenia do wdrożenia (Phase Planning)

---

## 1. Ustalenia i Diagnoza Błędów Technicznych

### 1.1. Błąd HTTP 400 (`runId required`) w `cron-runner.ts`
* **Problem:** `cron-runner.ts` wywoływał bezpośrednio `POST /api/workflows/:workflowId/start` bez uprzedniego utworzenia `runId`.
* **Rozwiązanie:** Wdrożenie dwuetapowego wywołania:
  1. `POST /api/workflows/:workflowId/create-run` -> pobranie `runId`
  2. `POST /api/workflows/:workflowId/start?runId={runId}` z parametrem `{ inputData: { ... } }`
* **Niespójność ID:** Ujednolicenie identyfikatora `repo-maintenance` (wewnętrzne `repo-maintenance-workflow` vs rejestr Mastra).

### 1.2. Naprawa Dopasowywania Leada w `inbox-monitor.ts`
* **Problem:** W kroku `apply-actions` kod używał `{ email: { $regex: new RegExp(item.from.split('@')[1] ?? item.from, 'i') } }`, co dopasowywało pierwszego lepszego leada z tą samą domeną (np. `@gmail.com` lub `@wp.pl`).
* **Rozwiązanie:** Ścisłe dopasowanie po pełnym, znormalizowanym adresie email:
  ```typescript
  const cleanFrom = item.from.toLowerCase().trim();
  const lead = await db.collection('leads').findOne({ email: cleanFrom });
  ```

### 1.3. Obsługa RODO / Opt-Out w Bazie Danych CRM
* **Problem:** Odmowy były wrzucane do jednego worka `status: 'odrzucony'` bez trwałej blokady ponownego kontaktu.
* **Rozwiązanie:**
  * Wprowadzenie dedykowanej kategorii klasyfikacji: `hard_opt_out`.
  * Aktualizacja rekordu leda w MongoDB:
    * `status: 'odrzucony'`
    * `metadata.doNotContact: true`
    * `metadata.optOutDate: new Date()`
  * Zabezpieczenie `automated-followup.ts` oraz narzędzi cold outreach przed jakimkolwiek kontaktem z leadami oznaczonymi `metadata.doNotContact: true`.

---

## 2. Aspekty Prawne: Cold Emailing w Polsce (RODO, UŚUDE, Prawo Telekomunikacyjne)

W polskim porządku prawnym (art. 10 Ustawy o świadczeniu usług drogą elektroniczną, art. 172 Prawa Telekomunikacyjnego / Prawo Komunikacji Elektronicznej oraz RODO):
1. **Zakaz przesyłania niezamówionej informacji handlowej (oferty sprzedaży) w pierwszym mailu:**
   * Pierwsza wiadomość **NIE MOŻE być gotową ofertą handlową, cennikiem ani bezpośrednią sprzedażą**.
   * Pierwsza wiadomość musi być **zapytaniem o zgodę na przedstawienie oferty / nawiązaniem relacji biznesowej / zapytaniem o proces decyzyjny**.
2. **Model Dwuetapowy (Permission-Based Outreach):**
   * *Krok 1:* Krótka, personalizowana wiadomość kontekstowa: przedstawienie się, zidentyfikowanie potencjalnego punktu styku (np. profil działalności) i **pytanie o zgodę / kontakt do osoby decyzyjnej**.
   * *Krok 2 (tylko po odpowiedzi pozytywnej):* Przedstawienie szczegółowej propozycji, cennika, wersji demo lub linku do platformy.
3. **Prawo do sprzeciwu (Opt-Out):**
   * Każda wiadomość musi zawierać jasną, naturalną informację o możliwości odmowy (np. *"Jeśli ten temat nie jest dla Państwa aktualny, wystarczy krótka informacja zwrotna – uszanuję to i nie ponowię kontaktu"*).

---

## 3. Architektura Głosu i Persony Patryka: Universal Core + Domain Adapters

Zamiast sztucznego rozdzielania na zupełnie obce persony, stosujemy model **Universal Core Voice** (niezmienny trzon autentyczności) z **5 wyspecjalizowanymi adapterami domenowymi (Skille)**.

### 3.1. Universal Core (Wspólny Mianownik Głosu Patryka)
* **Autentyczność praktyka:** Praktyk i twórca, a nie teoretyk. Zna ból operacyjny (gastronomia, development, automatyzacje).
* **Konkret i szacunek dla czasu:** Maksymalnie 3-5 zdań, brak "korpo-nowomowy", brak fałszywych pochlebstw, zero emoji w relacjach B2B.
* **Format:** Krótki hook -> kontekst wartości -> jednoznaczne, niewymuszone pytanie (CTA).
* **Prawda faktograficzna:** Nigdy nie obiecujemy funkcji, których nie ma, ani nie podajemy niezweryfikowanych liczb.

---

## 4. Matryca 5 Filarów Działalności i Dedykowanych Skilli

Dla każdego z 5 kierunków biznesowych tworzymy dedykowany skill w `src/mastra/_skills/`:

### 🔹 Filar 1: GastroBridge (B2B Marketplace HoReCa)
* **Skill:** `_skills/marketing/outreach-gastrobridge.md`
* **Dla Dostawców / Rolników / RHD:**
  * Kąt: Sprzedaż bezpośrednia do restauracji z wyższą marżą niż w skupie, transparentne rozliczenia.
  * Pierwszy mail: Zapytanie o aktualne moce przerobowe i chęć sprzedaży bezpośredniej do gastronomii.
* **Dla Restauratorów / Szefów Kuchni:**
  * Kąt: Głos byłego Head Chefa (#1 na TripAdvisor). Oszczędność czasu na zamawianiu, porównywarka cen, jedno kliknięcie zamiast 10 telefonów w nocy.

### 🔹 Filar 2: Kariera & Rekrutacja (Job Applications)
* **Skill:** `_skills/marketing/career-application-it-gastro.md`
* **Kierunek IT / AI / Agentic Engineering:**
  * Pozycjonowanie: Full-Stack & Agentic AI Architect (Mastra, TypeScript, Node, n8n, Ollama/Local LLM, integracje B2B).
  * Ton: Precyzyjny inżynier systemowy z potężną samodzielnością i biznesowym zrozumieniem.
* **Kierunek Executive / Head Chef:**
  * Pozycjonowanie: Doświadczenie międzynarodowe (#1 TripAdvisor Islandia), rygor food-costu, zarządzanie personelem, optymalizacja menu.

### 🔹 Filar 3: Usługi Automatyzacji AI & Agenci (B2B Automation Agency)
* **Skill:** `_skills/marketing/outreach-automation-agency.md`
* **Oferta:**
  * Automatyzacje procesów biznesowych (n8n, integracje systemowe, bazy danych, API).
  * Systemy agentowe LLM (lokalne modele, audyty operacyjne, automatyzacja powtarzalnej pracy).
* **Pierwszy mail:** Zbadanie wąskich gardeł w firmie klienta (np. ręczne przepisywanie danych, opóźnienia w ofertowaniu) i zapytanie o możliwość bezpłatnej analizy procesu.

### 🔹 Filar 4: Tworzenie i Odświeżanie Stron WWW (Web Dev & Modern Look)
* **Skill:** `_skills/marketing/outreach-web-modernization.md`
* **Oferta:**
  * Budowa ultra-nowoczesnych, szybkich stron od zera (Next.js, responsywność, SEO).
  * Modernizacja przestarzałych witryn lokalnych firm (audyt obecnej strony, lifting wizualny, przyspieszenie).
* **Pierwszy mail:** Wskazanie 1-2 konkretnych, zauważonych problemów na obecnej stronie (np. brak responsywności na mobile) i propozycja przesłania darmowej wizualizacji/audytu.

### 🔹 Filar 5: Konsulting Gastronomiczny & AI dla HoReCa
* **Skill:** `_skills/marketing/outreach-gastro-consulting.md`
* **Oferta:**
  * Tworzenie i inżynieria menu (Menu Engineering, standaryzacja receptur, obniżka food costu).
  * Automatyzacja obsługi opinii (Google Reviews, TripAdvisor z zachowaniem ludzkiego, ciepłego tonu).
  * Strategia i automatyzacja contentu w social media dla restauracji.
* **Pierwszy mail:** Relacja szef-dla-szefa / menedżera, propozycja wymiany doświadczeń lub krótkiej konsultacji w temacie optymalizacji kosztów kuchni.

---

## 5. Kolejność Realizacji (Plan Commit-Sized)

1. **Krok 1 (Silnik & Bezpieczeństwo):**
   * Naprawa `cron-runner.ts` (dwuetapowy `create-run` -> `start`).
   * Naprawa regexu w `inbox-monitor.ts` i wdrożenie `metadata.doNotContact`.
2. **Krok 2 (Skille Triagingu & Prawne):**
   * Utworzenie `_skills/marketing/inbound-email-triage.md` (6-stopniowa klasyfikacja, ochrona prompt-injection).
   * Utworzenie `_skills/marketing/optout-and-crm-lifecycle.md` (RODO, opt-out, uśpienia czasowe).
3. **Krok 3 (Skille Perswazji & 5 Filarów):**
   * Utworzenie 5 wyspecjalizowanych skilli ofertowych i aplikacyjnych.
4. **Krok 4 (Kalendarz i Handoff):**
   * Utworzenie `_skills/marketing/meeting-calendar-handoff.md` i powiązanie z `meetingSchedulerWorkflow`.
5. **Krok 5 (Testy i Walidacja):**
   * Uruchomienie pełnego suite testów `npm run typecheck` oraz testów integracyjnych workflowów.
