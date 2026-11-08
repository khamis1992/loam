import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { widgetPreviewHtml, widgetPreviewScript } from '../widget/previewPage.js';

test('countdown starts at 300, stops on pagehide, and leaves no interval running', () => {
  const html = widgetPreviewHtml();
  const script = widgetPreviewScript();
  const toggle = html.match(/<input id="autostart-toggle"[^>]*>/)?.[0] ?? '';
  assert.equal(toggle.includes('disabled'), true);
  assert.equal(toggle.includes('checked'), false);
  const portable = html.match(/id="portable-export">([^<]*)</)?.[1] ?? '';
  assert.equal(portable.includes('لم يُبنَ'), true);
  assert.equal(/تم بناء|تم إنشاء|تم انشاء|\.exe|was built|has been built/i.test(portable), false);
  assert.equal(script.includes('setLoginItemSettings'), false);
  assert.equal(html.includes('setLoginItemSettings'), false);

  mock.timers.enable({ apis: ['setInterval'] });
  const armed = new Set<unknown>();
  let intervalCalls = 0;
  const startInterval = setInterval;
  const stopInterval = clearInterval;
  const trackedSet = (handler: (...args: unknown[]) => void, timeout?: number) => {
    const id = startInterval(() => {
      intervalCalls += 1;
      handler();
    }, timeout);
    armed.add(id);
    return id;
  };
  const trackedClear = (id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) armed.delete(id);
    stopInterval(id);
  };
  const countdown = { textContent: '' };
  const note = { value: '', addEventListener() {} };
  const error = { hidden: true, textContent: '' };
  const exported = { hidden: true, value: '' };
  const empty = { hidden: false };
  const autostart = { disabled: true, checked: false };
  const listeners = new Map<string, Array<() => void>>();
  const addEventListener = (type: string, fn: () => void) => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };
  let now = 1_700_000_000_000;

  try {
    vm.runInNewContext(script, {
      document: {
        visibilityState: 'visible',
        querySelector(selector: string) {
          if (selector === '#countdown') return countdown;
          if (selector === '#note') return note;
          if (selector === '#save-error') return error;
          if (selector === '#export') return exported;
          if (selector === '#empty') return empty;
          if (selector === '#autostart-toggle') return autostart;
          return null;
        },
        addEventListener,
      },
      window: { addEventListener },
      Date: { now: () => now },
      localStorage: { getItem: () => '', setItem() {} },
      setInterval: trackedSet,
      clearInterval: trackedClear,
    });

    assert.equal(countdown.textContent, '300');
    assert.equal(armed.size, 1);
    assert.equal(autostart.disabled, true);
    assert.equal(autostart.checked, false);

    now += 5_000;
    mock.timers.tick(5_000);
    assert.equal(countdown.textContent, '295');
    const callsWhileRunning = intervalCalls;
    assert.equal(callsWhileRunning > 0, true);

    const hide = listeners.get('pagehide') ?? [];
    assert.equal(hide.length, 1);
    const stop = hide[0];
    if (stop === undefined) {
      throw new Error('pagehide listener missing');
    }
    stop();
    assert.equal(armed.size, 0);
    assert.equal(countdown.textContent, '295');
    assert.doesNotThrow(() => {
      stop();
    });
    assert.equal(armed.size, 0);

    now += 60_000;
    mock.timers.tick(60_000);
    assert.equal(intervalCalls, callsWhileRunning);
    assert.equal(countdown.textContent, '295');
    assert.equal(armed.size, 0);
    assert.equal(autostart.disabled, true);
    assert.equal(autostart.checked, false);
  } finally {
    mock.timers.reset();
  }
});
