import React from 'react';
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  CheckCircle2,
  Sparkles,
  Zap,
  ArrowRight,
  TrendingUp,
  ShieldCheck,
  Code2,
} from 'lucide-react';
import { COLORS, RADIUS, SHADOW, EASINGS, GRADIENT } from '../brand';
import { FONT_DISPLAY, FONT_BODY, FONT_MONO } from '../fonts';

// ── 1. Lower Third (Speaker Info / Topic Card) ──
export interface LowerThirdProps {
  name: string;
  role?: string;
  avatarUrl?: string;
  startFrame?: number;
  durationInFrames?: number;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  name,
  role,
  avatarUrl,
  startFrame = 15,
  durationInFrames = 150,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enterFrame = Math.max(0, frame - startFrame);
  const exitFrame = Math.max(0, frame - (startFrame + durationInFrames - 20));

  const enterSpring = spring({
    frame: enterFrame,
    fps,
    config: { damping: 14, mass: 0.5, stiffness: 120 },
  });

  const exitProgress = interpolate(exitFrame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASINGS.easeIn,
  });

  const translateX = interpolate(enterSpring, [0, 1], [-400, 0]) - exitProgress * 400;
  const opacity = interpolate(enterSpring, [0, 1], [0, 1]) * (1 - exitProgress);

  if (frame < startFrame || opacity <= 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 90,
        left: 80,
        zIndex: 40,
        transform: `translateX(${translateX}px)`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        background: 'rgba(13, 17, 26, 0.88)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${COLORS.d700}`,
        borderLeft: `4px solid ${COLORS.accent}`,
        borderRadius: RADIUS.card,
        padding: '16px 28px',
        boxShadow: SHADOW.card,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 28,
            fontWeight: 700,
            color: COLORS.d300,
            letterSpacing: '-0.3px',
          }}
        >
          {name}
        </span>
        {role && (
          <span
            style={{
              fontFamily: FONT_BODY,
              fontSize: 18,
              fontWeight: 500,
              color: COLORS.accent,
              marginTop: 4,
            }}
          >
            {role}
          </span>
        )}
      </div>
    </div>
  );
};

// ── 2. Notification Toast (System Actions & Delegations) ──
export interface NotificationToastProps {
  title: string;
  message?: string;
  iconType?: 'check' | 'sparkles' | 'zap' | 'shield' | 'code';
  startFrame?: number;
  durationInFrames?: number;
  position?: 'top_right' | 'top_left' | 'bottom_right';
}

export const NotificationToast: React.FC<NotificationToastProps> = ({
  title,
  message,
  iconType = 'check',
  startFrame = 10,
  durationInFrames = 120,
  position = 'top_right',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enterFrame = Math.max(0, frame - startFrame);
  const exitFrame = Math.max(0, frame - (startFrame + durationInFrames - 15));

  const enterSpring = spring({
    frame: enterFrame,
    fps,
    config: { damping: 15, mass: 0.5, stiffness: 120 },
  });

  const exitOpacity = interpolate(exitFrame, [0, 15], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const translateY = interpolate(enterSpring, [0, 1], [-50, 0]);
  const opacity = interpolate(enterSpring, [0, 1], [0, 1]) * exitOpacity;

  if (frame < startFrame || opacity <= 0) return null;

  const posStyle: React.CSSProperties =
    position === 'top_right'
      ? { top: 60, right: 60 }
      : position === 'top_left'
      ? { top: 60, left: 60 }
      : { bottom: 60, right: 60 };

  const renderIcon = () => {
    const size = 22;
    switch (iconType) {
      case 'sparkles':
        return <Sparkles size={size} color={COLORS.warn} />;
      case 'zap':
        return <Zap size={size} color={COLORS.accent} />;
      case 'shield':
        return <ShieldCheck size={size} color={COLORS.accent2} />;
      case 'code':
        return <Code2 size={size} color={COLORS.signal} />;
      default:
        return <CheckCircle2 size={size} color={COLORS.accent} />;
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        ...posStyle,
        zIndex: 45,
        transform: `translateY(${translateY}px)`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'rgba(21, 28, 40, 0.92)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${COLORS.d700}`,
        borderRadius: RADIUS.panel,
        padding: '14px 22px',
        boxShadow: SHADOW.card,
        maxWidth: 480,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          borderRadius: 8,
          backgroundColor: 'rgba(255,255,255,0.06)',
        }}
      >
        {renderIcon()}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 18,
            fontWeight: 600,
            color: COLORS.d300,
          }}
        >
          {title}
        </span>
        {message && (
          <span
            style={{
              fontFamily: FONT_BODY,
              fontSize: 14,
              color: COLORS.d400,
              marginTop: 2,
            }}
          >
            {message}
          </span>
        )}
      </div>
    </div>
  );
};

// ── 3. Animated Stat Counter ──
export interface StatCounterProps {
  value: number;
  suffix?: string;
  prefix?: string;
  label: string;
  startFrame?: number;
  durationFrames?: number;
}

export const StatCounter: React.FC<StatCounterProps> = ({
  value,
  suffix = '',
  prefix = '',
  label,
  startFrame = 10,
  durationFrames = 45,
}) => {
  const frame = useCurrentFrame();
  const progressFrame = Math.max(0, frame - startFrame);

  const currentVal = interpolate(progressFrame, [0, durationFrames], [0, value], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASINGS.easeOut,
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '28px 42px',
        background: 'rgba(13, 17, 26, 0.75)',
        backdropFilter: 'blur(12px)',
        border: `1px solid ${COLORS.d700}`,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.soft,
      }}
    >
      <span
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 64,
          fontWeight: 800,
          color: COLORS.accent,
          textShadow: `0 0 30px ${COLORS.accent}44`,
          letterSpacing: '-1px',
        }}
      >
        {prefix}
        {Math.round(currentVal)}
        {suffix}
      </span>
      <span
        style={{
          fontFamily: FONT_BODY,
          fontSize: 20,
          fontWeight: 600,
          color: COLORS.d400,
          marginTop: 8,
          textTransform: 'uppercase',
          letterSpacing: '1px',
        }}
      >
        {label}
      </span>
    </div>
  );
};
