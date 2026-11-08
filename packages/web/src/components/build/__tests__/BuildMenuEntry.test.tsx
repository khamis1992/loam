import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));

import { setLocale } from '@/i18n/t';
import { BuildMenuEntry } from '../BuildMenuEntry';

beforeEach(() => {
  setLocale('ar');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('choosing a kind and typing a brief does not call jobs', () => {
  render(<BuildMenuEntry enabled />);
  expect(screen.getByRole('dialog').getAttribute('dir')).toBe('rtl');
  fireEvent.click(screen.getByRole('button', { name: 'اختر الأتمتة' }));
  const form = screen.getByRole('region', { name: 'تجهيز المشروع' });
  expect(form.getAttribute('dir')).toBe('rtl');
  expect(form.getAttribute('lang')).toBe('ar');
  expect(form.className).toContain('focus-visible:outline');
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تقرير أسبوعي محلي للملفات' } });
  const fetchMock = vi.mocked(fetch);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('/jobs');
});

test('a disabled menu keeps the old launcher', () => {
  render(<BuildMenuEntry enabled={false} />);
  expect(screen.getByTestId('build-brief')).toBeTruthy();
});

test('legacy path still shows the old launcher', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'المسار القديم' }));
  expect(screen.getByTestId('build-brief')).toBeTruthy();
});

test('desktop and widget preview keep the page when no window opens', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.action === 'preview') {
      return new Response(JSON.stringify({ error: 'missing_requirement', message: 'missing_requirement' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-desktop', summary: 'window', previewHtml: '<p id="empty">لا توجد ملاحظة بعد</p>' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  for (const name of ['اختر تطبيق سطح المكتب', 'اختر ويدجت سطح المكتب']) {
    const view = render(<BuildMenuEntry enabled />);
    fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية على هذا الجهاز' } });
    fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
    expect((await screen.findByTitle('عاين المشروع')).getAttribute('srcdoc')).toContain('لا توجد ملاحظة بعد');
    fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('لم تُفتح نافذة على هذا الجهاز');
    expect(screen.getByRole('alert').textContent).toContain('ليست نافذة Electron');
    expect(screen.getByTitle('عاين المشروع').getAttribute('srcdoc')).toContain('لا توجد ملاحظة بعد');
    view.unmount();
  }
});

test('a desktop portable app is not claimed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format === 'portable-exe') {
      return new Response(JSON.stringify({ error: 'missing_requirement', message: 'missing_requirement' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-desktop', summary: 'window' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق سطح المكتب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تطبيق ملاحظات محلي على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'تطبيق محمول' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('لم يُبنَ تطبيق محمول');
  expect(alert.textContent).toContain('غير موقّع');
  expect(alert.textContent).toContain('SmartScreen');
  expect(alert.textContent).toContain('لن يُعطَّل SmartScreen');
});

test('a returned portable id is not claimed as an exe', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs') && body.operation?.format === 'portable-exe'
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-desktop', summary: 'portable-exe', artifactId: 'art_portable' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-desktop', summary: 'window' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق سطح المكتب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تطبيق ملاحظات محلي على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'تطبيق محمول' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('لم يُبنَ تطبيق محمول');
  expect(alert.textContent).toContain('غير موقّع');
  expect(alert.textContent).not.toContain('هذا الملف المحمول');
  expect(screen.queryByText('art_portable')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'نشر' }));
  expect(screen.getByTestId('build-publish-handoff').textContent).toContain('لم يُبنَ تطبيق محمول');
  expect(screen.getByTestId('build-publish-handoff').textContent).not.toMatch(/\.exe|portable-exe/i);
});

test('a live preview replaces the static page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs') && body.operation?.action === 'preview'
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_live', engine: 'loam-game', summary: 'canvas', previewUrl: 'http://127.0.0.1:9/' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-game', summary: 'canvas', previewHtml: '<canvas id="static"></canvas>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الألعاب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'لعبة محلية بهدف قريب على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  expect((await screen.findByTitle('عاين المشروع')).getAttribute('srcdoc')).toContain('<canvas');
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  await waitFor(() => {
    const frame = screen.getByTitle('عاين المشروع');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:9/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  });
  expect(screen.getAllByTitle('عاين المشروع')).toHaveLength(1);
});

