# Workspace-UI — Chef views expansion (dev plan)

Goal: surface the rest of the chef pipeline output in `http://localhost:4111/workspace-ui`.
Today the dashboard shows only **projects** + **menus**. Add: recipe/technological cards (A),
pipeline status (C), Menu Book + PDF (B), and optionally chef notes (D).

Rollout order: **A + C first**, then **B**, then **D (optional)**.

Stack reminder: single-file vanilla-JS HTML, zero build. Backend = Hono `registerApiRoute`.
4-layer pattern per view: **service fn → API route → HTML section → JS handler**.

Anchor files:
- UI: `src/mastra/workspace/index.html`
- API routes: `src/mastra/index.ts` (chef block at lines 739–761)
- Data layer: `src/mastra/services/workspace-service.ts` (chef block at lines 400–418)
- Schemas: `src/mastra/tools/chef/chef-service.ts` (`ChefRecipe` 189–208, statuses 21–33)
- Menu Book files: `CHEF_DOCS_DIR` default `/projekty/splot-projects/menu-books/<projectId>.{md,pdf}`
  (`src/mastra/tools/chef/chef-document-tools.ts:11`, `bookPath()` :70)

Conventions to mirror (do NOT invent new ones):
- API path shape `/ws/chef/<resource>/:projectId`, returns `{ data: [...] }`.
- Service fns use `getDb()` + `{ projection: { _id: 0 } }`.
- Frontend helpers already exist: `api(path)`, `esc(s)`, `$()`, `$$()`. CSS classes:
  `.panes`, `.pane`, `.field`, `.signal`, `.hook`, `.empty`, `.v`, `.s`, `.t`, `.stat`.
- Recipe ↔ menu dish link is by `projectId` + `dishName` (menu dishes have no stable id).

---

## STAGE A — Technological / recipe cards (`chef_recipes`)

`ChefRecipe` fields to render (chef-service.ts:189–208):
`dishName`, `yield {amount, unit}`, `components[] {componentName, ingredients[] {name, quantity, unit, notes}, miseEnPlace[] {order, instruction, temperature?, time?}}`,
`serviceSteps[] {order, instruction, temperature?, time?}`, `allergens[]`, `equipmentNeeded[]`.

### A1. Service (`workspace-service.ts`, append after line 418)
```ts
export async function listChefRecipes(projectId: string): Promise<any[]> {
  const db = await getDb();
  return db
    .collection('chef_recipes')
    .find({ projectId }, { projection: { _id: 0 } })
    .sort({ dishName: 1 })
    .toArray();
}
```
(No separate `getChefRecipe` needed — recipes are small; the list endpoint can return full
docs and the UI renders detail client-side. Add a single-doc fn only if payloads grow.)

### A2. API route (`index.ts`, insert after line 761, before the `/workspace-ui` route)
```ts
registerApiRoute('/ws/chef/recipes/:projectId', {
  method: 'GET',
  handler: async (c: any) => {
    try {
      const ws = await import('./services/workspace-service.js');
      return c.json({ data: await ws.listChefRecipes(c.req.param('projectId')) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  },
}),
```

### A3. HTML (`index.html`)
Decision: **third pane inside the existing chef section** (keeps everything in project context).
Replace the chef section (lines 178–184) two-pane layout with three panes:
```html
<section id="tab-chef" class="hidden">
  <div class="panes panes-3">
    <div class="pane"><h3>👨‍🍳 Projekty Chef</h3><div id="chefList"></div></div>
    <div class="pane" id="chefMenus"><div class="empty">Wybierz projekt.</div></div>
    <div class="pane" id="chefRecipes"><div class="empty">Karty technologiczne.</div></div>
  </div>
</section>
```
Add a small CSS rule near the existing `.panes` definition for a 3-column variant
(fallback to wrap on narrow screens). If `.panes` is already responsive grid, `.panes-3`
just sets `grid-template-columns: 1fr 1.4fr 1.4fr` or similar.

