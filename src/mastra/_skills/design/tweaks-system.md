# Tweaks: Real-time Parameter Adjustment for Design Variations

Tweaks are a core capability in this skill – allowing users to switch variations and adjust parameters in real-time without changing code.

**Cross-Agent Environment Adaptability**: Some native design-agent environments (e.g., Claude.ai Artifacts) rely on the host's postMessage to write tweak values back to the source code for persistence. This skill adopts a **pure frontend localStorage solution** – achieving the same effect (state preserved on refresh), but persistence occurs in the browser's localStorage rather than the source file. This solution works in any agent environment (Claude Code / Codex / Cursor / Trae / etc.).

## When to Add Tweaks

- User explicitly requests "adjustable parameters" or "multiple version switching"
- When a design has multiple variations that need comparison
- Even if the user doesn't explicitly ask, if you subjectively judge that **adding a few inspiring tweaks can help the user see possibilities**

Default recommendation: **Add 2-3 tweaks to every design** (color theme / font size / layout variations), even if the user doesn't ask – showing users the possibility space is part of design service.

## Implementation Method (Frontend-only Version)

### Basic Structure

```jsx
const TWEAK_DEFAULTS = {
  "primaryColor": "#D97757",
  "fontSize": 16,
  "density": "comfortable",
  "dark": false
};

function useTweaks() {
  const [tweaks, setTweaks] = React.useState(() => {
    try {
      const stored = localStorage.getItem('design-tweaks');
      // Merge stored tweaks with defaults, prioritizing stored values
      return stored ? { ...TWEAK_DEFAULTS, ...JSON.parse(stored) } : TWEAK_DEFAULTS;
    } catch {
      // Fallback to defaults if localStorage fails
      return TWEAK_DEFAULTS;
    }
  });

  const update = (patch) => {
    const next = { ...tweaks, ...patch };
    setTweaks(next);
    try {
      // Persist to localStorage
      localStorage.setItem('design-tweaks', JSON.stringify(next));
    } catch {}
  };

  const reset = () => {
    setTweaks(TWEAK_DEFAULTS);
    try {
      // Remove from localStorage
      localStorage.removeItem('design-tweaks');
    } catch {}
  };

  return { tweaks, update, reset };
}
```

### Tweaks Panel UI

Floating panel in the bottom right corner. Collapsible:

```jsx
function TweaksPanel() {
  const { tweaks, update, reset } = useTweaks();
  const [open, setOpen] = React.useState(false);

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      zIndex: 9999,
    }}>
      {open ? (
        <div style={{
          background: 'white',
          border: '1px solid #e5e5e5',
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
          width: 280,
          fontFamily: 'system-ui',
          fontSize: 13,
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginBottom: 16,
          }}>
            <strong>Tweaks</strong>
            <button onClick={() => setOpen(false)} style={{
              border: 'none', background: 'none', cursor: 'pointer', fontSize: 16,
            }}>×</button>
          </div>

          {/* Color */}
          <label style={{ display: 'block', marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#666' }}>Primary Color</div>
            <input 
              type="color" 
              value={tweaks.primaryColor} 
              onChange={e => update({ primaryColor: e.target.value })}
              style={{ width: '100%', height: 32 }}
            />
          </label>

          {/* Font size slider */}
          <label style={{ display: 'block', marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#666' }}>Font Size ({tweaks.fontSize}px)</div>
            <input 
              type="range" 
              min={12} max={24} step={1}
              value={tweaks.fontSize}
              onChange={e => update({ fontSize: +e.target.value })}
              style={{ width: '100%' }}
            />
          </label>

          {/* Density options */}
          <label style={{ display: 'block', marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#666' }}>Density</div>
            <select 
              value={tweaks.density}
              onChange={e => update({ density: e.target.value })}
              style={{ width: '100%', padding: 6 }}
            >
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
              <option value="spacious">Spacious</option>
            </select>
          </label>

          {/* Dark mode toggle */}
          <label style={{ 
            display: 'flex', 
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
          }}>
            <input 
              type="checkbox" 
              checked={tweaks.dark}
              onChange={e => update({ dark: e.target.checked })}
            />
            <span>Dark Mode</span>
          </label>

          <button onClick={reset} style={{
            width: '100%',
            padding: '8px 12px',
            background: '#f5f5f5',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12,
          }}>Reset</button>
        </div>
      ) : (
        <button 
          onClick={() => setOpen(true)}
          style={{
            background: '#1A1A1A',
            color: 'white',
            border: 'none',
            borderRadius: 999,
            padding: '10px 16px',
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >⚙ Tweaks</button>
      )}
    </div>
  );
}
```

