---
name: spline-3d-interactive-embed
description: Embed and optimize interactive Spline 3D scenes in React/Next.js with dynamic client-only imports, viewport lazy-loading, CLS prevention, and event bridging.
category: coding
keywords:
  - spline
  - 3d
  - nextjs
  - react-spline
  - webgl
  - interactivity
minComplexity: medium
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - search_content
estimatedTokens: 416
outputFormat: typescript
tags:
  - 3d-web
  - spline
  - subagent-tier
version: 1
---

# Procedure: Spline 3D Interactive Embed & Optimization

Use this procedure when integrating interactive Spline 3D scenes (`@splinetool/react-spline`) into Next.js/React web applications while protecting Core Web Vitals (LCP, CLS, TBT).

---

## 1. Production Architecture Checklist

1. **Dynamic Import (Disable SSR):**
   - Spline uses browser-only WebGL APIs. Always load dynamically with `ssr: false`:
     ```tsx
     const Spline = dynamic(() => import('@splinetool/react-spline'), {
       ssr: false,
       loading: () => <div className="w-full h-full bg-zinc-900/50 animate-pulse rounded-2xl" />
     })
     ```

2. **Viewport-Based Lazy Loading (Intersection Observer):**
   - If the Spline scene is below the fold, do NOT load the WebGL canvas until the container is within 150px of the viewport.

3. **Cumulative Layout Shift (CLS) Prevention:**
   - Always lock the aspect ratio or rigid dimensions on the container wrapper (`relative w-full aspect-video md:h-[600px]`).

4. **Scroll & Pointer Event Control:**
   - If the 3D scene is a background ambient canvas, apply `pointerEvents: 'none'` so page scrolling is never captured/blocked.
   - For interactive scenes, isolate canvas interaction to dedicated hit areas.

5. **React-to-Spline State Bridging:**
   - Capture the Spline application instance via `onLoad={(splineApp) => (splineRef.current = splineApp)}`.
   - Trigger Spline internal animations from React state: `splineRef.current.emitEvent('mouseHover', 'Object_Name')`.

---

## 2. Output Contract
Return a complete Next.js client component (`'use client'`) encapsulating the Spline canvas, loading skeleton, and event handlers.
