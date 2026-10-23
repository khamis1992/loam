import { describe, expect, it } from 'vitest';
import {
  getLoamEffectsTarget,
  setLoamEffectsTarget,
  subscribeLoamEffectsTarget,
} from './effectcraftClient';

/**
 * The hidden "Loam Effects" engine registers here so agent tools and the
 * round-trip planner can reach whichever engine instance is mounted. The
 * registry mirrors `filmcraftClient` for the video engine.
 */
describe('effectcraftClient registry', () => {
  it('starts with no target and clears one on unmount', () => {
    setLoamEffectsTarget(null);
    expect(getLoamEffectsTarget()).toBeNull();

    const target = {
      taskId: 'task-1',
      bridge: null,
      hasApi: true,
      projectPath: 'effects/clip.ecproj',
      openProject: async () => ({}),
    };
    const stop = subscribeLoamEffectsTarget(() => {});
    setLoamEffectsTarget(target);
    expect(getLoamEffectsTarget()).toBe(target);

    stop();
    setLoamEffectsTarget(null);
    expect(getLoamEffectsTarget()).toBeNull();
  });

  it('notifies subscribers on registration and unregistration', () => {
    setLoamEffectsTarget(null);
    let calls = 0;
    const stop = subscribeLoamEffectsTarget(() => {
      calls += 1;
    });
    setLoamEffectsTarget({
      taskId: 'task-1',
      bridge: null,
      hasApi: true,
      projectPath: null,
      openProject: async () => ({}),
    });
    expect(calls).toBe(1);
    setLoamEffectsTarget(null);
    expect(calls).toBe(2);
    stop();
  });
});
