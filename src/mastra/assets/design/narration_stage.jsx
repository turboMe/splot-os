/**
 * narration_stage.jsx · Narration-driven Stage
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  🛑 Must read before using this toolset: references/voiceover-pipeline.md ║
 * ║                                                                  ║
 * ║  Iron Rule #1: The entire piece is a continuous motion narrative, not a set of independent scenes. ║
 * ║          You are not making 7 slides. You are directing 1 movie. ║
 * ║                                                                  ║
 * ║  Iron Rule #2: The selected hero element persists across scenes; do not use a new layout for each segment. ║
 * ║                                                                  ║
 * ║  Iron Rule #3: Hard cuts between scenes are forbidden (opacity 1→0/0→1). ║
 * ║          Morph, don't cut.                                       ║
 * ║                                                                  ║
 * ║  Failure Mode #1 (pitfall from v1 of this skill in practice):    ║
 * ║          Each Scene has its own independent layout + cues use fade-up + scene transitions ║
 * ║          Page-wide opacity transitions = PowerPoint with voiceover = zero quality ║
 * ║                                                                  ║
 * ║  Correct approach: Place the hero directly as a child of <NarrationStage> (not inside a Scene). ║
 * ║          Use useNarration() within the hero to read time/scene/cue status. ║
 * ║          The hero itself determines its form based on the current time → continuous motion across scenes. ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage (inline into HTML <script type="text/babel">):
 *   const { NarrationStage, Scene, Cue, useNarration } = NarrationStageLib;
 *
 *   const App = () => (
 *     <NarrationStage timeline={TIMELINE} audioSrc="voiceover.mp3"
 *                     width={1920} height={1080}>
 *       <Scene id="intro">
 *         <h1>What is a token?</h1>
 *         <Cue id="question">
 *           {(triggered) => triggered && <p>↑ This is the question</p>}
 *         </Cue>
 *       </Scene>
 *       <Scene id="token-2">
 *         <Cue id="split">
 *           {(triggered, progress) => (
 *             <div style={{opacity: triggered ? 1 : 0.3}}>...</div>
 *           )}
 *         </Cue>
 *       </Scene>
 *     </NarrationStage>
 *   );
 *
 * Time Source (automatically chooses one of two):
 *   - Recording mode (window.__recording === true): Uses window.__time (external driver pushes frames).
 *   - Live playback mode: Uses <audio>'s currentTime (strictly synchronized with audio when user clicks play).
 *
 * Compatible with render-video.js:
 *   - On the first tick, set window.__ready = true.
 *   - When recording, detect window.__recording to force no audio playback and use window.__time.
 *   - Expose window.__totalDuration for the driver to calculate total frames.
 *
 * Dependencies: React 18 + ReactDOM 18 + Babel standalone (same as animations.jsx)
 */