### A4. JS handler (`index.html`, in the chef block around line 424–440)
Extend `showChef(id)` to also fetch recipes, and add a renderer:
```js
window.showChef = async (id) => {
  const [menus, recipes] = await Promise.all([
    api('/ws/chef/menus/' + encodeURIComponent(id)),
    api('/ws/chef/recipes/' + encodeURIComponent(id)),
  ]);
  // ...existing menu render into #chefMenus...
  renderRecipes(recipes.data);
};

function renderRecipes(list) {
  if (!list || !list.length) {
    $('#chefRecipes').innerHTML = '<div class="empty">Brak kart technologicznych. '
      + 'Pipeline nie wszedł jeszcze w etap RECIPES.</div>';
    return;
  }
  $('#chefRecipes').innerHTML = list.map(r => `
    <div class="field">
      <h3>${esc(r.dishName)}</h3>
      <div class="s">Wydajność: ${esc(r.yield?.amount)} ${esc(r.yield?.unit)}${
        r.allergens?.length ? ' · Alergeny: ' + r.allergens.map(esc).join(', ') : ''}</div>
      ${(r.components||[]).map(comp => `
        <div class="hook">
          <b>${esc(comp.componentName)}</b>
          <table class="recipe-bom">
            ${(comp.ingredients||[]).map(i => `<tr>
              <td>${esc(i.name)}</td><td>${esc(i.quantity)} ${esc(i.unit)}</td>
              <td class="s">${esc(i.notes||'')}</td></tr>`).join('')}
          </table>
          ${(comp.miseEnPlace||[]).length ? '<ol>' + comp.miseEnPlace
            .sort((a,b)=>a.order-b.order)
            .map(s => `<li>${esc(s.instruction)}${s.temperature?` · ${esc(s.temperature)}`:''}${
              s.time?` · ${esc(s.time)}`:''}</li>`).join('') + '</ol>' : ''}
        </div>`).join('')}
      ${(r.serviceSteps||[]).length ? `<div class="hook"><b>Serwis</b><ol>${
        r.serviceSteps.sort((a,b)=>a.order-b.order)
          .map(s=>`<li>${esc(s.instruction)}</li>`).join('')}</ol></div>` : ''}
      ${(r.equipmentNeeded||[]).length ? `<div class="s">Sprzęt: ${
        r.equipmentNeeded.map(esc).join(', ')}</div>` : ''}
    </div>`).join('');
}
```
Add minimal CSS for `.recipe-bom` (full-width table, 3 cols, light border) next to existing
table-ish styles.

### A5. Edge cases
- Recipes exist but for dishes not in current menu version → still show (link is by name only).
- Numeric `quantity` could be `0`/`undefined` → `esc()` already null-safes.
- Large projects (10+ recipes) render fine as a scrollable pane; no pagination needed yet.

---

## STAGE C — Pipeline status badge (no new endpoint)

`chef_projects.status` already comes back from `/ws/chef/projects`. Pipeline statuses:
`intake, recon, profile_synthesis, checkpoint_profile, menu_draft, critic_gate,
checkpoint_menu, recipes, qa_final, render, done` (chef-service.ts:21–33). Legacy statuses
(`questionnaire/review/generating/approved/archived`) may also appear — handle unknown gracefully.

### C1. Status → label/color map (`index.html`, near the existing `STATUS_LABEL` const ~218)
```js
const CHEF_STAGE = {
  intake:{l:'Wywiad',c:'#888'}, recon:{l:'Recon',c:'#888'},
  profile_synthesis:{l:'Profil',c:'#c90'}, checkpoint_profile:{l:'Profil ✓',c:'#c90'},
  menu_draft:{l:'Menu',c:'#39c'}, critic_gate:{l:'Krytyka',c:'#39c'},
  checkpoint_menu:{l:'Menu ✓',c:'#39c'}, recipes:{l:'Przepisy',c:'#6a3'},
  qa_final:{l:'QA',c:'#6a3'}, render:{l:'Render',c:'#6a3'}, done:{l:'Gotowe',c:'#2a2'},
};
const chefStage = (s) => CHEF_STAGE[s] || {l:s||'—',c:'#888'};
```

### C2. Use it in `loadChef()` (lines 424–433)
Render a colored badge per project so the user sees at a glance whether recipes/book exist
(`recipes`+ means cards should be present; `done` means PDF rendered):
```js
$('#chefList').innerHTML = res.data.map(p => {
  const st = chefStage(p.status);
  return `<div class="signal" onclick='showChef(${JSON.stringify(p.id)})'>
    <div class="t">${esc(p.name||'(projekt)')}
      <span class="badge" style="background:${st.c}">${esc(st.l)}</span></div>
    <div class="s">${esc(p.profile?.establishmentType||'')}</div>
  </div>`;
}).join('') || '<div class="empty">Brak projektów.</div>';
```
Add a tiny `.badge` CSS class (inline-block, padding 1–6px, radius, white text, font-size 11px).

### C3. Optional nicety
In `renderRecipes` empty-state, tailor the message using the project status passed through
(e.g. if status is before `recipes`, say "pipeline na etapie X"). Low priority.

---

## STAGE B — Menu Book document + PDF download

Final deliverable lives on disk, not in Mongo: `CHEF_DOCS_DIR/<projectId>.md` and `.pdf`.
Reuse the path-traversal guard pattern from `bookPath()` (chef-document-tools.ts:70) — do NOT
trust the raw `projectId` param.

