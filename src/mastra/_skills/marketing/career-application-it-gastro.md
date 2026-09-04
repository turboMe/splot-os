---
name: career-application-it-gastro
category: marketing
description: >-
  Generowanie personalizowanych aplikacji o pracę, listów motywacyjnych i gotowych draftów
  emaili w oparciu o prawdziwe CV i dokumenty z dysku kandydata:
  (A) IT / AI / Agentic Engineering — Full-Stack & Agentic AI Architect (portfolio: flowmint-ai.web.app, live OS demo, GastroBridge SaaS);
  (B) Executive / Head Chef & Restaurant Manager — #1 TripAdvisor Islandia, referencje, food-cost, zarządzanie.
  Automatyczny zapis do CRM (career_it_pl, career_it_is, career_chef_pl, career_chef_is),
  przygotowanie draftu Gmail (konto personal) gotowego do wysłania z załącznikami PDF z dysku (PL/EN),
  obsługa wsadowa (batch loop) po skanie rynkowym, powiadomienia Telegram z załącznikiem pliku ofert portalowych.
keywords: [cv, cover-letter, job-application, it, ai, agentic, chef, gastro, career, recruitment, flowmint, gastrobridge, tripadvisor, batch, telegram]
allowedTools: [gmail_manage_draft, crm_search_leads, crm_create_lead, crm_update_lead, crm_add_interaction, crm_record_email_draft, search_web, find_company_links, artifact_put, knowledge_query, telegram_send_message, telegram_send_file]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 4200
outputFormat: text
tags: [marketing, career, job-application, cover-letter, it, gastro, recruitment, telegram]
version: 4
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Career Application — IT/AI & Executive Chef / Restaurant Manager

## 1. Kiedy aktywować ten skill

Aktywuj, gdy zadanie dotyczy:
- **Przetworzenia wyników skanowania rynku pracy (QUALIFIED_JOBS_PAYLOAD)** przekazanych z `researcherAgent` (Krok 2 w łańcuchu zadań).
- Przygotowania **gotowych do wysłania draftów emaili aplikacyjnych** dla ofert posiadających publiczny email rekrutacji.
- Wprowadzenia leadów rekrutacyjnych do CRM ze statusem `draft_gotowy` i powiązanym `draftId`.
- Wysłania porannego raportu podsumowującego na Telegram wraz z załącznikiem pliku ofert portalowych (`telegram_send_file`).

NIE aktywuj dla:
- Samodzielnego scrapowania portali pracy (domena skilli `poland-ai-agentic-job-hunter` / `iceland-job-hunter`).

---

## 2. Prawdziwe dane kandydata i pliki na dysku

Główny plik faktograficzny (Single Source of Truth):
`/projekty/splot-projects/Alfred-job/CANDIDATE_PROFILE_GROUNDING.md`

Agent ma bezwzględny obowiązek korzystać z **prawdziwych danych i gotowych dokumentów kandydata**:

### 👤 Prawdziwe dane osobowe, tożsamość i sztywne zakazy halucynacji (Strict Identity Grounding):
- **Imię i nazwisko:** Alex Doe
- **Telefon:** `+1 (555) 019-2834` (**ZAKAZ** wymyślania fikcyjnych numerów polskich np. `+48...` ani placeholderów `+48 XXX...`!)
- **Email kontaktowy i wysyłkowy:** `candidate@example.com` (`account: 'personal'`)
- **GitHub:** `https://github.com/turboMe` (**ZAKAZ** generowania zmyślonych slugów typu `github.com/your-username`!)
- **Portfolio & AI Automation:** `https://flowmint-ai.web.app/`
- **SaaS Case Study:** `https://gastrobridge.com` (lub `gastrobridge.pl`)
- **LinkedIn:** **BEZWZGLĘDNY ZAKAZ** dodawania zmyślonych linków LinkedIn (`linkedin.com/in/...`). Nie umieszczaj LinkedIn w podpisie!

### 🧠 Ścisła baza faktograficzna kandydata (Candidate Ground Truth Matrix):
Każdy generowany draft wiadomości **musi w 100% zgadzać się z plikiem `CANDIDATE_PROFILE_GROUNDING.md`**:

#### 1. 🗣️ Poziom języków (BEZWZGLĘDNY ZAKAZ ZWYKŁYCH HALUCYNACJI):
- **Polski:** Ojczysty (Native)
- **Angielski:** C1 (Pełna biegłość zawodowa / Professional Full Working Proficiency)
- **Islandzki:** A1 (Podstawowy / Basic) — **BEZWZGLĘDNY ZAKAZ** pisania, że kandydat jest "fluent" lub "bilingual" w języku islandzkim! Nigdy nie deklaruj biegłości w islandzkim.

