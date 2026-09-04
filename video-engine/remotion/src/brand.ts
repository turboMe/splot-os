import { Easing } from 'remotion';

// Channel identity for SPLOT OS & Agentic AI
export const BRAND = {
  wordmark: ['SPLOT', 'OS', ''] as readonly string[],
  tagline: 'Local-First Autonomous Agent Operating System',
  signoff: 'Budujmy systemy, które działają.',
} as const;

export const COLORS = {
  // SPLOT OS Signature Roles
  accent: '#00E599',       // Cyber Emerald / Matrix Mint — primary accent, agents active, success
  accent2: '#3B82F6',      // Electric Cobalt — architecture, mastra core, workflow logic
  signal: '#8B5CF6',       // Deep Violet — deliberation, subagents, semantic memory
  warn: '#F59E0B',         // Solar Amber — approval gates, alerts
  danger: '#EF4444',       // Crimson Pulse — errors, rollbacks
  
  // Surfaces & Dark Shell (Obsidian)
  ink: '#07090E',          // deep dark background
  d900: '#0D111A',         // terminal / editor base
  d800: '#151C28',         // card panels & containers
  d700: '#1F293D',         // borders & subtle dividers
  d600: '#334155',         // inactive grid lines
  d400: '#94A3B8',         // secondary text
  d300: '#F8FAFC',         // primary crisp text
  
  // Light surfaces (if needed for high-contrast cards)
  paper: '#0F172A',
  cream: '#1E293B',
  line: '#334155',
  muted: '#94A3B8',
} as const;

// Signature Cybernetic Gradient
export const GRADIENT = `linear-gradient(135deg, ${COLORS.accent} 0%, ${COLORS.accent2} 50%, ${COLORS.signal} 100%)`;
export const GRADIENT_PANEL = `linear-gradient(180deg, rgba(21, 28, 40, 0.85) 0%, rgba(13, 17, 26, 0.95) 100%)`;

export const RADIUS = { card: 12, panel: 10, window: 8, pill: 999 } as const;

export const SHADOW = {
  soft: '0 8px 32px rgba(0, 0, 0, 0.40)',
  card: '0 12px 36px rgba(0, 0, 0, 0.50)',
  glowEmerald: '0 0 30px rgba(0, 229, 153, 0.20)',
  glowCobalt: '0 0 30px rgba(59, 130, 246, 0.20)',
} as const;

export const EASINGS = {
  easeOut: Easing.bezier(0.16, 1, 0.3, 1),
  easeIn: Easing.bezier(0.32, 0, 0.67, 0),
  easeInOut: Easing.bezier(0.37, 0, 0.63, 1),
  overshoot: Easing.bezier(0.34, 1.25, 0.64, 1),
} as const;

