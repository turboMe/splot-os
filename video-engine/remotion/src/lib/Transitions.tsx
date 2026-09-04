import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, EASINGS } from '../brand';

export interface TransitionProps {
  children: React.ReactNode;
  type?: 'whip_left' | 'whip_right' | 'zoom_in' | 'spring_up' | 'glow_fade';
  enterFrame?: number;
  enterDuration?: number;
}

export const ModernTransition: React.FC<TransitionProps> = ({
  children,
  type = 'spring_up',
  enterFrame = 0,
  enterDuration = 20,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progressFrame = Math.max(0, frame - enterFrame);

  const anim = spring({
    frame: progressFrame,
    fps,
    config: { damping: 15, mass: 0.5, stiffness: 120 },
  });

  let transform = 'none';
  let opacity = 1;

  if (type === 'whip_left') {
    const x = interpolate(anim, [0, 1], [-1920, 0]);
    transform = `translateX(${x}px)`;
    opacity = interpolate(anim, [0, 0.4], [0, 1], { extrapolateRight: 'clamp' });
  } else if (type === 'whip_right') {
    const x = interpolate(anim, [0, 1], [1920, 0]);
    transform = `translateX(${x}px)`;
    opacity = interpolate(anim, [0, 0.4], [0, 1], { extrapolateRight: 'clamp' });
  } else if (type === 'zoom_in') {
    const scale = interpolate(anim, [0, 1], [0.8, 1]);
    transform = `scale(${scale})`;
    opacity = interpolate(anim, [0, 0.5], [0, 1], { extrapolateRight: 'clamp' });
  } else if (type === 'spring_up') {
    const y = interpolate(anim, [0, 1], [100, 0]);
    transform = `translateY(${y}px)`;
    opacity = interpolate(anim, [0, 0.5], [0, 1], { extrapolateRight: 'clamp' });
  } else if (type === 'glow_fade') {
    opacity = interpolate(anim, [0, 1], [0, 1], { extrapolateRight: 'clamp' });
  }

  return (
    <AbsoluteFill
      style={{
        transform,
        opacity,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const CyberBackdrop: React.FC<{
  glowColor?: string;
  gridOpacity?: number;
}> = ({ glowColor = COLORS.accent, gridOpacity = 0.25 }) => {
  const frame = useCurrentFrame();

  // Gentle breathing glow
  const breathe = Math.sin(frame / 40) * 0.05 + 0.95;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: 'hidden' }}>
      {/* Radial neon glow */}
      <div
        style={{
          position: 'absolute',
          top: '-20%',
          left: '50%',
          transform: `translateX(-50%) scale(${breathe})`,
          width: 1600,
          height: 900,
          background: `radial-gradient(circle, ${glowColor}18 0%, transparent 65%)`,
          pointerEvents: 'none',
        }}
      />
      {/* Secondary accent glow at bottom right */}
      <div
        style={{
          position: 'absolute',
          bottom: '-25%',
          right: '-10%',
          width: 1200,
          height: 800,
          background: `radial-gradient(circle, ${COLORS.accent2}14 0%, transparent 60%)`,
          pointerEvents: 'none',
        }}
      />
      {/* Subtle dotted matrix grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(${COLORS.line} 1.5px, transparent 1.5px)`,
          backgroundSize: '48px 48px',
          opacity: gridOpacity,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