test('chrome preview shows the manual load steps', async () => {
  let jobs = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? {
              projectId: 'app_bcdfghjkmnpq',
              revision: 1,
              jobId: 'job_1',
              engine: 'extension-source',
              summary: jobs === 0 ? 'chrome-extension' : 'لم تُفتح نافذة Chrome. فعّل وضع المطوّر ثم اختر Load unpacked وحدد مجلد الإضافة. لا تعطّل حماية المتصفح.',
              ...(jobs === 0 ? {} : { previewUrl: 'http://127.0.0.1:9/' }),
            }
          : {};
    if (url.endsWith('/jobs')) jobs += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Chrome' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية على الصفحة الحالية' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'عاين المشروع' }));
  expect(await screen.findByText(/لم تُفتح نافذة Chrome/)).toBeTruthy();
  expect(screen.getByText(/فعّل وضع المطوّر ثم اختر Load unpacked/)).toBeTruthy();
  expect(screen.queryByText(/هذه نافذة ملف شخصي/)).toBeNull();
});

test('a chrome extension explains that activeTab is temporary', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Chrome' }));
  const note = screen.getByTestId('build-chrome-note');
  expect(note.textContent).toContain('صلاحية activeTab مؤقتة للصفحة الحالية فقط');
  expect(note.textContent).toContain('لا تُمنح all_urls');
});

test('a widget does not offer startup with the computer', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر ويدجت سطح المكتب' }));
  const note = screen.getByTestId('build-widget-note');
  expect(note.textContent).toContain('التشغيل مع إقلاع الجهاز غير متاح');
  expect(note.textContent).toContain('النسخة المحمولة ليس لها مسار تثبيت ثابت');
});

test('a mobile preview is labeled as a web simulation', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق الجوال' }));
  const note = screen.getByTestId('build-mobile-note');
  expect(note.textContent).toContain('محاكاة الويب');
  expect(note.textContent).toContain('ليست محاكي أندرويد');
  expect(note.textContent).toContain('ليس ملف APK');
  expect(screen.queryByRole('button', { name: /APK/ })).toBeNull();
});

test('an automation send brief shows that nothing was sent', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الأتمتة' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'حضّر تقريراً محلياً ولا ترسله' } });
  expect(screen.queryByTestId('build-send-block')).toBeNull();
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'أرسل تقريراً إلى البريد كل صباح' } });
  expect(screen.getByTestId('build-send-block').textContent).toContain('لم تُرسل رسالة');
});

test('a periodic chrome brief shows the excluded scope', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Chrome' }));
  expect(screen.queryByTestId('build-extension-scope')).toBeNull();
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'احفظ التحديد كل ساعة في الخلفية' } });
  expect(screen.getByTestId('build-extension-scope').textContent).toContain('لا تشغيل دوري ولا شبكة في الخلفية');
});

test('safari export and safari testing stay separate', () => {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Safari' }));
  const note = screen.getByTestId('build-safari-note');
  expect(note.textContent).toContain('مصدر Xcode فقط');
  expect(note.textContent).toContain('سفاري لم يُختبر');
  expect(note.textContent).not.toContain('مكتمل');
  expect(note.textContent).not.toMatch(/تم اختبار سفاري|safariTested":true/i);
});

test('an automation project asks before local reports turn on', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-schedule', summary: 'ready' }
          : url.endsWith('/routines/activate')
            ? { enabled: true }
            : url.endsWith('/routines/disable')
              ? { enabled: false, paused: false }
              : url.endsWith('/routines/pause')
                ? { enabled: true, paused: true }
                : url.endsWith('/routines/resume')
                  ? { enabled: true, paused: false }
                  : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الأتمتة' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تقرير أسبوعي محلي للملفات' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'فعّل التقارير المحلية' }));
  expect(await screen.findByTestId('build-routine-state')).toHaveTextContent('التقارير المحلية مفعّلة');
  expect(calls.some((call) => call.includes('/routines/activate'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'أوقف التقارير المحلية مؤقتاً' }));
  expect(await screen.findByTestId('build-routine-paused')).toHaveTextContent('التقارير المحلية متوقفة مؤقتاً');
  expect(calls.some((call) => call.includes('/routines/pause'))).toBe(true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'استأنف التقارير المحلية' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'استأنف التقارير المحلية' }));
  await waitFor(() => expect(calls.some((call) => call.includes('/routines/resume'))).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'عطّل التقارير المحلية' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'عطّل التقارير المحلية' }));
  expect(await screen.findByText('التقارير المحلية متوقفة')).toBeTruthy();
  expect(calls.some((call) => call.includes('/routines/disable'))).toBe(true);
});