#### 2. 🍳 Profil Gastronomiczny (Head Chef / Restaurant Manager):
- **Doświadczenie:** 15 lat w gastronomii (Polska, Anglia, Holandia, Islandia).
- **Rola w Islandii:** 6 lat jako Szef Kuchni (Head Chef) w restauracji *Reykjavik Kitchen* w Reykjaviku.
- **Osiągnięcie:** W tym okresie restauracja osiągnęła status #1 w Islandii na TripAdvisor.
- **Kompetencje:** Pełna odpowiedzialność za kuchnię, budowa zespołu od zera, organizacja serwisu, food-cost, kalkulacja i inżynieria menu, marże, P&L, zakupy i negocjacje z dostawcami, łączenie gastronomii z automatyzacją i systemem GastroBridge.
- **ZAKAZY FAKTOGRAMU GASTRO:**
  - 🚫 **ZAKAZ** przypisywania tytułu *Matreiðslumeistari* (Certified Master Chef) ani dyplomów mistrzowskich.
  - 🚫 **ZAKAZ** zmyślania systemów zmianowych (np. "expert in 2-2-3 shifts") czy operacji hotelowo-bankietowych, jeśli nie wynikają wprost z CV.

#### 3. 💻 Profil IT / AI / Software (AI Solutions Engineer):
- **Główne filary:**
  - Architekt i twórca środowiska wieloagentowego w Mastra (meta-orkiestrator, DAG workflows, routing Ollama/OpenRouter/Cloud, RAG z embeddingami bge-m3, bramki bezpieczeństwa i code review).
  - Twórca i założyciel *GastroBridge* (produkcyjny B2B SaaS dla HoReCa: TypeScript, Next.js 15, React 19, Node.js, MongoDB, Google Cloud Run, SSE sync, Stripe).
  - Twórca platformy *FlowMint AI* (`https://flowmint-ai.web.app/`).
- **Mocne strony:** Integracje ERP/SaaS, REST API, SSE, webhooki, multi-agent orchestration, prompt & context engineering, RAG, multi-tenant RBAC, i18n, bezpieczeństwo agentów.
- **Czego NIE robi:** Akademicki ML research od zera, trening modeli bazowych od podstaw, niskopoziomowe programowanie GPU C++.

---

### 📁 Katalogi źródłowe i sztywne reguły doboru załączników (Direct Attachment Rule):

**BEZWZGLĘDNA ZASADA:** NIE używaj narzędzi przeszukiwania workspace (`search_content`, `file_stat`, `read_file`) do szukania plików CV przed wywołaniem narzędzia mailowego. Podaj dokładne ścieżki absolutne bezpośrednio do argumentu `attachments` w `gmail_manage_draft`. Usługa Gmail sama bezpiecznie wczyta i zakoduje plik z dysku.

#### 1. Aplikacje IT / AI — Polska (`market: 'Poland'` lub segment `career_it_pl`):
Dla KAŻDEJ aplikacji w Polsce **zawsze dołączaj kompletny polski zestaw PDF**:
```json
"attachments": [
  {
    "filename": "Candidate_AI_Solutions_Engineer_CV.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_AI_Solutions_Engineer_CV.pdf"
  },
  {
    "filename": "Candidate_Cover_Letter_PL.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_Cover_Letter_PL.pdf"
  }
]
```
*(Nawet jeśli samo ogłoszenie w Polsce zostało sformułowane w języku angielskim, dla rynku polskiego priorytetem jest załączenie polskiego zestawu PDF).*

#### 2. Aplikacje IT / AI — Islandia / International (`market: 'Iceland'` lub segment `career_it_is`):
Dla aplikacji islandzkich/międzynarodowych **zawsze dołączaj angielski zestaw PDF**:
```json
"attachments": [
  {
    "filename": "Candidate_AI_Solutions_Engineer_CV_EN.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_AI_Solutions_Engineer_CV_EN.pdf"
  },
  {
    "filename": "Candidate_Cover_Letter_EN.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_Cover_Letter_EN.pdf"
  }
]
```

