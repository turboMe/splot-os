---
name: css-3d-parallax-transforms
description: Construct lightweight, zero-WebGL 3D card tilts, isometric layers, and scroll-driven depth illusions using pure CSS 3D transforms and minimal JS.
category: design
keywords:
  - 3d
  - css
  - transform
  - parallax
  - tilt
  - isometric
  - frontend
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 348
outputFormat: markdown
tags:
  - 3d-web
  - css
  - fast-tier
version: 1
---

# Procedure: CSS 3D Parallax & Spatial Transforms

Use this procedure to generate performant, zero-WebGL 3D visual illusions (interactive card tilts, isometric perspective grids, multi-layer depth parallax) for landing pages without heavy Three.js bundle overhead.

---

## 1. Core Implementation Standards

1. **Perspective & Preserved 3D Context:**
   - Always set `perspective: 1000px;` (or Tailwind `[perspective:1000px]`) on the parent container.
   - Set `transform-style: preserve-3d;` on the moving card/layer container.
   - Use `translateZ(px)` to separate foreground badges, text, and background surfaces into physical depth planes.

2. **Hardware Acceleration & Smoothness:**
   - Force GPU compositing: `will-change: transform; backface-visibility: hidden; transform: translate3d(0, 0, 0);`.
   - For mouse-driven tilt, map normalized cursor position `(dx, dy) ∈ [-0.5, 0.5]` to rotation angles (`max ±15deg` on `rotateX` and `rotateY`).
   - Inverse `rotateX` relative to vertical delta: `transform: rotateX(${-dy * maxAngle}deg) rotateY(${dx * maxAngle}deg)`.

3. **Accessibility & Reduced Motion:**
   - Respect `prefers-reduced-motion: reduce`: disable 3D rotation and provide subtle 2D opacity/scale transitions instead.

---

## 2. Output Contract
Return the complete React/Tailwind/CSS snippet with markup, depth layers (`translateZ`), and mouse-move/hover handlers.
