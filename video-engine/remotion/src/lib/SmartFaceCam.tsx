import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Video,
  Img,
  staticFile,
} from 'remotion';
import { COLORS, RADIUS, SHADOW, EASINGS } from '../brand';

export type FaceCamLayout =
  | 'fullscreen'
  | 'pip_bottom_right'
  | 'pip_bottom_left'
  | 'pip_top_right'
  | 'split_left'
  | 'split_right'
  | 'floating_badge'
  | 'hidden';

export interface SmartFaceCamProps {
  src?: string;
  isImage?: boolean;
  layout?: FaceCamLayout;
  punchZoom?: number; // e.g. 1.05 or 1.15 on key phrases
  punchActive?: boolean;
  borderGlow?: string;
  showBorder?: boolean;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  customTransform?: string;
  label?: string;
}

const LAYOUT_PRESETS: Record<
  FaceCamLayout,
  {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    border: boolean;
    shadow: string;
    opacity: number;
  }
> = {
  fullscreen: {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    radius: 0,
    border: false,
    shadow: 'none',
    opacity: 1,
  },
  pip_bottom_right: {
    x: 1380,
    y: 740,
    width: 480,
    height: 270,
    radius: RADIUS.card,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  pip_bottom_left: {
    x: 60,
    y: 740,
    width: 480,
    height: 270,
    radius: RADIUS.card,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  pip_top_right: {
    x: 1380,
    y: 70,
    width: 480,
    height: 270,
    radius: RADIUS.card,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  split_left: {
    x: 60,
    y: 60,
    width: 860,
    height: 960,
    radius: RADIUS.card,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  split_right: {
    x: 1000,
    y: 60,
    width: 860,
    height: 960,
    radius: RADIUS.card,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  floating_badge: {
    x: 1540,
    y: 700,
    width: 320,
    height: 320,
    radius: RADIUS.pill,
    border: true,
    shadow: SHADOW.card,
    opacity: 1,
  },
  hidden: {
    x: 1380,
    y: 1200,
    width: 480,
    height: 270,
    radius: RADIUS.card,
    border: true,
    shadow: 'none',
    opacity: 0,
  },
};

export const SmartFaceCam: React.FC<SmartFaceCamProps> = ({
  src,
  isImage = false,
  layout = 'fullscreen',
  punchZoom = 1.0,
  punchActive = false,
  borderGlow = COLORS.accent,
  showBorder = true,
  customTransform = '',
  label,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const anim = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.5, stiffness: 100 },
  });

  const preset = LAYOUT_PRESETS[layout] || LAYOUT_PRESETS.fullscreen;

  // Punch-in zoom interpolator
  const zoomFactor = punchActive
    ? interpolate(anim, [0, 1], [1.0, punchZoom], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : punchZoom;

  const resolvedBorder = preset.border && showBorder
    ? `2px solid ${borderGlow}`
    : 'none';

  const glowShadow = preset.border && showBorder
    ? `0 0 24px ${borderGlow}33, ${preset.shadow}`
    : preset.shadow;

  return (
    <div
      style={{
        position: 'absolute',
        left: preset.x,
        top: preset.y,
        width: preset.width,
        height: preset.height,
        borderRadius: preset.radius,
        opacity: preset.opacity,
        overflow: 'hidden',
        boxShadow: glowShadow,
        border: resolvedBorder,
        zIndex: layout === 'fullscreen' ? 1 : 20,
        transform: `scale(${zoomFactor}) ${customTransform}`,
        transformOrigin: 'center center',
        backgroundColor: COLORS.ink,
      }}
    >
      {src ? (
        isImage ? (
          <Img
            src={src.startsWith('http') ? src : staticFile(src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <Video
            src={src.startsWith('http') ? src : staticFile(src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: `radial-gradient(circle at center, ${COLORS.d800} 0%, ${COLORS.ink} 100%)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.d400,
            fontSize: 24,
            fontWeight: 600,
          }}
        >
          {label || 'Camera Feed'}
        </div>
      )}

      {/* Optional speaker tag / lower badge when in PiP or Split mode */}
      {label && layout !== 'fullscreen' && layout !== 'hidden' && (
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            background: 'rgba(7, 9, 14, 0.85)',
            backdropFilter: 'blur(8px)',
            border: `1px solid ${COLORS.line}`,
            borderRadius: RADIUS.panel,
            padding: '4px 12px',
            color: COLORS.d300,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.5px',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
};