#### 3. Aplikacje Gastronomia / Head Chef / Manager (`role: 'chef'` lub segment `career_chef_*`):
Dla aplikacji gastronomicznych **zawsze dołączaj angielski zestaw Hospitality PDF**:
```json
"attachments": [
  {
    "filename": "Candidate_CV_Hospitality_EN.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_CV_Hospitality_EN.pdf"
  },
  {
    "filename": "Candidate_Cover_Letter_Hospitality_EN.pdf",
    "path": "/projekty/mastra-agentic-environment/agentic-agents/src/mastra/knowledge/personal/documents/Candidate_Cover_Letter_Hospitality_EN.pdf"
  }
]
```
*(Referencje #1 TripAdvisor: dołączaj tylko wtedy, gdy plik referencji fizycznie istnieje na dysku).*

---

## 3. Standaryzacja Tematów i Tagowanie

Dla każdego tworzonego draftu w Gmailu zastosuj ustandaryzowany temat z tagiem:
- **Polska IT/AI:** `[Kariera IT - PL] Aplikacja: {Stanowisko} — Alex Doe`
- **Islandia / Remote IT:** `[Career IT - IS] Application: {Job Title} — Alex Doe`
- **Polska Gastro:** `[Kariera Chef - PL] Aplikacja: Szef Kuchni / Manager — Alex Doe`
- **Islandia Gastro:** `[Career Chef - IS] Application: Head Chef / Kitchen Manager — Alex Doe`

---

## 4. Format Wiadomości (Dual-Format: Plain Text + HTML)

Do narzędzia `gmail_manage_draft` przekazuj **zarówno `body` (czysty tekst), jak i `html` (elegancki layout kandydata)**:

### 📝 Szablon Plain Text (`body`):
```text
Dzień dobry / Dear Hiring Team,

[Treść wiadomości dopasowana do oferty...]

W załączniku przesyłam moje CV oraz List Motywacyjny.

Z poważaniem / Kind regards,
Alex Doe
📞 +1 (555) 019-2834 | ✉️ candidate@example.com
🌐 Portfolio: https://flowmint-ai.web.app/
💻 GitHub: https://github.com/turboMe
🚀 Case Study: https://gastrobridge.com
📍 Reykjavík, Islandia / Polska (pełna dyspozycyjność do pracy zdalnej / relokacji)
```
*(ZAKAZ dopisywania w tekście linków do LinkedIn ani wymyślonych numerów +48...)*

### ✉️ Szablon HTML (`html`):
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; color: #1e293b; line-height: 1.6; padding: 20px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px;">
  <p style="font-size: 15px; margin-top: 0;">{Treść powitania i akapitu wstępnego nawiązującego do oferty firmy}</p>
  <p style="font-size: 15px;">{Akapit dotyczący kompetencji technicznych / zarządczych, architektury multi-agentowej, flowmint-ai.web.app i GastroBridge}</p>
  <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 18px 0; border-radius: 0 6px 6px 0;">
    <p style="margin: 0; font-size: 14px; font-weight: 600; color: #0f172a;">Kluczowe materiały i portfolio:</p>
    <p style="margin: 4px 0 0 0; font-size: 13px; color: #475569;">
      🌐 Portfolio AI & Automation: <a href="https://flowmint-ai.web.app/" style="color: #2563eb; text-decoration: none; font-weight: 500;">flowmint-ai.web.app</a><br>
      💻 GitHub: <a href="https://github.com/turboMe" style="color: #2563eb; text-decoration: none; font-weight: 500;">github.com/turboMe</a><br>
      🚀 Live SaaS Case Study: <a href="https://gastrobridge.com" style="color: #2563eb; text-decoration: none; font-weight: 500;">gastrobridge.com</a>
    </p>
  </div>
  <p style="font-size: 15px;">{Informacja o załączonych dokumentach PDF z dysku oraz propozycja krótkiej rozmowy online / na miejscu}</p>
  <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;">
  <p style="margin: 0; font-size: 14px; font-weight: 600; color: #0f172a;">Alex Doe</p>
  <p style="margin: 2px 0 0 0; font-size: 13px; color: #64748b;">
    📞 +1 (555) 019-2834 &nbsp;|&nbsp; ✉️ <a href="mailto:candidate@example.com" style="color: #2563eb; text-decoration: none;">candidate@example.com</a><br>
    🌐 <a href="https://flowmint-ai.web.app/" style="color: #2563eb; text-decoration: none;">flowmint-ai.web.app</a> &nbsp;|&nbsp; 💻 <a href="https://github.com/turboMe" style="color: #2563eb; text-decoration: none;">github.com/turboMe</a><br>
    📍 Reykjavík, Islandia / Polska (pełna dyspozycyjność do pracy zdalnej / relokacji)
  </p>
</div>
```

---

## 5. Procedura Wykonawcza (Batch Ingestion & Telegram Reporting)

Skill może zostać wywołany:
(A) Z bezpośrednią strukturą `QUALIFIED_JOBS_PAYLOAD` (przekazaną z `researcherAgent`), LUB
(B) Ze ścieżką do istniejącego pliku rejestru (`/projekty/splot-projects/projects/poland-ai-job/poland-ai-job-opportunities.md` lub `/projekty/splot-projects/projects/alfred-job/alfred-job-opportunities.md`). W tym wariancie odczytaj plik, wyodrębnij oferty posiadające adres email oraz powiązany plik ofert portalowych.

### 🔄 Krok 1: Przetwarzanie wsadowe ofert z emailem (`email_jobs`)

Przejdź przez **KAŻDĄ** pozycję w tablicy `email_jobs`. Jedyny dopuszczalny powód
pominięcia to bramka dedupu w podkroku 3 — nie pomijaj nic „z rozsądku".

> **Dlaczego jest tu bramka.** Wcześniej ta instrukcja brzmiała „nie pomijaj
> żadnej" i była wykonywana dosłownie. `crm_create_lead` robi upsert po adresie
> email, więc leady się nie dublowały i pipeline wyglądał na bezpieczny — ale
> draft w Gmailu powstawał za każdym razem. Firma, która wczoraj dostała maila
> (albo ma nietknięty draft czekający na akceptację), dostawała kolejny dziś.
> Jedynym zapisem „już do nich pisaliśmy" jest CRM, więc pytanie zadajemy tam,
> ZANIM powstanie draft.

1. **Określ segment CRM:**
   - IT Polska $\rightarrow$ `career_it_pl`
   - IT Islandia $\rightarrow$ `career_it_is`
   - Gastro Polska $\rightarrow$ `career_chef_pl`
   - Gastro Islandia $\rightarrow$ `career_chef_is`
2. **Dobierz załączniki z dysku:**
   - Przekaż gotową tablicę `attachments` ze ścieżkami absolutnymi zdefiniowanymi w Sekcji 2.
   - **Nigdy nie wywołuj `gmail_manage_draft` z pustą tablicą `attachments`** dla aplikacji o pracę.
3. **Bramka dedupu + Lead w CRM:**
   - Wywołaj `crm_create_lead` z danymi firmy, emailem, statusem `draft_gotowy`
     **oraz `skipIfEngaged: true`**.
   - **Jeśli wynik ma `action: "skipped"`** — ta firma ma już draft albo dostała
     maila (pole `existingStatus` mówi który to stan). **NIE twórz draftu w
     Gmailu, nie wywołuj `crm_record_email_draft`.** Dopisz pozycję do listy
     pominiętych i przejdź do następnej oferty.
   - Gdy `action` to `created` lub `updated` — kontynuuj podkrokiem 4.
4. **Utwórz Draft w Gmailu:**
   - Wywołaj `gmail_manage_draft` z `action: 'create'`, `account: 'personal'`, odpowiednim tematem `[Tag]`, wersją `body`, wersją `html` oraz tablicą `attachments`.
5. **Zapisz interakcję w CRM:**
   - Wywołaj `crm_record_email_draft` z ID utworzonego draftu.

### 📱 Krok 2: Powiadomienie i załącznik na Telegramie
Po przetworzeniu wszystkich pozycji:
1. **Wyślij wiadomość tekstową (`telegram_send_message`):**
   ```text
   🌅 Poranny raport rekrutacyjny:
   ✅ Utworzono {N} gotowych draftów w Gmailu (konto personal) z załącznikami PDF.
   ⏭️ Pominięto {S} ofert — firma jest już w CRM (draft lub wysłane).
   🌐 Wykryto {M} ofert do aplikacji online przez formularz (brak adresu email).
   ```
   Gdy `{S} > 0`, dopisz listę pominiętych w formacie
   `— {firma} ({existingStatus})`. Pominięcie ma być widoczne, a nie ciche:
   inaczej nie da się odróżnić „dedup zadziałał" od „research nic nie znalazł".
2. **Wyślij plik z ofertami portalowymi (`telegram_send_file`):**
   - Jeśli parametr `portal_jobs_file` istnieje i zawiera wpisy, wywołaj `telegram_send_file` z `filePath: portal_jobs_file` oraz `caption: "📄 Zestawienie ofert do aplikacji online (z gotowymi tekstami do wklejenia)"`.
