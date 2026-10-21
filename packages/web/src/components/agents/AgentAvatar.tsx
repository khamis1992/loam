'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Grok Bot-style agent avatar: a compact, vivid, rounded colored mark with a
 * centered monogram, or a custom image.
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

/**
 * Shared stroke width. Every silhouette is filled and stroked in its own color
 * with round joins, which rounds the corners without changing the silhouette's
 * weight, so all 8 marks stay crisp at 28-32px.
 */
const SHAPE_STROKE = 3;

/** Softened geometry per shape, drawn in a 64x64 viewBox. */
const SHAPE_PATHS: Record<AvatarShape, React.ReactNode> = {
  squircle: (
    <path d="M32 3 C47 3 61 17 61 32 C61 47 47 61 32 61 C17 61 3 47 3 32 C3 17 17 3 32 3 Z" />
  ),
  teardrop: (
    <path d="M32 4 C44 15 57 26 57 39 C57 52 45.5 60 32 60 C18.5 60 7 52 7 39 C7 26 20 15 32 4 Z" />
  ),
  pebble: (
    <path d="M33 4 C49 3 59 14 60 30 C61 47 50 60 33 60 C16 60 4 49 4 32 C4 16 17 5 33 4 Z" />
  ),
  hex: (
    <path
      d="M58 32 L45 54.5 L19 54.5 L6 32 L19 9.5 L45 9.5 Z"
      strokeWidth={6}
    />
  ),
  blob: (
    <path d="M41 4 C54 6 62 18 60 33 C58 49 48 60 32 60 C16 60 4 52 4 37 C4 23 9 12 20 6.5 C27 3.5 34 3.5 41 4 Z" />
  ),
  cloud: (
    <path d="M14 50 C8 50 4 46 4 40 C4 35 8 31 13 30.5 C14 20 22 12 32 12 C42 12 50 19 50.5 28.5 C56 29 60 33.5 60 40 C60 46 56 50 50 50 Z" />
  ),
  wedge: (
    <path d="M8 14 C8 11 10.5 9 13.5 10.5 L53 28.5 C57 30.5 57 33.5 53 35.5 L13.5 53.5 C10.5 55 8 53 8 50 Z" />
  ),
  tablet: (
    <path d="M22 3 L42 3 C50.84 3 58 11.84 58 19 L58 45 C58 52.16 50.84 61 42 61 L22 61 C13.16 61 6 52.16 6 45 L6 19 C6 11.84 13.16 3 22 3 Z" />
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

/**
 * Tracks the user's reduced-motion preference so animated states render
 * statically. Starts as `false` (no hydration mismatch) and syncs after mount.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
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
  const reducedMotion = usePrefersReducedMotion();
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
  const ringSpan = Math.max(3, Math.round(size / 16) + 1);
  // Monogram size expressed in 64-unit viewBox space so it scales with `size`.
  const monogramSize = (Math.max(9, Math.round(size * 0.42)) * 64) / size;
  const animate = !reducedMotion && typing;

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
          className={`h-full w-full select-none object-cover ${animate ? 'agent-avatar-typing' : ''}`}
          style={{ borderRadius: Math.max(4, Math.round(size * 0.28)) }}
        />
      ) : (
        <svg
          viewBox="0 0 64 64"
          width={size}
          height={size}
          aria-hidden="true"
          focusable="false"
          className={animate ? 'agent-avatar-typing' : undefined}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <g
            fill={palette.base}
            stroke={palette.base}
            strokeWidth={SHAPE_STROKE}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            {SHAPE_PATHS[resolved.shape]}
          </g>
          <text
            x={32}
            y={32}
            textAnchor="middle"
            dominantBaseline="central"
            fill={palette.ink}
            fontSize={monogramSize}
            fontWeight={500}
            fontFamily="inherit"
          >
            {resolved.monogram}
          </text>
        </svg>
      )}

      {selected && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: -ringSpan,
            boxShadow: `0 0 0 2px ${palette.base}`,
          }}
        />
      )}

      {working && (
        <span
          aria-hidden="true"
          className={`absolute rounded-full ${reducedMotion ? '' : 'agent-avatar-dot'}`}
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
