/**
 * Neo N18: the minimap, as geometry.
 *
 * The rule that matters is that the thumbnail and the viewport describe the same
 * rectangle of graph space, so a click pans the canvas to what the user aimed at.
 * No DOM is involved, which is why the rule can be pinned without Playwright.
 */
import { describe, expect, it } from 'vitest';

import {
  clampView,
  graphBounds,
  minimapClickOffset,
  minimapPoint,
  minimapScale,
  minimapViewportRect,
  viewportFits,
  type GraphRect,
  type MinimapView,
} from '../minimapGeometry';

const THUMBNAIL = { width: 168, height: 112 };
const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

describe('graph bounds', () => {
  it('covers the footprint of the rightmost and lowest node', () => {
    const bounds = graphBounds(
      [
        { x: 0, y: 0 },
        { x: 280, y: 240 },
      ],
      NODE_WIDTH,
      NODE_HEIGHT,
    );
    expect(bounds).toEqual({ x: 0, y: 0, width: 280 + NODE_WIDTH, height: 240 + NODE_HEIGHT });
  });

  it('is a single node footprint for an empty graph, so it never divides by zero', () => {
    expect(graphBounds([], NODE_WIDTH, NODE_HEIGHT)).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('follows a graph whose top-left is not the origin', () => {
    const bounds = graphBounds([{ x: -400, y: -200 }], NODE_WIDTH, NODE_HEIGHT);
    expect(bounds.x).toBe(-400);
    expect(bounds.y).toBe(-200);
    expect(bounds.width).toBe(NODE_WIDTH);
  });
});

describe('minimap scale', () => {
  it('uses the tighter of the two axes and never goes below the floor', () => {
    expect(minimapScale({ x: 0, y: 0, width: 1000, height: 500 }, THUMBNAIL)).toBeCloseTo(168 / 1000, 6);
    // A degenerate graph would otherwise scale to infinity.
    expect(minimapScale({ x: 0, y: 0, width: 0, height: 0 }, THUMBNAIL)).toBe(0.05);
  });
});

describe('minimap geometry', () => {
  const bounds: GraphRect = { x: 0, y: 0, width: 1000, height: 500 };
  const scale = minimapScale(bounds, THUMBNAIL);
  const view: MinimapView = { width: 900, height: 600, offsetX: 0, offsetY: 0 };

  it('maps a graph point into the thumbnail', () => {
    expect(minimapPoint({ x: 0, y: 0 }, bounds, scale)).toEqual({ x: 0, y: 0 });
    expect(minimapPoint({ x: 500, y: 250 }, bounds, scale)).toEqual({
      x: 500 * scale,
      y: 250 * scale,
    });
  });

  it('draws the viewport as the same rectangle of graph space', () => {
    const rect = minimapViewportRect(view, bounds, scale);
    expect(rect).toEqual({ x: 0, y: 0, width: view.width * scale, height: view.height * scale });
  });

  it('aims a click at the graph point under it', () => {
    // A click is a thumbnail pixel; the function returns the graph-space offset
    // whose centre that pixel is. Clicking the top-left corner aims the viewport
    // at the graph's top-left corner.
    expect(minimapClickOffset({ x: 0, y: 0 }, bounds, scale, view)).toEqual({
      offsetX: bounds.x - view.width / 2,
      offsetY: bounds.y - view.height / 2,
    });
    // Clicking the middle of the thumbnail aims at the middle of the graph.
    // A 1:1 scale makes the centre land exactly on the graph's centre.
    expect(
      minimapClickOffset(
        { x: THUMBNAIL.width / 2, y: THUMBNAIL.height / 2 },
        // A graph exactly the thumbnail's size, at a 1:1 scale: the centre of the
        // thumbnail is the centre of the graph, so the offset stays put.
        { x: 0, y: 0, width: THUMBNAIL.width, height: THUMBNAIL.height },
        1,
        { width: THUMBNAIL.width, height: THUMBNAIL.height, offsetX: 0, offsetY: 0 },
      ),
    ).toEqual({ offsetX: 0, offsetY: 0 });
  });

  it('reports whether the viewport is fully inside the thumbnail', () => {
    const inside = minimapViewportRect({ width: 400, height: 200, offsetX: 0, offsetY: 0 }, bounds, scale);
    expect(viewportFits(inside, THUMBNAIL)).toBe(true);
    const outside = minimapViewportRect({ width: 4000, height: 200, offsetX: 0, offsetY: 0 }, bounds, scale);
    expect(viewportFits(outside, THUMBNAIL)).toBe(false);
  });
});

describe('view clamping', () => {
  const bounds: GraphRect = { x: 0, y: 0, width: 1000, height: 500 };

  it('centres a viewport that is larger than the graph', () => {
    const clamped = clampView({ width: 4000, height: 4000, offsetX: -2000, offsetY: -2000 }, bounds);
    // The whole graph stays visible, so the viewport sits centred on it.
    expect(clamped.offsetX).toBeCloseTo((bounds.width - 4000) / 2, 6);
    expect(clamped.offsetY).toBeCloseTo((bounds.height - 4000) / 2, 6);
  });

  it('leaves a viewport that already fits the graph alone', () => {
    const view: MinimapView = { width: 400, height: 200, offsetX: 100, offsetY: 50 };
    expect(clampView(view, bounds)).toEqual(view);
  });

  it('pins an oversized viewport to the graph edge instead of letting it drift past it', () => {
    const clamped = clampView({ width: 400, height: 200, offsetX: -500, offsetY: 400 }, bounds);
    expect(clamped.offsetX).toBe(0);
    expect(clamped.offsetY).toBe(300);
  });
});
