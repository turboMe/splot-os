# GŁÓWNA MAPA WIEDZY SYSTEMU (MASTER KNOWLEDGE BASE INDEX)

Katalog `src/mastra/knowledge/` stanowi kanoniczne źródło prawdy (Single Source of Truth) dla wszystkich agentów w środowisku Splot OS.

> **ZASADA DLA AGENTÓW:**
> Gdy tworzysz treści w imieniu użytkownika, redagujesz oferty handlowe, drafty wiadomości e-mail lub weryfikujesz dopasowanie kandydata, masz bezwzględny obowiązek korzystać z wiedzy zawartej w tych plikach.
> Używaj narzędzia `knowledge_lookup(path, section?)` do pobierania dokładnych fragmentów wiedzy.

---

## 🗺️ Mapa Modułów Wiedzy

```text
src/mastra/knowledge/
├── INDEX.md                                <-- [Ten dokument] Główna mapa nawigacyjna
│
├── personal/                               <-- DOMENA OSOBISTA I GROUNDING KANDYDATA
│   ├── INDEX.md                            <-- Spis treści i rejestr faktów personalnych
│   └── identity/
│       ├── core-anchor.yaml                <-- Zwięzły ekstrakt YAML (tożsamość, kontakt, zasady)
│       └── grounding-it-ai.md              <-- Profil IT / AI / Solutions Engineer
│
├── business/                               <-- DOMENA PRZEDSIĘWZIĘĆ BIZNESOWYCH
│   └── INDEX.md                            <-- Spis treści i rejestr wiedzy komercyjnej
│
└── starter-packs/                          <-- PAKIETY STARTOWE (ONBOARDING)
    ├── business-starter-pack.json          <-- Szablon wiedzy biznesowej
    ├── chef-culinary-pack.json             <-- Szablon wiedzy gastronomicznej
    └── content-strategy.json               <-- Szablon strategii contentowej
```

---

## 🔒 Prywatność i Bezpieczeństwo
Prywatne dokumenty (CV w formacie PDF, cenniki handlowe, prywatne dane wrażliwe) powinny być umieszczane w katalogu `src/mastra/knowledge/` i ignorowane przez `.gitignore`, aby zapobiec ich wyciekowi do publicznych repozytoriów.
