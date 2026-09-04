---
name: threejs-r3f-scene-architect
description: "Use for architect high-performance 3D web experiences using React Three Fiber (R3F), Drei, and Three.js with 60fps frame loops, GLTF preloading, and zero-leak memory disposal."
category: coding
keywords:
  - threejs
  - r3f
  - react-three-fiber
  - 3d
  - webgl
  - drei
  - canvas
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - search_content
estimatedTokens: 410
outputFormat: typescript
tags:
  - 3d-web
  - r3f
  - subagent-tier
version: 1
---

# Procedure: Three.js & React Three Fiber (R3F) Scene Architect

Use this procedure when designing, implementing, or optimizing 3D WebGL scenes using `@react-three/fiber` and `@react-three/drei`.

---

## 1. Critical Rules & Anti-Pattern Elimination

1. **The Cardinal Rule (Zero Re-renders in Render Loops):**
   - **NEVER** call `useState` or trigger React state updates inside `useFrame()`. This forces 60+ re-renders/sec and annihilates frame rates.
   - Always animate by directly mutating mutable Three.js refs:
     ```tsx
     useFrame((state, delta) => {
       meshRef.current.rotation.y += delta * 0.5
     })
     ```

2. **Asset Pipeline & Suspension:**
   - Preload critical GLTF/GLB models using `useGLTF.preload('/models/scene.glb')`.
   - Wrap the `<Canvas>` interior in `<Suspense fallback={<Loader3D />}>` to eliminate layout jank.
   - Use DRACO / KTX2 compressed assets to keep 3D asset payloads under 3MB.

3. **Lighting, Environment & DPR Capping:**
   - Cap canvas device pixel ratio: `<Canvas dpr={[1, 2]}>` to avoid rendering 3x/4x native Retina resolutions on mobile GPUs.
   - Prefer image-based lighting (`<Environment preset="city" />`) over 4+ real-time shadow-casting point lights.

4. **HTML Overlays & Annotations:**
   - Use Drei's `<Html center distanceFactor={15}>` to anchor interactive React UI cards/tooltips into 3D world space.

5. **Memory Hygiene:**
   - Ensure dynamic meshes and textures are cleaned up on component unmount to prevent WebGL context lost errors.

---

## 2. Output Contract
Return a complete, production-ready React component exporting the R3F Canvas and 3D scene elements.
