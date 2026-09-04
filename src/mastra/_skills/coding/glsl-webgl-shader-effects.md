---
name: glsl-webgl-shader-effects
description: Write performant custom GLSL shaders (vertex displacement, noise fields, holographic glass, fluid ripples) for Three.js / R3F shaderMaterial.
category: coding
keywords:
  - glsl
  - shader
  - webgl
  - threejs
  - r3f
  - noise
  - vertex-displacement
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - search_content
estimatedTokens: 352
outputFormat: typescript
tags:
  - 3d-web
  - glsl
  - subagent-tier
version: 1
---

# Procedure: GLSL & WebGL Custom Shader Effects

Use this procedure to author high-performance, GPU-accelerated vertex and fragment shaders in GLSL for React Three Fiber (`shaderMaterial`) or vanilla Three.js.

---

## 1. Shader Construction Standards

1. **Precision & Optimization:**
   - Always declare precision: `precision mediump float;` for mobile compatibility.
   - Avoid branching (`if/else`) inside fragment shaders whenever possible; use `step()`, `smoothstep()`, and `mix()` for smooth interpolation.

2. **Standard Uniform Pipeline:**
   - `uTime` (float): Elapsed time updated every frame for continuous animation.
   - `uResolution` (vec2): Canvas pixel dimensions for aspect ratio correction.
   - `uMouse` (vec2): Normalized mouse position `[-1, 1]` for interactive fluid/wave distortion.

3. **Vertex Displacement & Noise:**
   - Use Simplex or Perlin 3D noise functions inside vertex shaders for organic geometry undulating (cloth waves, terrain displacement, organic blob meshes).

4. **Fragment Shading & Chromatic Aberration:**
   - Implement optical glass dispersion by sampling RGB channels with slight spatial offsets.
   - Clamp final output colors: `gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha);`.

---

## 2. Output Contract
Return a custom `shaderMaterial` definition along with the raw vertex and fragment GLSL strings and the React Three Fiber mesh implementation.
