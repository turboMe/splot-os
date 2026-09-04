# React + Babel Project Guidelines

Technical guidelines that must be followed when prototyping with HTML + React + Babel. Failure to comply will lead to issues.

## Pinned Script Tags (Must Use These Versions)

Place these three script tags in the HTML `<head>`, using **pinned versions + integrity hashes**:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
```

**Do NOT** use unpinned versions like `react@18` or `react@latest`—this will cause version drift/caching issues.

**Do NOT** omit `integrity`—this is a defense line if the CDN is hijacked or tampered with.

## File Structure

```
project-name/
├── index.html               # Main HTML
├── components.jsx           # Component file (loaded with type="text/babel")
├── data.js                  # Data file
└── styles.css               # Additional CSS (optional)
```

How to load in HTML:

```html
<!-- First React + Babel -->
<script src="https://unpkg.com/react@18.3.1/..."></script>
<script src="https://unpkg.com/react-dom@18.3.1/..."></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/..."></script>

<!-- Then your component files -->
<script type="text/babel" src="components.jsx"></script>
<script type="text/babel" src="pages.jsx"></script>

<!-- Finally, the main entry point -->
<script type="text/babel">
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App />);
</script>
```

**Do NOT** use `type="module"`—it will conflict with Babel.

## Three Inviolable Rules

### Rule 1: Styles Objects Must Use Unique Names

**Incorrect** (will definitely break with multiple components):
```jsx
// components.jsx
const styles = { button: {...}, card: {...} };

// pages.jsx  ← Overwritten by same name!
const styles = { container: {...}, header: {...} };
```

**Correct**: Use a unique prefix for styles in each component file.

```jsx
// terminal.jsx
const terminalStyles = { 
  screen: {...}, 
  line: {...} 
};

// sidebar.jsx
const sidebarStyles = { 
  container: {...}, 
  item: {...} 
};
```

**Or use inline styles** (recommended for small components):
```jsx
<div style={{ padding: 16, background: '#111' }}>...</div>
```

This rule is **non-negotiable**. Every time you write `const styles = {...}`, you must replace it with a specific name, otherwise, the entire stack will error when multiple components are loaded.

### Rule 2: Scope Not Shared, Manual Export Required

**Key Understanding**: Each `<script type="text/babel">` is compiled independently by Babel, and their **scopes are not shared**. A `Terminal` component defined in `components.jsx` will be **undefined by default** in `pages.jsx`.

**Solution**: At the end of each component file, export the components/utilities you want to share to `window`:

```jsx
// End of components.jsx
function Terminal(props) { /* ... */ }
function Line(props) { /* ... */ }
const colors = { green: '#...', red: '#...' };

Object.assign(window, {
  Terminal, Line, colors,
  // List everything you want to use elsewhere here
});
```

Then `pages.jsx` can directly use `<Terminal />`, because JSX will look for `window.Terminal`.

### Rule 3: Do Not Use scrollIntoView

`scrollIntoView` will push the entire HTML container upwards, breaking the web harness layout. **Never use it**.

Alternative solutions:
```js
// Scroll to a specific position within the container
container.scrollTop = targetElement.offsetTop;

// Or use element.scrollTo
container.scrollTo({
  top: targetElement.offsetTop - 100,
  behavior: 'smooth'
});
```

## Calling Claude API (within HTML)

Some native design-agent environments (e.g., Claude.ai Artifacts) have a configuration-free `window.claude.complete`, but most agent environments (Claude Code / Codex / Cursor / Trae / etc.) **do not** have it locally.

If your HTML prototype needs to call an LLM for a demo (e.g., to create a chat interface), you have two options:

### Option A: Do Not Call Live API, Use Mock

Recommended for demo scenarios. Write a fake helper that returns a preset response:
```jsx
window.claude = {
  async complete(prompt) {
    await new Promise(r => setTimeout(r, 800)); // Simulate delay
    return "This is a mock response. Please replace with a real API for deployment.";
  }
};
```

### Option B: Call Live Anthropic API

Requires an API key; the user must enter their key in the HTML to run it. **Never hardcode the key in the HTML**.

```html
<input id="api-key" placeholder="Paste your Anthropic API key" />
<script>
window.claude = {
  async complete(prompt) {
    const key = document.getElementById('api-key').value;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    return data.content[0].text;
  }
};
</script>
```

**Note**: Directly calling the Anthropic API from the browser will encounter CORS issues. If the preview environment provided by the user does not support CORS bypass, this approach will not work. In that case, use Option A (mocking) or inform the user that a proxy backend is required.

### Option C: Use Agent-side LLM Capabilities to Generate Mock Data

For local demonstrations only, you can temporarily invoke the current agent's LLM capabilities (or a multi-model skill installed by the user) to generate mock response data, then hardcode it into the HTML. This way, the HTML runtime is completely independent of any API.

## Typical HTML Starter Template

Copy this template as the skeleton for your React prototype:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Prototype Name</title>

  <!-- React + Babel pinned -->
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; width: 100%; }
    body { 
      font-family: -apple-system, 'SF Pro Text', sans-serif;
      background: #FAFAFA;
      color: #1A1A1A;
    }
    #root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>

  <!-- Your component files -->
  <script type="text/babel" src="components.jsx"></script>

  <!-- Main entry point -->
  <script type="text/babel">
    const { useState, useEffect } = React;

    function App() {
      return (
        <div style={{padding: 40}}>
          <h1>Hello</h1>
        </div>
      );
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
  </script>
</body>
</html>
```

## Common Errors and Solutions

**`styles is not defined` or `Cannot read property 'button' of undefined`**
→ You defined `const styles` in one file, and another file overwrote it. Rename each to a specific name.

**`Terminal is not defined`**
→ Scope is not shared when referencing across files. Add `Object.assign(window, {Terminal})` at the end of the file where Terminal is defined.

**Entire page is blank, no console errors**
→ Most likely a JSX syntax error that Babel didn't report in the console. Temporarily replace `babel.min.js` with the uncompressed `babel.js` for clearer error messages.

**`ReactDOM.createRoot is not a function`**
→ Incorrect version. Confirm you are using react-dom@18.3.1 (not 17 or other versions).

**`Objects are not valid as a React child`**
→ You rendered an object instead of JSX/string. Usually, `{someObj}` was written instead of `{someObj.name}`.

## How to Split Files for Large Projects

**Single files over 1000 lines** are difficult to maintain. Here's a file splitting approach:

```
project/
├── index.html
├── src/
│   ├── primitives.jsx      # Basic elements: Button, Card, Badge...
│   ├── components.jsx      # Business components: UserCard, PostList...
│   ├── pages/
│   │   ├── home.jsx        # Home page
│   │   ├── detail.jsx      # Detail page
│   │   └── settings.jsx    # Settings page
│   ├── router.jsx          # Simple router (React state switching)
│   └── app.jsx             # Entry component
└── data.js                 # Mock data
```

Load in HTML in order:
```html
<script type="text/babel" src="src/primitives.jsx"></script>
<script type="text/babel" src="src/components.jsx"></script>
<script type="text/babel" src="src/pages/home.jsx"></script>
<script type="text/babel" src="src/pages/detail.jsx"></script>
<script type="text/babel" src="src/pages/settings.jsx"></script>
<script type="text/babel" src="src/router.jsx"></script>
<script type="text/babel" src="src/app.jsx"></script>
```

**At the end of each file**, you must `Object.assign(window, {...})` to export what needs to be shared.
