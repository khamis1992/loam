'use client';

import { useMemo } from 'react';

/**
 * Grok Bot-style agent avatar: a colored geometric shape with a centered
 * monogram, or a custom image. Original geometry and animation curves.
 */

/** The 8 supported shape tokens (mirrors AVATAR_SHAPES in src/server/agents.ts). */
export const AVATAR_SHAPES = [
  'squircle',
  'teardrop',
  'pebble',
  'hex',
  'blob',
  'cloud',
  'wedge',
  'tablet',
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** The 10 named color tokens (mirrors AVATAR_COLORS in src/server/agents.ts). */
export const AVATAR_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'brown',
  'gray',
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** Vivid, tasteful hex per token; `ink` keeps the monogram readable. */
const PALETTE: Record<AvatarColor, { base: string; ink: string }> = {
  red: { base: '#e5484d', ink: '#ffffff' },
  orange: { base: '#f76b15', ink: '#ffffff' },
  yellow: { base: '#ffc53d', ink: '#4a3200' },
  green: { base: '#30a46c', ink: '#ffffff' },
  cyan: { base: '#12a594', ink: '#ffffff' },
  blue: { base: '#0090ff', ink: '#ffffff' },
  violet: { base: '#6e56cf', ink: '#ffffff' },
  magenta: { base: '#d6409f', ink: '#ffffff' },
  brown: { base: '#ad7f58', ink: '#ffffff' },
  gray: { base: '#6e6f77', ink: '#ffffff' },
};

/** Original geometry per shape, drawn in a 64x64 viewBox. */
const SHAPE_PATHS: Record<AvatarShape, React.ReactNode> = {
  squircle: (
    <path d="M32 2 C52 2 62 12 62 32 C62 52 52 62 32 62 C12 62 2 52 2 32 C2 12 12 2 32 2 Z" />
  ),
  teardrop: (
    <path d="M32 2 C45 15 58 26 58 40 C58 53.25 46.25 62 32 62 C17.75 62 6 53.25 6 40 C6 26 19 15 32 2 Z" />
  ),
  pebble: (
    <path d="M33 3 C49 2 60 13 61 30 C62 47 51 61 33 61 C16 61 3 50 3 32 C3 15 17 4 33 3 Z" />
  ),
  hex: (
    <path
      d="M58 32 L45 54.5 L19 54.5 L6 32 L19 9.5 L45 9.5 Z"
      strokeWidth={9}
      strokeLinejoin="round"
    />
  ),
  blob: (
    <path d="M41 3 C55 5 63 18 61 33 C59 49 49 61 32 61 C16 61 3 53 3 38 C3 24 8 13 19 7 C26 3.5 34 2 41 3 Z" />
  ),
  cloud: (
    <path d="M13 51 C7 51 3 46 3 40 C3 34 8 30 13 30 C13 19 21 11 32 11 C42 11 50 18 50 28 C56 28 61 33 61 40 C61 46 57 51 51 51 Z" />
  ),
  wedge: (
    <path d="M7 13 C7 9 11 7 15 9 L54 29 C58 31 58 33 54 35 L15 55 C11 57 7 55 7 51 Z" />
  ),
  tablet: (
    <path d="M20 2 L44 2 C51.7 2 58 8.3 58 16 L58 48 C58 55.7 51.7 62 44 62 L20 62 C12.3 62 6 55.7 6 48 L6 16 C6 8.3 12.3 2 20 2 Z" />
  ),
};

interface AgentAvatarProps {
  name: string;
  avatarShape?: string;
  avatarColor?: string;
  avatarImage?: string;
  /** Rendered edge length in px (default 32). */
  size?: number;
  selected?: boolean;
  /** Animated pulsing status dot (agent is working/thinking). */
  working?: boolean;
  /** Subtle breathing/shimmer on the avatar itself (agent is typing). */
  typing?: boolean;
}

/** FNV-1a 32-bit string hash — stable default derivation from the name. */
function hashString(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** First grapheme of the name (Intl.Segmenter when available, code point fallback). */
function firstGrapheme(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  try {
    const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    if (Seg) {
      const segments = new Seg('und', { granularity: 'grapheme' }).segment(trimmed);
      const first = segments[Symbol.iterator]().next();
      if (!first.done) return first.value.segment;
    }
  } catch {
    // fall through to code point handling
  }
  return Array.from(trimmed)[0] ?? '?';
}

function isValidImage(value?: string): value is string {
  if (!value) return false;
  return value.startsWith('data:image/') || value.startsWith('/api/');
}

export function AgentAvatar({
  name,
  avatarShape,
  avatarColor,
  avatarImage,
  size = 32,
  selected = false,
  working = false,
  typing = false,
}: AgentAvatarProps) {
  const resolved = useMemo(() => {
    const shape: AvatarShape = (AVATAR_SHAPES as readonly string[]).includes(avatarShape ?? '')
      ? (avatarShape as AvatarShape)
      : AVATAR_SHAPES[hashString(name) % AVATAR_SHAPES.length];
    const color: AvatarColor = (AVATAR_COLORS as readonly string[]).includes(avatarColor ?? '')
      ? (avatarColor as AvatarColor)
      : AVATAR_COLORS[hashString(name, 0x9dc5811c) % AVATAR_COLORS.length];
    const image = isValidImage(avatarImage) ? avatarImage : undefined;
    const monogram = firstGrapheme(name).toLocaleUpperCase();
    return { shape, color, image, monogram };
  }, [name, avatarShape, avatarColor, avatarImage]);

  const palette = PALETTE[resolved.color];
  const dotSize = Math.max(8, Math.round(size * 0.3));
  const ringSpan = Math.max(2, Math.round(size / 16) + 1);
  const ringWidth = Math.max(1.5, Math.round(size / 22) + 0.5);

  return (
    <span
      role="img"
      aria-label={name}
      className="relative inline-flex shrink-0 items-center justify-center align-middle"
      style={{ width: size, height: size }}
    >
      {resolved.image ? (
        // Custom raster avatar replaces the shape entirely.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolved.image}
          alt=""
          draggable={false}
          className={`h-full w-full select-none object-cover ${typing ? 'agent-avatar-typing' : ''}`}
          style={{ borderRadius: Math.max(4, Math.round(size * 0.28)) }}
        />
      ) : (
        <>
          <svg
            viewBox="0 0 64 64"
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
            className={typing ? 'agent-avatar-typing' : undefined}
            style={{ display: 'block', overflow: 'visible' }}
          >
            <g fill={palette.base} stroke={palette.base}>
              {SHAPE_PATHS[resolved.shape]}
            </g>
          </svg>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center font-semibold leading-none"
            style={{
              fontSize: Math.max(9, Math.round(size * 0.42)),
              color: palette.ink,
            }}
          >
            {resolved.monogram}
          </span>
        </>
      )}

      {selected && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: -ringSpan,
            boxShadow: `0 0 0 ${ringWidth}px var(--background-gray-main), 0 0 0 ${ringWidth * 2}px ${palette.base}`,
          }}
        />
      )}

      {working && (
        <span
          aria-hidden="true"
          className="agent-avatar-dot absolute rounded-full"
          style={{
            width: dotSize,
            height: dotSize,
            right: -dotSize / 4,
            bottom: -dotSize / 4,
            backgroundColor: 'var(--activity-indicator-running)',
            boxShadow: '0 0 0 2px var(--background-gray-main)',
          }}
        />
      )}
    </span>
  );
}