### B1. Service (`workspace-service.ts`)
Add a small helper module-local resolver (mirror `bookPath`) or import `CHEF_DOCS_DIR` env:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
const CHEF_DOCS_DIR = path.resolve(process.env.CHEF_DOCS_DIR || '/projekty/splot-projects/menu-books');
function safeBookPath(projectId: string, ext: 'md'|'pdf'): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid projectId.');
  const fp = path.resolve(CHEF_DOCS_DIR, `${safeId}.${ext}`);
  if (!fp.startsWith(CHEF_DOCS_DIR + path.sep)) throw new Error('Path escape denied.');
  return fp;
}
export async function getChefBookMarkdown(projectId: string): Promise<string|null> {
  try { return await fs.readFile(safeBookPath(projectId,'md'), 'utf8'); }
  catch { return null; }
}
export async function getChefBookPdfPath(projectId: string): Promise<string|null> {
  const fp = safeBookPath(projectId,'pdf');
  try { await fs.access(fp); return fp; } catch { return null; }
}
```

### B2. API routes (`index.ts`, after the recipes route)
```ts
registerApiRoute('/ws/chef/book/:projectId', {        // markdown (for in-UI preview)
  method: 'GET',
  handler: async (c: any) => {
    const ws = await import('./services/workspace-service.js');
    const md = await ws.getChefBookMarkdown(c.req.param('projectId'));
    if (md == null) return c.json({ error: 'Book not found' }, 404);
    return c.json({ data: { markdown: md } });
  },
}),
registerApiRoute('/ws/chef/book/:projectId/pdf', {    // binary download
  method: 'GET',
  handler: async (c: any) => {
    const ws = await import('./services/workspace-service.js');
    const fp = await ws.getChefBookPdfPath(c.req.param('projectId'));
    if (!fp) return c.json({ error: 'PDF not found' }, 404);
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(fp);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `inline; filename="menu-book-${c.req.param('projectId')}.pdf"`);
    return c.body(buf);
  },
}),
```
Note: confirm Hono `c.body(Buffer)` works in this Mastra version; if it streams oddly, return
`new Response(buf, {headers})` instead. PDF is generated by the `chef_document_pdf` tool during
the RENDER phase — the dashboard only serves what already exists (404 otherwise).

### B3. UI
In the chef section, when a project is selected and status is `render`/`done`, show in
`#chefMenus` header (or a 4th small pane) two actions:
```js
const pdfUrl = '/ws/chef/book/' + encodeURIComponent(id) + '/pdf';
// link: <a href="${pdfUrl}" target="_blank">📕 Pobierz Księgę (PDF)</a>
```
Optional markdown preview: fetch `/ws/chef/book/:id`, render in a drawer via existing
`openDrawer(html)` (escape or use a tiny markdown→HTML; reuse `micromark` only server-side —
keep client dumb, so prefer rendering markdown as `<pre>` unless a renderer is desired).
404 → hide the buttons (book not built yet).

---

## STAGE D — Chef notes (`chef_notes`) — optional, low priority

Read-only insight into what the agent "learned" (preferences, pairings, feedback).
Exclude `nlm_cache` and the `embedding` field.

### D1. Service
```ts
export async function listChefNotes(projectId: string): Promise<any[]> {
  const db = await getDb();
  return db.collection('chef_notes')
    .find({ projectId, type: { $ne: 'nlm_cache' } },
          { projection: { _id: 0, embedding: 0 } })
    .sort({ createdAt: -1 }).toArray();
}
```
### D2. API: `/ws/chef/notes/:projectId` (same shape).
### D3. UI: collapsible list grouped by `type` inside the recipes pane or a drawer. Lowest value.

---

## Cross-cutting notes

- **No auth / no write** on these endpoints — read-only, matches existing chef routes. Don't add
  mutation endpoints here.
- **Security**: only Stage B touches the filesystem; the `safeBookPath` guard is mandatory.
- **Empty states** matter — a user whose pipeline stopped at MENU must see *why* (status badge +
  "no recipes yet" copy), not a blank pane. This is the actual UX problem that triggered this work.
- **No new deps** for A/C. B reads files with the std `node:fs` already used by `/workspace-ui`.

## Test plan
1. Seed/confirm a project that reached `done` (has recipes + book.md + book.pdf).
2. `curl localhost:4111/ws/chef/recipes/<id>` → `{data:[...]}` with components/ingredients.
3. `curl localhost:4111/ws/chef/book/<id>` → markdown; `.../pdf` → PDF bytes.
4. Open `/workspace-ui` → Chef tab: status badges render; selecting a project fills recipes pane;
   PDF link works for `done` projects, hidden for early-stage ones.
5. Edge: project at `menu_draft` → recipes pane shows empty-state copy, no PDF link, no errors.

## Suggested commit slicing
1. A+C backend (service fns + recipes route) — one commit.
2. A+C frontend (3-pane layout, renderRecipes, status badges) — one commit.
3. B backend (book/pdf service + routes) — one commit.
4. B frontend (PDF link + optional preview) — one commit.
5. D (optional) — separate commit.
