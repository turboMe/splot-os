import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Terminal, Cpu, Bot, CheckCircle2, ArrowRight, ShieldCheck, Database, Layers } from 'lucide-react';
import { COLORS, EASINGS, RADIUS, SHADOW, GRADIENT } from '../brand';
import { FONT_DISPLAY, FONT_BODY, FONT_MONO } from '../fonts';

export const CLAMP = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };

// ---- SPLOT OS Brand Dark Backdrop (Obsidian Grid + Neon Ambient Glow) ----
export const SplotBackdrop: React.FC<{ glowColor?: string; showGrid?: boolean }> = ({
  glowColor = COLORS.accent,
  showGrid = true,
}) => (
  <>
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }} />
    <AbsoluteFill
      style={{
        background: `radial-gradient(1400px 800px at 50% -10%, ${glowColor}18, transparent 65%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(900px 500px at 80% 90%, ${COLORS.accent2}12, transparent 60%)`,
      }}
    />
    {showGrid && (
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${COLORS.d700} 1.2px, transparent 1.2px)`,
          backgroundSize: '40px 40px',
          opacity: 0.35,
        }}
      />
    )}
  </>
);

// ---- SPLOT OS Terminal Execution Beat ----
export const SplotTerminalShot: React.FC<{
  command: string;
  agentName?: string;
  logs?: string[];
  outputTitle?: string;
  typeStart?: number;
}> = ({
  command,
  agentName = 'metaAgent',
  logs = [
    '→ Intent analyzed: Video Post-Production & Remotion Render',
    '✓ Delegated to filmmakerAgent (PID: 4092)',
    '✓ Audio stems normalized: -14 LUFS',
    '✓ Remotion TSX beats compiled successfully',
  ],
  outputTitle = 'EXECUTION LEDGER',
  typeStart = 15,
}) => {
  const frame = useCurrentFrame();
  const r = (a: number, b: number, from = 0, to = 1, easing = EASINGS.easeOut) =>
    interpolate(frame, [a, b], [from, to], { ...CLAMP, easing });

  const appear = r(0, 14);
  const typeEnd = typeStart + command.length * 1.2;
  const typed = command.slice(0, Math.floor(r(typeStart, typeEnd, 0, command.length, EASINGS.easeInOut)));
  const cursorOn = Math.floor(frame / 12) % 2 === 0;
  const executionStart = typeEnd + 10;

  return (
    <AbsoluteFill style={{ fontFamily: FONT_BODY }}>
      <SplotBackdrop glowColor={COLORS.accent} />

      {/* Top Header */}
      <div
        style={{
          position: 'absolute',
          top: 50,
          left: 80,
          right: 80,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          opacity: appear,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: COLORS.d800,
              border: `1px solid ${COLORS.d700}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Cpu size={26} color={COLORS.accent} />
          </div>
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 32, color: COLORS.d300, letterSpacing: '-0.02em' }}>
              SPLOT <span style={{ color: COLORS.accent }}>OS</span>
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: COLORS.d400 }}>
              Agentic Operating System / Runtime
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: `${COLORS.accent}15`,
            border: `1px solid ${COLORS.accent}40`,
            padding: '8px 18px',
            borderRadius: RADIUS.pill,
          }}
        >
          <Bot size={20} color={COLORS.accent} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.accent, fontWeight: 600 }}>
            Active Orchestrator: {agentName}
          </span>
        </div>
      </div>

      {/* Main Terminal Window */}
      <div
        style={{
          position: 'absolute',
          top: 170,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 1400,
          background: COLORS.d900,
          border: `1px solid ${COLORS.d700}`,
          borderRadius: RADIUS.card,
          boxShadow: SHADOW.cardDark,
          overflow: 'hidden',
          opacity: appear,
        }}
      >
        {/* Titlebar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            background: COLORS.d800,
            borderBottom: `1px solid ${COLORS.d700}`,
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#EF4444' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#F59E0B' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#10B981' }} />
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.d400, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={18} /> splot-runtime://supervisor/ledger
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: COLORS.accent }}>
            60 FPS ACTIVE
          </div>
        </div>

        {/* Console Body */}
        <div style={{ padding: '32px 36px', minHeight: 480 }}>
          {/* Command Prompt */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
            <span style={{ color: COLORS.accent, fontFamily: FONT_MONO, fontSize: 30, fontWeight: 700 }}>λ</span>
            <span style={{ color: COLORS.d300, fontFamily: FONT_MONO, fontSize: 28, fontWeight: 500 }}>
              {typed}
              <span style={{ opacity: cursorOn ? 1 : 0, color: COLORS.accent }}>▌</span>
            </span>
          </div>

          {/* Logs Output */}
          {frame >= executionStart && (
            <div style={{ marginTop: 24, borderTop: `1px dashed ${COLORS.d700}`, paddingTop: 24 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.d400, marginBottom: 16, letterSpacing: '0.05em' }}>
                {outputTitle}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {logs.map((log, i) => {
                  const logStart = executionStart + 6 + i * 8;
                  const logOp = r(logStart, logStart + 8);
                  return (
                    <div
                      key={i}
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 22,
                        color: log.startsWith('✓') ? COLORS.accent : COLORS.d300,
                        opacity: logOp,
                        transform: `translateY(${r(logStart, logStart + 8, 12, 0)}px)`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      {log}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- SPLOT OS Agent Delegation Flowchart / Architecture Beat ----
export const SplotAgentGraphShot: React.FC<{
  title?: string;
  agents?: { name: string; role: string; tool: string }[];
}> = ({
  title = 'Multi-Agent Delegation Architecture',
  agents = [
    { name: 'metaAgent', role: 'Intent & Dispatch', tool: 'Routing Gateway' },
    { name: 'filmmakerAgent', role: 'Cut & Composition', tool: 'cuts.json / RNNoise' },
    { name: 'codingAgent', role: 'Remotion TSX Code', tool: 'Remotion 4K Engine' },
    { name: 'marketingAgent', role: 'SEO & Thumbnails', tool: 'GPT Image 2 / YouTube' },
  ],
}) => {
  const frame = useCurrentFrame();
  const r = (a: number, b: number, from = 0, to = 1, easing = EASINGS.easeOut) =>
    interpolate(frame, [a, b], [from, to], { ...CLAMP, easing });

  return (
    <AbsoluteFill style={{ fontFamily: FONT_BODY }}>
      <SplotBackdrop glowColor={COLORS.accent2} />

      <div style={{ position: 'absolute', top: 60, left: 80, right: 80, textAlign: 'center', opacity: r(0, 14) }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 700, color: COLORS.d300, marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontFamily: FONT_BODY, fontSize: 22, color: COLORS.d400 }}>
          Mastra Orchestration • Deterministic Execution • Approval Gates
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 220,
          left: 100,
          right: 100,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 24,
        }}
      >
        {agents.map((agent, i) => {
          const cardStart = 12 + i * 10;
          const op = r(cardStart, cardStart + 14);
          const y = r(cardStart, cardStart + 14, 30, 0);

          return (
            <div
              key={i}
              style={{
                background: COLORS.d900,
                border: `1px solid ${i === 0 ? COLORS.accent : COLORS.d700}`,
                borderRadius: RADIUS.card,
                padding: '32px 24px',
                opacity: op,
                transform: `translateY(${y}px)`,
                boxShadow: SHADOW.cardDark,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                height: 380,
              }}
            >
              <div>
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 12,
                    background: i === 0 ? `${COLORS.accent}20` : `${COLORS.accent2}20`,
                    border: `1px solid ${i === 0 ? COLORS.accent : COLORS.accent2}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 20,
                  }}
                >
                  <Bot size={28} color={i === 0 ? COLORS.accent : COLORS.accent2} />
                </div>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 26, color: COLORS.d300, marginBottom: 8 }}>
                  {agent.name}
                </div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 18, color: COLORS.d400, marginBottom: 16 }}>
                  {agent.role}
                </div>
              </div>

              <div
                style={{
                  background: COLORS.d800,
                  border: `1px solid ${COLORS.d700}`,
                  borderRadius: RADIUS.window,
                  padding: '12px 16px',
                  fontFamily: FONT_MONO,
                  fontSize: 16,
                  color: COLORS.accent,
                }}
              >
                ⚙ {agent.tool}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