### Applying Tweaks

Use Tweaks in the main component:

```jsx
function App() {
  const { tweaks } = useTweaks();

  return (
    <div style={{
      '--primary': tweaks.primaryColor,
      '--font-size': `${tweaks.fontSize}px`,
      background: tweaks.dark ? '#0A0A0A' : '#FAFAFA',
      color: tweaks.dark ? '#FAFAFA' : '#1A1A1A',
    }}>
      {/* Your content */}
      <TweaksPanel />
    </div>
  );
}
```

Using variables in CSS:

```css
button.cta {
  background: var(--primary);
  color: white;
  font-size: var(--font-size);
}
```

## Typical Tweak Options

What tweaks to add for different design types:

### General
- Primary color (color picker)
- Font size (slider 12-24px)
- Font style (select: display font vs body font)
- Dark mode (toggle)

### Slide Deck
- Theme (light/dark/brand)
- Background style (solid/gradient/image)
- Font contrast (more decorative vs more restrained)
- Information density (minimal/standard/dense)

### Product Prototype
- Layout variations (layout A / B / C)
- Interaction speed (animation speed 0.5x-2x)
- Data volume (number of mock data items 5/20/100)
- State (empty/loading/success/error)

### Animation
- Speed (0.5x-2x)
- Loop (once/loop/ping-pong)
- Easing (linear/easeOut/spring)

### Landing Page
- Hero style (image/gradient/pattern/solid)
- CTA copy (several variations)
- Structure (single column / two column / sidebar)

## Tweaks Design Principles

### 1. Meaningful Options, Not Fussy Ones

Each tweak must showcase **real design options**. Don't add tweaks that no one would actually switch (e.g., a border-radius 0-50px slider – users will find all intermediate values ugly).

Good tweaks expose **discrete, thoughtful variations**:
- "Rounded Corner Style": No rounded corners / Slight rounded corners / Large rounded corners (three options)
- Not: "Rounded Corners": 0-50px slider

### 2. Less is More

A design's Tweaks panel should have a **maximum of 5-6 options**. Any more and it becomes a "configuration page," losing the meaning of quickly exploring variations.

### 3. Default Value is a Complete Design

Tweaks are **the icing on the cake**. The default values must themselves constitute a complete, publishable design. What the user sees after closing the Tweaks panel should be the final output.

### 4. Logical Grouping

Group options when there are many:

```
---- Visual ----
Primary Color | Font Size | Dark Mode

---- Layout ----
Density | Sidebar Position

---- Content ----
Display Data Volume | State
```

## Forward Compatibility for Source-Level Persistent Hosts

If you later want to upload your design to an environment that supports source-level tweaks (like Claude.ai Artifacts), keep the **EDITMODE marker blocks**:

```jsx
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#D97757",
  "fontSize": 16,
  "density": "comfortable",
  "dark": false
}/*EDITMODE-END*/;
```

The marker block has **no effect** in the localStorage solution (it's just a regular comment), but it will be read by hosts that support source code rewriting, enabling source-level persistence. Adding this is harmless to the current environment and maintains forward compatibility.

## Common Issues

**Tweaks panel obstructs design content**
→ Make it closable. Default to closed, show a small button, and expand only when the user clicks it.

**User has to re-set tweaks after switching**
→ Already using localStorage. If it doesn't persist after refresh, check if localStorage is available (incognito mode might fail, so catch it).

**Want to share tweaks across multiple HTML pages**
→ Add a project name to the localStorage key: `design-tweaks-[projectName]`.

**I want tweaks to have interdependencies**
→ Add logic in `update`:

```jsx
const update = (patch) => {
  let next = { ...tweaks, ...patch };
  // Interdependency: automatically switch font color when dark mode is selected
  if (patch.dark === true && !patch.textColor) {
    next.textColor = '#F0EEE6';
  }
  setTweaks(next);
  localStorage.setItem(...);
};
```