const NarrationStageLib = (() => {
  const NarrationContext = React.createContext({
    time: 0,
    scene: null,
    sceneTime: 0,
    isCueTriggered: () => false,
    cueProgress: () => 0,
  });

  /**
   * Main component: Consumes timeline + audio, provides context.
   *
   * Props:
   *   timeline       timeline.json object (required)
   *   audioSrc       Path to voiceover.mp3 (required)
   *   width/height   Stage dimensions, default 1920x1080
   *   background     Default '#0e0e0e'
   *   controls       Whether to show the bottom playback bar, default true
   *   children       Animation content (organized with <Scene>/<Cue>)
   */
  function NarrationStage({
    timeline,
    audioSrc,
    width = 1920,
    height = 1080,
    background = '#0e0e0e',
    controls = true,
    children,
  }) {
    const audioRef = React.useRef(null);
    const [time, setTime] = React.useState(0);
    const [playing, setPlaying] = React.useState(false);
    const recording = typeof window !== 'undefined' && window.__recording === true;

    // Expose to render-video.js
    React.useEffect(() => {
      if (typeof window === 'undefined') return;
      window.__totalDuration = timeline.totalDuration;
      window.__ready = true;
    }, [timeline.totalDuration]);

    // Time tick
    React.useEffect(() => {
      let raf;
      if (recording) {
        // Seek-render (window.__seekRender injected by render-video-seek.js): freezes the self-driving clock,
        // and is advanced frame by frame by external window.__seek(t). Each frame is a deterministic seek, no rAF.
        if (typeof window !== 'undefined' && window.__seekRender) {
          window.__seek = (t) => setTime(Math.min(t, timeline.totalDuration));
          return;
        }
        // Recording mode: rAF wall-clock self-driven starting from 0
        // Compatible with render-video.js (which relies on animation naturally progressing + window.__seek for reset)
        let startedAt = null;
        const tick = (now) => {
          if (startedAt === null) startedAt = now;
          setTime(Math.min((now - startedAt) / 1000, timeline.totalDuration));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        // Expose __seek to render-video.js to call __seek(0) for reset after ready
        if (typeof window !== 'undefined') {
          window.__seek = (t) => {
            startedAt = performance.now() - t * 1000;
            setTime(t);
          };
        }
      } else {
        // Live playback mode: Follow audio.currentTime
        const tick = () => {
          if (audioRef.current && !audioRef.current.paused) {
            setTime(audioRef.current.currentTime);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      }
      return () => cancelAnimationFrame(raf);
    }, [recording, timeline.totalDuration]);

    // Current scene
    const currentScene = React.useMemo(() => {
      if (!timeline.scenes) return null;
      // Find the segment where start <= time < end. The last segment extends to its end.
      for (let i = 0; i < timeline.scenes.length; i++) {
        const s = timeline.scenes[i];
        const next = timeline.scenes[i + 1];
        if (time >= s.start && (!next || time < next.start)) return s;
      }
      return timeline.scenes[0];
    }, [time, timeline.scenes]);

    const sceneTime = currentScene ? Math.max(0, time - currentScene.start) : 0;

    // Find cue status (compare by absoluteTime, can query across scenes)
    const allCues = React.useMemo(() => {
      const map = {};
      for (const s of timeline.scenes || []) {
        for (const c of s.cues || []) {
          map[c.id] = c;
        }
      }
      return map;
    }, [timeline.scenes]);

    const isCueTriggered = React.useCallback(
      (cueId) => {
        const c = allCues[cueId];
        if (!c) return false;
        return time >= c.absoluteTime;
      },
      [allCues, time],
    );

    /** How many seconds after triggering for 0→1, stays at 1 after >1. Used for fade-in animations after a cue. */
    const cueProgress = React.useCallback(
      (cueId, ramp = 0.5) => {
        const c = allCues[cueId];
        if (!c) return 0;
        const dt = time - c.absoluteTime;
        if (dt <= 0) return 0;
        if (dt >= ramp) return 1;
        return dt / ramp;
      },
      [allCues, time],
    );

    const ctx = { time, scene: currentScene, sceneTime, isCueTriggered, cueProgress, timeline };

    // Play/pause/seek controls
    const handlePlayPause = () => {
      if (!audioRef.current) return;
      if (audioRef.current.paused) {
        audioRef.current.play();
        setPlaying(true);
      } else {
        audioRef.current.pause();
        setPlaying(false);
      }
    };

    const handleSeek = (e) => {
      if (!audioRef.current) return;
      const t = parseFloat(e.target.value);
      audioRef.current.currentTime = t;
      setTime(t);
    };

    const handleAudioEnded = () => setPlaying(false);

    return (
      <NarrationContext.Provider value={ctx}>
        <div
          style={{
            position: 'relative',
            width,
            height,
            background,
            overflow: 'hidden',
            color: '#fff',
            fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          }}
        >
          {children}
        </div>
        {!recording && (
          <audio
            ref={audioRef}
            src={audioSrc}
            preload="auto"
            onEnded={handleAudioEnded}
          />
        )}
        {!recording && controls && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              background: '#1a1a1a',
              color: '#ddd',
              fontFamily: 'monospace',
              fontSize: 13,
              width,
              boxSizing: 'border-box',
            }}
          >
            <button
              onClick={handlePlayPause}
              style={{
                padding: '6px 14px',
                background: '#fff',
                color: '#000',
                border: 0,
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <input
              type="range"
              min={0}
              max={timeline.totalDuration}
              step={0.01}
              value={time}
              onChange={handleSeek}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 110, textAlign: 'right' }}>
              {time.toFixed(2)} / {timeline.totalDuration.toFixed(2)}s
            </span>
            <span
              style={{
                padding: '4px 10px',
                background: '#2a2a2a',
                borderRadius: 4,
                minWidth: 100,
                textAlign: 'center',
              }}
            >
              {currentScene ? currentScene.id : '—'}
            </span>
          </div>
        )}
      </NarrationContext.Provider>
    );
  }

  /**
   * Scene wrapper: Renders children only when the specified scene ID is active.
   *
   * Props:
   *   id        Scene ID (corresponds to timeline.scenes[].id)
   *   children  Content to render; can be a ReactNode or (sceneTime, sceneInfo) => ReactNode
   *   keepMounted Default false. Set to true to keep mounted and only toggle visibility (use when continuous animation is needed).
   */
  function Scene({ id, children, keepMounted = false }) {
    const { scene, sceneTime } = React.useContext(NarrationContext);
    const isActive = scene && scene.id === id;
    if (!isActive && !keepMounted) return null;
    const content = typeof children === 'function' ? children(sceneTime, scene) : children;
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: isActive ? 1 : 0,
          pointerEvents: isActive ? 'auto' : 'none',
          transition: keepMounted ? 'opacity 0.2s' : undefined,
        }}
      >
        {content}
      </div>
    );
  }

  /**
   * Cue wrapper: Listens for cue trigger status.
   *
   * Props:
   *   id        Cue ID (corresponds to timeline.scenes[].cues[].id)
   *   ramp      Ramp duration (seconds) for progress 0→1 after cue triggers, default 0.5
   *   children  Must be a function: (triggered: bool, progress: 0-1) => ReactNode
   */
  function Cue({ id, ramp = 0.5, children }) {
    const { isCueTriggered, cueProgress } = React.useContext(NarrationContext);
    const triggered = isCueTriggered(id);
    const progress = cueProgress(id, ramp);
    return children(triggered, progress);
  }

  /** Hook: Directly get narration status in custom components. */
  function useNarration() {
    return React.useContext(NarrationContext);
  }

  /**
   * splitChunkToLines · Splits a text chunk into short lines (≤maxLen characters) by punctuation.
   *
   * Used for subtitle display – Bilibili standard is ≤12 characters per line for readability. This function:
   * 1. First splits sentences by strong punctuation (. ! ? \n), never breaking across a period.
   * 2. Sentences ≤ maxLen are used directly; otherwise, they are split by weak punctuation (, 、 ; :) and merged.
   * 3. Mixed Chinese/English: English/numbers are counted as 0.5 characters for visual width.
   * 4. Fallback hard cut (rare: a single punctuation segment exceeds maxLen).
   *
   * @param text   Original text
   * @param maxLen Maximum visual length per line, default 13 (≈12 chars + one punctuation)
   * @returns Array of split subtitle lines
   */
  function visualLen(s) {
    let n = 0;
    for (const ch of s) n += /[a-zA-Z0-9 .,'":;\-]/.test(ch) ? 0.5 : 1;
    return n;
  }
  function splitChunkToLines(text, maxLen = 13) {
    const lines = [];
    const sentences = [];
    let buf = '';
    for (const ch of text) {
      buf += ch;
      if ('。！？\n'.includes(ch)) { if (buf.trim()) sentences.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) sentences.push(buf.trim());
    for (const sent of sentences) {
      if (visualLen(sent) <= maxLen) { lines.push(sent); continue; }
      const parts = [];
      let pbuf = '';
      for (const ch of sent) {
        pbuf += ch;
        if ('，、；：'.includes(ch)) { parts.push(pbuf); pbuf = ''; }
      }
      if (pbuf) parts.push(pbuf);
      let merged = '';
      for (const p of parts) {
        if (visualLen(merged) + visualLen(p) <= maxLen) merged += p;
        else { if (merged) lines.push(merged); merged = p; }
      }
      if (merged) {
        if (visualLen(merged) <= maxLen) lines.push(merged);
        else {
          let hbuf = '';
          for (const ch of merged) { hbuf += ch; if (visualLen(hbuf) >= maxLen) { lines.push(hbuf); hbuf = ''; } }
          if (hbuf) lines.push(hbuf);
        }
      }
    }
    return lines.filter(l => l.trim());
  }

  /**
   * Subtitles · Bilibili-style subtitle component (white halo, dark text, no background, displayed according to chunk times)
   *
   * Automatically takes the active chunk from current scene.chunks, splits it into short lines using splitChunkToLines,
   * and allocates the chunk's time window to each line based on character count proportion for display.
   *
   * Required: timeline.scenes[].chunks[] (narrate-pipeline.mjs outputs this by default)
   *
   * Props (can override default styles):
   *   bottom    Pixels from bottom, default 90 (not flush with edge)
   *   fontSize  Font size, default 32
   *   color     Text color, default dark ink #1a1a1a (suitable for light paper-white background)
   *   haloColor Halo color, default rgba(245,241,232,0.9) (suitable for #f5f1e8 background)
   *   maxLen    Maximum visual length per line, default 13
   *
   * For dark background scenes: Change color to '#fff' and haloColor to 'rgba(0,0,0,0.85)'.
   */
  function Subtitles({ bottom = 90, fontSize = 32, color = '#1a1a1a', haloColor = 'rgba(245,241,232,0.9)', maxLen = 13 } = {}) {
    const { time, scene } = React.useContext(NarrationContext);
    if (!scene || !scene.chunks) return null;
    const active = scene.chunks.find(c => time >= c.absoluteStart && time < c.absoluteEnd);
    if (!active) return null;
    const lines = splitChunkToLines(active.text, maxLen);
    if (lines.length === 0) return null;
    const totalLen = lines.reduce((s, l) => s + visualLen(l), 0);
    const chunkDur = active.absoluteEnd - active.absoluteStart;
    let acc = active.absoluteStart;
    let activeLine = lines[lines.length - 1];
    let lineStart = active.absoluteStart;
    for (const line of lines) {
      const dur = (visualLen(line) / totalLen) * chunkDur;
      if (time < acc + dur) { activeLine = line; lineStart = acc; break; }
      acc += dur;
    }
    const lineProg = Math.min(1, (time - lineStart) / 0.15);
    return React.createElement('div', {
      style: { position: 'absolute', left: 0, right: 0, bottom, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 50 },
    }, React.createElement('div', {
      key: lineStart,
      style: {
        fontFamily: '"PingFang SC", "Noto Sans SC", -apple-system, sans-serif',
        fontSize, fontWeight: 600, color,
        letterSpacing: '0.04em', lineHeight: 1.2, textAlign: 'center',
        textShadow: `0 0 6px ${haloColor}, 0 0 12px ${haloColor}, 0 1px 2px rgba(255,255,255,0.5)`,
        opacity: lineProg, transform: `translateY(${(1 - lineProg) * 4}px)`,
      },
    }, activeLine));
  }

  /**
   * useSceneFade · Helper for soft fade-in/fade-out of auxiliary elements within a scene.
   *
   * Iron Rule #2 requires no hard cuts between scenes – but auxiliary elements within a scene (data cards, reference blocks)
   * will by default remain visible from cue trigger until the end of the scene. If they don't fade out, these elements
   * will abruptly appear or disappear when transitioning to the next segment. This hook provides a unified soft transition
   * of [fade-in on entry → hold → fade-out on exit].
   *
   * Usage (multiply `op` into the auxiliary element's opacity):
   *   const op = useSceneFade('md-side', 0.6, 0.8);  // Fade in for 0.6s, fade out for 0.8s
   *   <Cue id="agents-md">{(t, p) => (
   *     <div style={{ opacity: op * p }}>...</div>
   *   )}</Cue>
   *
   * This way, the data card fades in within 0.6s from the start of the 'md-side' segment, and starts fading out 0.8s
   * before the segment ends, creating an overlap with the fade-in of auxiliary elements in the next segment,
   * preventing hard cuts in the visual.
   *
   * @param sceneId  Scene ID
   * @param fadeIn   Fade-in duration in seconds (default 0.5)
   * @param fadeOut  Fade-out duration in seconds (default 0.5)
   * @returns Opacity multiplier between 0-1
   */
  function useSceneFade(sceneId, fadeIn = 0.5, fadeOut = 0.5) {
    const { time, timeline } = React.useContext(NarrationContext);
    if (!timeline) return 0;
    const s = timeline.scenes.find(x => x.id === sceneId);
    if (!s) return 0;
    const inT = (time - s.start) / fadeIn;
    const outT = (s.end - time) / fadeOut;
    const v = Math.min(1, Math.min(inT, outT));
    return Math.max(0, v);
  }

  return { NarrationStage, Scene, Cue, useNarration, useSceneFade, Subtitles, splitChunkToLines };
})();

if (typeof window !== 'undefined') {
  Object.assign(window, { NarrationStageLib });
}