test('an automation preview shows the local schedule page', async () => {
  let jobs = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? {
              projectId: 'app_bcdfghjkmnpq',
              revision: 1,
              jobId: 'job_1',
              engine: 'loam-schedule',
              summary: 'none',
              previewHtml: `<!doctype html><pre>ماذا: تقرير محلي\n${jobs === 0 ? '2026-11-09T06:00:00.000Z' : '2026-11-16T06:00:00.000Z'}</pre>`,
            }
          : {};
    if (url.endsWith('/jobs')) jobs += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الأتمتة' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تقرير أسبوعي محلي للملفات' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  const frame = await screen.findByTitle('عاين المشروع');
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(frame.getAttribute('srcdoc')).toContain('2026-11-09T06:00:00.000Z');
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  await waitFor(() => {
    expect(screen.getByTitle('عاين المشروع').getAttribute('srcdoc')).toContain('2026-11-16T06:00:00.000Z');
  });
});

test('a notebook export asks for the notebook file and does not run a cell', async () => {
  const formats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string; format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format) formats.push(body.operation.format);
    if (url.endsWith('/jobs') && body.operation?.action) formats.push(body.operation.action);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'notebook-ipynb', summary: 'nbformat 4', artifactId: 'art_1' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر دفتر Jupyter' }));
  expect(screen.getByTestId('build-notebook-note').textContent).toContain('لم تُنفَّذ خلية');
  expect(screen.queryByRole('button', { name: 'صدّر الدفتر' })).toBeNull();
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'دفتر محلي يطبع ناتجاً على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'صدّر الدفتر' }));
  await screen.findByText('art_1');
  expect(formats).toContain('ipynb');
  expect(formats).not.toContain('kernel-execute');
});

test('a game package asks for the local web archive', async () => {
  const formats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format) formats.push(body.operation.format);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-game', summary: 'canvas', artifactId: 'art_game' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الألعاب' }));
  expect(screen.getByTestId('build-game-note').textContent).toContain('لعبة لوحة محلية');
  expect(screen.getByTestId('build-game-note').textContent).toContain('لم يُثبَّت محرك ألعاب');
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'لعبة محلية بهدف قريب على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'صدّر حزمة اللعبة' }));
  await screen.findByText('art_game');
  expect(formats).toContain('web-zip');
});

test('a chrome extension export asks for the extension package', async () => {
  const formats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format) formats.push(body.operation.format);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'extension-source', summary: 'chrome-extension', artifactId: 'art_ext' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Chrome' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية على الصفحة الحالية' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'صدّر الإضافة' }));
  await screen.findByText('art_ext');
  expect(formats).toContain('mv3-zip');
});

test('a safari xcode export does not claim Safari was tested', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format === 'xcode-source') {
      return new Response(JSON.stringify({ error: 'unsupported_platform', message: 'unsupported_platform' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'extension-source', summary: 'safari-extension' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Safari' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية لمتصفح سفاري على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'صدّر مشروع Xcode' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('لم يُبنَ مشروع Xcode على هذا الجهاز');
  expect(screen.getByRole('alert').textContent).toContain('لم يُختبر Safari نفسه');
});

test('a website package asks for the site archive and does not claim a Vite build', async () => {
  const formats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { format?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.format === 'web-zip') {
      formats.push(body.operation.format);
      return new Response(JSON.stringify({ error: 'missing_requirement', message: 'missing_requirement' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-build', summary: 'store' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر المواقع' }));
  fireEvent.click(screen.getByRole('button', { name: 'روبوت دردشة' }));
  expect(screen.getByTestId('build-website-note').textContent).toContain('لم يُشغَّل بناء Vite');
  expect(screen.getByTestId('build-website-note').textContent).toContain('لم يُنزَّل شيء');
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'صدّر حزمة الموقع' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('لم تُبنَ حزمة الموقع');
  expect(screen.getByRole('alert').textContent).toContain('ليس بناء Vite');
  expect(formats).toEqual(['web-zip']);
});

test('leaving the page stops a live preview and a widget stays', async () => {
  const urls: string[] = [];
  let previews = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const preview = url.endsWith('/jobs') && body.operation?.action === 'preview';
    if (preview) previews += 1;
    const jobId = preview ? `job_live_${previews}` : 'job_1';
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : preview
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId, engine: 'loam-game', summary: 'canvas', previewUrl: 'http://127.0.0.1:9/' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId, engine: 'loam-game', summary: 'canvas', previewHtml: '<p>page</p>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const open = async (name: string, brief: string) => {
    const view = render(<BuildMenuEntry enabled />);
    fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: brief } });
    fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
    fireEvent.click(await screen.findByRole('button', { name: 'عاين المشروع' }));
    await waitFor(() => {
      expect(screen.getByTitle('عاين المشروع').getAttribute('src')).toBe('http://127.0.0.1:9/');
    });
    return view;
  };
  const settled = () => act(async () => { await Promise.resolve(); });
  const game = await open('اختر الألعاب', 'لعبة محلية بهدف قريب على هذا الجهاز');
  game.unmount();
  await settled();
  expect(urls.filter((url) => url.endsWith('/jobs/job_live_1/cancel'))).toHaveLength(1);
  urls.length = 0;
  const widget = await open('اختر ويدجت سطح المكتب', 'ويدجت تركيز محلي على هذا الجهاز');
  widget.unmount();
  await settled();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
  urls.length = 0;
  const back = await open('اختر الألعاب', 'لعبة محلية بهدف قريب على هذا الجهاز');
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  back.unmount();
  await settled();
  expect(urls.filter((url) => url.endsWith('/jobs/job_live_3/cancel'))).toHaveLength(1);
  urls.length = 0;
  const kept = await open('اختر الألعاب', 'لعبة محلية بهدف قريب على هذا الجهاز');
  fireEvent.click(screen.getByTestId('build-keep-preview'));
  kept.unmount();
  await settled();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
});

