import React from 'react';
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, RADIUS, SHADOW, EASINGS, GRADIENT } from '../brand';
import { FONT_DISPLAY, FONT_BODY } from '../fonts';

export interface TranscriptWord {
  word: string;
  start: number; // in seconds
  end: number;   // in seconds
  confidence?: number;
  emoji?: string;
}

export type CaptionStyle = 'kinetic_pill' | 'cyber_glow' | 'minimal_clean' | 'bold_karaoke';

export interface KineticCaptionsProps {
  words: TranscriptWord[];
  style?: CaptionStyle;
  position?: 'bottom' | 'center' | 'top';
  chunkSize?: number; // number of words to show concurrently, default 4
  fontSize?: number;
  highlightColor?: string;
  maxCharactersPerLine?: number;
}

const EMOJI_MAP: Record<string, string> = {
  ai: '🤖',
  agent: '⚡',
  system: '⚙️',
  kod: '💻',
  code: '💻',
  sukces: '🚀',
  problem: '⚠️',
  architektura: '🏛️',
  baza: '🗄️',
  cel: '🎯',
  czas: '⏱️',
  uwaga: '💡',
};

export const KineticCaptions: React.FC<KineticCaptionsProps> = ({
  words = [],
  style = 'kinetic_pill',
  position = 'bottom',
  chunkSize = 4,
  fontSize = 54,
  highlightColor = COLORS.accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTimeSec = frame / fps;

  if (!words.length) return null;

  // Find active word index
  const activeWordIndex = words.findIndex(
    (w) => currentTimeSec >= w.start && currentTimeSec <= w.end
  );

  // If no word is currently active, find the closest upcoming word or keep previous briefly
  let currentTargetIndex = activeWordIndex;
  if (currentTargetIndex === -1) {
    const nextIndex = words.findIndex((w) => w.start > currentTimeSec);
    if (nextIndex > 0 && currentTimeSec - words[nextIndex - 1].end < 0.6) {
      currentTargetIndex = nextIndex - 1;
    } else {
      currentTargetIndex = nextIndex !== -1 ? nextIndex : words.length - 1;
    }
  }

  // Calculate chunk window around the active word
  const chunkStart = Math.max(
    0,
    Math.floor(currentTargetIndex / chunkSize) * chunkSize
  );
  const currentChunk = words.slice(chunkStart, chunkStart + chunkSize);

  if (!currentChunk.length) return null;

  // Position styles
  const positionStyle: React.CSSProperties =
    position === 'center'
      ? { top: '50%', transform: 'translate(-50%, -50%)' }
      : position === 'top'
      ? { top: 100, transform: 'translateX(-50%)' }
      : { bottom: 90, transform: 'translateX(-50%)' };

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        ...positionStyle,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        maxWidth: 1600,
        textAlign: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px 20px',
          padding: style === 'kinetic_pill' ? '18px 36px' : '8px 16px',
          backgroundColor:
            style === 'kinetic_pill'
              ? 'rgba(7, 9, 14, 0.78)'
              : style === 'cyber_glow'
              ? 'rgba(13, 17, 26, 0.60)'
              : 'transparent',
          backdropFilter: style !== 'minimal_clean' ? 'blur(12px)' : 'none',
          borderRadius: RADIUS.pill,
          border:
            style === 'kinetic_pill'
              ? `1px solid rgba(255, 255, 255, 0.12)`
              : 'none',
          boxShadow: style === 'kinetic_pill' ? SHADOW.soft : 'none',
        }}
      >
        {currentChunk.map((item, idx) => {
          const isCurrent =
            currentTimeSec >= item.start && currentTimeSec <= item.end;
          const isPast = currentTimeSec > item.end;

          const wordFrame = Math.max(0, (currentTimeSec - item.start) * fps);
          const popSpring = spring({
            frame: wordFrame,
            fps,
            config: { damping: 12, mass: 0.4, stiffness: 140 },
          });

          const scale = isCurrent
            ? interpolate(popSpring, [0, 1], [0.95, 1.12], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : 1.0;

          const wordLower = item.word.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, '');
          const matchedEmoji = item.emoji || EMOJI_MAP[wordLower];

          return (
            <span
              key={`${item.word}-${item.start}-${idx}`}
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize,
                fontWeight: isCurrent ? 800 : 600,
                color: isCurrent
                  ? highlightColor
                  : isPast
                  ? COLORS.d300
                  : COLORS.d400,
                textShadow: isCurrent
                  ? `0 0 24px ${highlightColor}88, 0 4px 12px rgba(0,0,0,0.8)`
                  : '0 2px 8px rgba(0,0,0,0.7)',
                transform: `scale(${scale})`,
                transition: 'color 0.1s ease',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                letterSpacing: '-0.5px',
                textTransform: isCurrent ? 'uppercase' : 'none',
              }}
            >
              {item.word}
              {isCurrent && matchedEmoji && (
                <span
                  style={{
                    fontSize: fontSize * 0.85,
                    transform: `scale(${interpolate(popSpring, [0, 1], [0, 1.2])})`,
                    display: 'inline-block',
                  }}
                >
                  {matchedEmoji}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