test('closing the panel stops a preview unless it is kept or a widget', async () => {
  const urls: string[] = [];
  let previews = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const preview = url.endsWith('/jobs') && body.operation?.action === 'preview';
    if (preview) previews += 1;
    const jobId = preview ? `job_panel_${previews}` : 'job_1';
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : preview
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId, engine: 'loam-game', summary: 'canvas', previewUrl: 'http://127.0.0.1:9/' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId, engine: 'loam-game', summary: 'canvas', previewHtml: '<p>page</p>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const open = async (name: string, brief: string) => {
    const view = render(<BuildMenuEntry enabled />);
    fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: brief } });
    fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
    fireEvent.click(await screen.findByRole('button', { name: 'عاين المشروع' }));
    await waitFor(() => {
      expect(screen.getByTitle('عاين المشروع').getAttribute('src')).toBe('http://127.0.0.1:9/');
    });
    return view;
  };
  const settled = () => act(async () => { await Promise.resolve(); });
  const game = await open('اختر الألعاب', 'لعبة محلية بهدف قريب على هذا الجهاز');
  expect((screen.getByTestId('build-keep-preview') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  await waitFor(() => {
    expect(urls.filter((url) => url.endsWith('/jobs/job_panel_1/cancel'))).toHaveLength(1);
  });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
  game.unmount();
  await settled();
  expect(urls.filter((url) => url.endsWith('/jobs/job_panel_1/cancel'))).toHaveLength(1);
  urls.length = 0;
  const kept = await open('اختر الألعاب', 'لعبة محلية بهدف قريب على هذا الجهاز');
  fireEvent.click(screen.getByTestId('build-keep-preview'));
  expect((screen.getByTestId('build-keep-preview') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  await settled();
  await settled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
  kept.unmount();
  await settled();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
  urls.length = 0;
  const widget = await open('اختر ويدجت سطح المكتب', 'ويدجت تركيز محلي على هذا الجهاز');
  expect(screen.queryByTestId('build-keep-preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  await settled();
  await settled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
  widget.unmount();
  await settled();
  expect(urls.some((url) => url.includes('/cancel'))).toBe(false);
});

test('a stopped preview leaves the page and does not claim a package', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    if (init?.method === 'GET' && url.endsWith('/jobs/job_live')) {
      return new Response(JSON.stringify({ phase: 'failed', message: 'preview_exited' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs') && body.operation?.action === 'preview'
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_live', engine: 'loam-build', summary: 'page', previewUrl: 'http://127.0.0.1:9/' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-build', summary: 'page', previewHtml: '<p>هبوط</p>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر المواقع' }));
  fireEvent.click(screen.getByRole('button', { name: 'روبوت دردشة' }));
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'عاين المشروع' }));
  await waitFor(() => expect(screen.getByTitle('عاين المشروع').getAttribute('src')).toBe('http://127.0.0.1:9/'));
  expect(await screen.findByRole('alert')).toHaveTextContent('توقفت المعاينة بعد خروجها');
  expect(screen.getByRole('alert').textContent).toContain('لم تُنشأ حزمة');
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
});

test('a desktop page stays when its window exits and no package is claimed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    if (init?.method === 'GET' && url.endsWith('/jobs/job_desk')) {
      return new Response(JSON.stringify({ phase: 'failed', message: 'preview_exited' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs') && body.operation?.action === 'preview'
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_desk', engine: 'loam-desktop', summary: 'native' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-desktop', summary: 'window', previewHtml: '<p id="empty">لا توجد ملاحظة بعد</p>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق سطح المكتب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  expect((await screen.findByTitle('عاين المشروع')).getAttribute('srcdoc')).toContain('لا توجد ملاحظة بعد');
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('توقفت المعاينة بعد خروجها');
  expect(alert.textContent).toContain('لم تُنشأ حزمة');
  expect(screen.getByTitle('عاين المشروع').getAttribute('srcdoc')).toContain('لا توجد ملاحظة بعد');
});

test('closing a notebook asks before the preview stops and does not write the file', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs') && body.operation?.action === 'preview'
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_book', engine: 'notebook-ipynb', summary: 'nbformat 4', previewUrl: 'http://127.0.0.1:9/' }
          : url.endsWith('/jobs')
            ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'notebook-ipynb', summary: 'nbformat 4', previewHtml: '<p>خلية</p>' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر دفتر Jupyter' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'دفتر محلي يطبع ناتجاً على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  fireEvent.click(await screen.findByRole('button', { name: 'عاين المشروع' }));
  await waitFor(() => expect(screen.getByTitle('عاين المشروع').getAttribute('src')).toBe('http://127.0.0.1:9/'));
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  const dialog = screen.getByRole('dialog', { name: 'إغلاق الدفتر' });
  expect(dialog.textContent).toContain('يبقى خارج الملف');
  expect(urls.some((url) => url.includes('/cancel') || url.includes('notebook-cell'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'ابقَ واحفظ' }));
  expect(screen.queryByRole('dialog', { name: 'إغلاق الدفتر' })).toBeNull();
  expect(screen.getByTitle('عاين المشروع').getAttribute('src')).toBe('http://127.0.0.1:9/');
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  fireEvent.click(screen.getByRole('button', { name: 'أوقف بلا حفظ جديد' }));
  await act(async () => { await Promise.resolve(); });
  expect(urls.filter((url) => url.endsWith('/jobs/job_book/cancel'))).toHaveLength(1);
  expect(urls.some((url) => url.includes('notebook-cell'))).toBe(false);
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
  const gone = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(gone);
  expect(gone.defaultPrevented).toBe(false);
});

test('a mobile summary does not claim an apk', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-mobile', summary: 'debug.apk is ready', previewHtml: '<p>debug.apk</p>' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق الجوال' }));
  expect(screen.getByTestId('build-mobile-note').textContent).toContain('ليس ملف APK');
  expect(screen.queryByRole('button', { name: /APK/ })).toBeNull();
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'تطبيق جوال محلي على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  await screen.findByRole('button', { name: 'عاين المشروع' });
  expect(document.body.innerHTML).not.toMatch(/debug\.apk/i);
});

test('chrome does not claim the extension loaded', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'a'.repeat(64) }
        : url.endsWith('/jobs')
          ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'extension-source', summary: 'Chrome loaded the extension', previewHtml: '<p>Chrome loaded the extension</p>' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر إضافة Chrome' }));
  const note = screen.getByTestId('build-chrome-note');
  expect(note.textContent).toContain('حمّل الإضافة يدوياً');
  expect(note.textContent).not.toMatch(/loaded the extension/i);
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'ملاحظة محلية على الصفحة الحالية' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  await screen.findByTitle('عاين المشروع');
  expect(document.body.innerHTML).not.toMatch(/loaded the extension/i);
});

test('a notebook does not show an image digest', async () => {
  const digest = 'ab'.repeat(32);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith('/projects')
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1 }
      : url.endsWith('/grants')
        ? { grantId: 'c'.repeat(64) }
        : url.endsWith('/jobs')
          ? {
              projectId: 'app_bcdfghjkmnpq',
              revision: 1,
              jobId: 'job_1',
              engine: 'notebook-ipynb',
              summary: `sha256:${digest}`,
              previewHtml: `<meta name="loam-image-pin" content='{"status":"unresolved","digest":"${digest}"}'>`,
            }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر دفتر Jupyter' }));
  expect(screen.getByTestId('build-notebook-note').textContent).toContain('لم تُنفَّذ خلية');
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'دفتر محلي يطبع ناتجاً على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  await screen.findByRole('button', { name: 'صدّر الدفتر' });
  expect(document.body.innerHTML).not.toContain(digest);
  expect(document.body.innerHTML).not.toMatch(/sha256:[a-f0-9]{64}/i);
});
