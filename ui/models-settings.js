/**
 * Models Settings Screen (Settings > Models)
 * 
 * Arabic-first UI for managing model registry:
 * - List providers and models
 * - Add/edit/delete providers
 * - Discover models from providers
 * - Configure chains
 * 
 * Note: This is a minimal implementation. Full UI in Phase 6b.
 */

import { icon } from './icons.js';

/* Arabic strings (primary) */
const AR = {
  title: 'إعدادات النماذج',
  providers: 'مقدمو الخدمة',
  models: 'النماذج',
  chains: 'السلاسل',
  addProvider: 'إضافة مقدم خدمة',
  refresh: 'تحديث',
  noProviders: 'لا يوجد مقدمو خدمة',
  noModels: 'لا توجد نماذج',
  loading: 'جاري التحميل...',
  error: 'خطأ',
  enabled: 'مفعّل',
  disabled: 'معطل',
  local: 'محلي',
  cloud: 'سحابي',
};

/* English strings (fallback) */
const EN = {
  title: 'Models Settings',
  providers: 'Providers',
  models: 'Models',
  chains: 'Chains',
  addProvider: 'Add Provider',
  refresh: 'Refresh',
  noProviders: 'No providers configured',
  noModels: 'No models available',
  loading: 'Loading...',
  error: 'Error',
  enabled: 'Enabled',
  disabled: 'Disabled',
  local: 'Local',
  cloud: 'Cloud',
};

/* Default to Arabic */
const T = AR;

/**
 * Load registry data from API.
 */
async function loadRegistry() {
  try {
    const res = await fetch('/api/model-registry');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    console.error('[models-settings] Failed to load registry:', error);
    return null;
  }
}

/**
 * Render providers list.
 */
function statusChip(provider) {
  const test = provider.lastTest;
  if (!test) return '<span class="badge">لم يُختبر</span>';
  if (test.ok) return '<span class="badge badge-enabled">متصل</span>';
  if (test.error?.code === 'auth') return '<span class="badge badge-disabled">المفتاح مرفوض</span>';
  return '<span class="badge badge-disabled">غير متاح</span>';
}

function headersFromText(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const split = line.indexOf(':');
    if (split < 1) continue;
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

function renderProviders(providers) {
  const container = document.getElementById('providers-list');
  if (!container) return;

  if (!providers || providers.length === 0) {
    container.innerHTML = `<div class="empty-state">${T.noProviders}</div>`;
    return;
  }

  const html = providers.map(p => `
    <div class="provider-card" data-id="${p.id}">
      <div class="provider-header">
        <h3>${p.label}</h3>
        <span class="badge badge-${p.location}">${T[p.location]}</span>
        <span class="badge badge-${p.enabled ? 'enabled' : 'disabled'}">
          ${p.enabled ? T.enabled : T.disabled}
        </span>
        ${statusChip(p)}
      </div>
      <div class="provider-meta">
        <span class="provider-kind">${p.kind}</span>
        <span class="provider-url">${p.baseUrl}</span>
      </div>
      <div class="provider-actions">
        <button class="btn btn-sm" type="button" data-test-provider="${p.id}">${icon('check')} اختبار</button>
        <button class="btn btn-sm" onclick="showDiscoverDialog('${p.id}')">${icon('refresh')} اكتشاف</button>
        <button class="btn btn-sm" onclick="showEditProviderDialog('${p.id}')">${icon('settings')} تعديل</button>
        <button class="btn btn-sm btn-danger" onclick="confirmDeleteProvider('${p.id}')">${icon('trash')} حذف</button>
      </div>
    </div>
  `).join('');

  container.innerHTML = html;
  container.querySelectorAll('[data-test-provider]').forEach((button) => {
    button.addEventListener('click', async () => {
      const provider = providers.find((item) => item.id === button.dataset.testProvider);
      if (!provider) return;
      button.disabled = true;
      const res = await fetch('/api/model-registry/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: provider.kind, baseUrl: provider.baseUrl, providerId: provider.id }),
      });
      const result = await res.json();
      button.disabled = false;
      alert(result.success ? 'متصل' : (result.error || 'غير متاح'));
      const updated = await loadRegistry();
      if (updated) renderProviders(updated.providers);
    });
  });
}

/**
 * Render models list.
 */
function renderModels(models) {
  const container = document.getElementById('models-list');
  if (!container) return;

  if (!models || models.length === 0) {
    container.innerHTML = `<div class="empty-state">${T.noModels}</div>`;
    return;
  }

  const html = models.map(m => `
    <div class="model-card" data-id="${m.id}">
      <div class="model-header">
        <h4>${m.label}</h4>
        <span class="badge badge-${m.enabled ? 'enabled' : 'disabled'}">
          ${m.enabled ? T.enabled : T.disabled}
        </span>
      </div>
      <div class="model-meta">
        <span>${m.providerId}</span>
        <span>أدوات: ${m.capabilities?.tools ?? '?'}</span>
        <span>رؤية: ${m.capabilities?.vision ?? '?'}</span>
        ${m.capabilities?.contextWindow ? `<span>${m.capabilities.contextWindow.toLocaleString()} tokens</span>` : ''}
      </div>
      <div class="provider-actions">
        <label><input type="checkbox" data-toggle-model="${m.id}" ${m.enabled ? 'checked' : ''}> مفعّل</label>
        <button type="button" class="btn btn-sm" data-test-model="${m.id}">فحص</button>
        <button type="button" class="btn btn-sm" data-edit-model="${m.id}">تعديل</button>
      </div>
    </div>
  `).join('');

  container.innerHTML = html;
  container.querySelectorAll('[data-edit-model]').forEach((button) => {
    button.addEventListener('click', () => showEditModelDialog(button.dataset.editModel));
  });
  container.querySelectorAll('[data-test-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const res = await fetch(`/api/model-registry/models/${encodeURIComponent(button.dataset.testModel)}/probe`, { method: 'POST' });
      const body = await res.json();
      button.disabled = false;
      alert(body.error ? `تعذر الفحص: ${body.error}` : (body.tools ? 'النموذج استجاب لنداء أداة' : 'النموذج لم ينادِ الأداة'));
    });
  });
  container.querySelectorAll('[data-toggle-model]').forEach((box) => {
    box.addEventListener('change', async () => {
      const res = await fetch(`/api/model-registry/models/${encodeURIComponent(box.dataset.toggleModel)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: box.checked }),
      });
      if (!res.ok) alert((await res.json()).error || 'فشل');
    });
  });
}

/**
 * Initialize models settings screen.
 */
export async function initModelsSettings() {
  console.log('[models-settings] Initializing...');

  // Show loading state
  const main = document.getElementById('models-settings-main');
  if (main) {
    main.innerHTML = `<div class="loading">${T.loading}</div>`;
  }

  // Load registry
  const registry = await loadRegistry();
  if (!registry) {
    if (main) {
      main.innerHTML = `<div class="error">${T.error}: Failed to load registry</div>`;
    }
    return;
  }

  // Render UI
  if (main) {
    main.innerHTML = `
      <div class="models-settings">
        <header>
          <h1>${T.title}</h1>
          <div class="row">
            <button id="refresh-btn" class="btn">${T.refresh}</button>
            <button id="reimport-btn" class="btn">إعادة الاستيراد من config.json</button>
          </div>
        </header>
        <section class="defaults-section">
          <h2>الافتراضي والاحتياطي</h2>
          <label>الافتراضي <select id="default-model"></select></label>
          <label>الاحتياطي <select id="fallback-model"></select></label>
          <button id="save-defaults" class="btn">حفظ</button>
        </section>
        
        <section class="providers-section">
          <h2>${T.providers}</h2>
          <div id="providers-list"></div>
          <button id="add-provider-btn" class="btn btn-primary">${T.addProvider}</button>
        </section>
        
        <section class="models-section">
          <h2>${T.models}</h2>
          <div id="models-list"></div>
        </section>
        
        <section class="chains-section">
          <h2>${T.chains}</h2>
          <div id="chains-list"></div>
        </section>
      </div>
    `;
  }

  renderProviders(registry.providers);
  renderModels(registry.models);
  renderChains(registry);
  fillDefaultSelects(registry);

  // Wire up refresh button
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await fetch('/api/model-registry/reload', { method: 'POST' });
      const updated = await loadRegistry();
      if (updated) {
        renderProviders(updated.providers);
        renderModels(updated.models);
        renderChains(updated);
        fillDefaultSelects(updated);
      }
    });
  }

  document.getElementById('reimport-btn')?.addEventListener('click', async () => {
    if (!confirm('إعادة الاستيراد تدمج config.json في السجل. المتابعة؟')) return;
    const res = await fetch('/api/model-registry/reimport', { method: 'POST' });
    if (!res.ok) { alert((await res.json()).error || 'فشل'); return; }
    const updated = await loadRegistry();
    if (updated) { renderProviders(updated.providers); renderModels(updated.models); renderChains(updated); fillDefaultSelects(updated); }
  });

  document.getElementById('save-defaults')?.addEventListener('click', async () => {
    const res = await fetch('/api/model-registry/defaults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultModelId: document.getElementById('default-model').value || null,
        fallbackModelId: document.getElementById('fallback-model').value || null,
      }),
    });
    if (!res.ok) alert((await res.json()).error || 'فشل');
  });

  // Wire up add provider button
  const addBtn = document.getElementById('add-provider-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => showAddProviderDialog());
  }
}

/**
 * Show Add Provider dialog.
 */
const WIZARD_PRESETS = {
  ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434', label: 'Ollama', locked: true },
  lmstudio: { kind: 'lmstudio', url: 'http://127.0.0.1:1234/v1', label: 'LM Studio', locked: true },
  llamacpp: { kind: 'llamacpp', url: 'http://127.0.0.1:8080/v1', label: 'llama.cpp', locked: true },
  freellmapi: { kind: 'custom', url: 'http://127.0.0.1:31415/v1', label: 'FreeLLMAPI', locked: true },
  openai: { kind: 'openai', url: 'https://api.openai.com/v1', label: 'OpenAI', locked: true },
  openrouter: { kind: 'openrouter', url: 'https://openrouter.ai/api/v1', label: 'OpenRouter', locked: true },
  anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com/v1', label: 'Anthropic', locked: true },
  gemini: { kind: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta', label: 'Gemini', locked: true },
  custom: { kind: 'custom', url: '', label: '', locked: false },
};

function showAddProviderDialog() {
  const draft = { source: '', providerId: '', models: [] };
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-dialog" id="add-model-wizard">
      <div class="modal-header">
        <h2>إضافة نموذج <span id="wizard-step-label">1/4</span></h2>
        <button class="btn-close" type="button">✕</button>
      </div>
      <div class="modal-body">
        <section class="wizard-step" data-step="1">
          <label><input type="radio" name="wizard-source" value="ollama"> Ollama</label>
          <label><input type="radio" name="wizard-source" value="lmstudio"> محلي متوافق مع OpenAI — LM Studio</label>
          <label><input type="radio" name="wizard-source" value="llamacpp"> محلي متوافق مع OpenAI — llama.cpp</label>
          <label><input type="radio" name="wizard-source" value="freellmapi"> FreeLLMAPI</label>
          <label><input type="radio" name="wizard-source" value="cloud"> سحابي</label>
          <select id="wizard-cloud" hidden>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini</option>
          </select>
          <label><input type="radio" name="wizard-source" value="custom"> مخصص</label>
          <p id="wizard-step1-note"></p>
        </section>
        <section class="wizard-step" data-step="2" hidden>
          <label>الاسم <input id="provider-label"></label>
          <label>البروتوكول <input id="provider-type" readonly></label>
          <label>العنوان <input id="provider-url" type="url"></label>
          <label>المهلة (مللي ثانية) <input id="provider-timeout" type="number" min="5000" value="30000"></label>
          <label>المصادقة <select id="provider-auth"><option value="key">مفتاح</option><option value="env">متغير بيئة</option><option value="none">بدون مفتاح</option></select></label>
          <label id="provider-key-row">المفتاح <input id="provider-key" type="password" autocomplete="off"></label>
          <button type="button" class="btn" id="wizard-eye">إظهار</button>
          <label id="provider-env-row" hidden>اسم المتغير <input id="provider-env" placeholder="OPENAI_API_KEY" autocomplete="off"></label>
          <label>ترويسات إضافية <textarea id="provider-headers" placeholder="X-Title: Loam"></textarea></label>
          <p id="wizard-http-warning" hidden>عنوان سحابي عبر http. علّم الموافقة للمتابعة. <input id="wizard-http-ok" type="checkbox"></p>
          <p id="wizard-duplicate" hidden>هذا العنوان مضاف مسبقاً.</p>
          <p id="wizard-down" hidden>FreeLLMAPI غير متاح. يمكنك حفظ المزود معطّلاً. <input id="wizard-save-disabled" type="checkbox"></p>
          <p class="test-result" id="wizard-test"></p>
          <button type="button" class="btn" id="wizard-test-btn">اختبار</button>
        </section>
        <section class="wizard-step" data-step="3" hidden>
          <input id="wizard-search" placeholder="بحث">
          <button type="button" class="btn" id="wizard-refresh-models">تحديث</button>
          <div id="discovered-models-list"></div>
          <label>معرّف يدوي <input id="wizard-manual-id" placeholder="remote-id"></label>
          <button type="button" class="btn" id="wizard-add-manual">إضافة المعرّف</button>
        </section>
        <section class="wizard-step" data-step="4" hidden>
          <label><input id="wizard-tools" type="checkbox"> أدوات</label>
          <label><input id="wizard-vision" type="checkbox"> رؤية</label>
          <label>التفكير <select id="wizard-thinking"><option value="unknown">غير معروف</option><option value="none">بدون</option><option value="toggle">قابل للتبديل</option><option value="always">دائماً</option></select></label>
          <label>النافذة <input id="wizard-context" type="number" min="1" placeholder="سياق"></label>
          <label>أقصى إخراج <input id="wizard-max-output" type="number" min="1"></label>
          <label>الحرارة <input id="wizard-temperature" type="number" min="0" max="2" step="0.1"></label>
          <label><input id="wizard-chain" type="checkbox" checked> أضف إلى السلسلة الافتراضية</label>
          <label><input id="wizard-default" type="checkbox"> اجعله النموذج الافتراضي</label>
          <button type="button" class="btn" id="wizard-probe">فحص الأدوات</button>
          <p id="wizard-probe-result"></p>
          <p>النموذج المحلي لا يغني عن نموذج سحابي لمهام البناء والتخطيط.</p>
        </section>
        <div class="form-actions">
          <button type="button" class="btn" id="wizard-cancel">إلغاء</button>
          <button type="button" class="btn" id="wizard-back" hidden>رجوع</button>
          <button type="button" class="btn btn-primary" id="wizard-next" disabled>التالي</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const showStep = (step) => {
    dialog.querySelectorAll('.wizard-step').forEach((panel) => { panel.hidden = panel.dataset.step !== String(step); });
    dialog.querySelector('#wizard-step-label').textContent = `${step}/4`;
    dialog.querySelector('#wizard-back').hidden = step === 1;
    dialog.querySelector('#wizard-next').textContent = step === 4 ? 'حفظ' : 'التالي';
    draft.step = step;
  };
  const selectedSource = () => {
    const picked = dialog.querySelector('input[name="wizard-source"]:checked')?.value;
    if (picked === 'cloud') return dialog.querySelector('#wizard-cloud').value;
    return picked || '';
  };
  dialog.querySelector('.btn-close').onclick = () => dialog.remove();
  dialog.querySelector('#wizard-cancel').onclick = async () => {
    if (draft.providerId && confirm('حذف المزود الذي لم تكتمل إضافته؟')) {
      await fetch(`/api/model-registry/providers/${draft.providerId}`, { method: 'DELETE' });
    }
    dialog.remove();
  };
  dialog.querySelectorAll('input[name="wizard-source"]').forEach((input) => {
    input.addEventListener('change', () => {
      dialog.querySelector('#wizard-cloud').hidden = input.value !== 'cloud' || !input.checked;
      dialog.querySelector('#wizard-next').disabled = !selectedSource();
    });
  });
  dialog.querySelector('#wizard-cloud').addEventListener('change', () => { dialog.querySelector('#wizard-next').disabled = !selectedSource(); });
  dialog.querySelector('#provider-auth').addEventListener('change', () => {
    const mode = dialog.querySelector('#provider-auth').value;
    dialog.querySelector('#provider-key-row').hidden = mode !== 'key';
    dialog.querySelector('#wizard-eye').hidden = mode !== 'key';
    dialog.querySelector('#provider-env-row').hidden = mode !== 'env';
  });
  dialog.querySelector('#wizard-eye').onclick = () => {
    const key = dialog.querySelector('#provider-key');
    key.type = key.type === 'password' ? 'text' : 'password';
  };
  dialog.querySelector('#wizard-test-btn').onclick = () => testProviderConnection(dialog);
  dialog.querySelector('#wizard-refresh-models').onclick = () => loadWizardModels(dialog, draft);
  dialog.querySelector('#wizard-probe').onclick = async () => {
    const result = dialog.querySelector('#wizard-probe-result');
    const manual = dialog.querySelector('#wizard-manual-id').value.trim();
    const picked = dialog.querySelector('#discovered-models-list input:checked');
    const remoteId = manual || (picked ? draft.models[Number(picked.dataset.index)]?.remoteId : '');
    if (!draft.providerId || !remoteId) { result.textContent = 'اختر نموذجاً أولاً'; return; }
    result.textContent = 'جاري الفحص...';
    const res = await fetch(`/api/model-registry/providers/${draft.providerId}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteId }),
    });
    const body = await res.json();
    result.textContent = body.error ? `تعذر الفحص: ${body.error}` : (body.tools ? 'النموذج استجاب لنداء أداة' : 'النموذج لم ينادِ الأداة');
    if (body.tools === true) dialog.querySelector('#wizard-tools').checked = true;
  };
  dialog.querySelector('#wizard-add-manual').onclick = () => {
    const id = dialog.querySelector('#wizard-manual-id').value.trim();
    let note = dialog.querySelector('#wizard-manual-note');
    if (!note) {
      note = document.createElement('p');
      note.id = 'wizard-manual-note';
      dialog.querySelector('#wizard-manual-id').after(note);
    }
    note.textContent = id ? `سيُضاف: ${id}` : 'اكتب المعرّف أولاً';
  };
  dialog.querySelector('#wizard-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    dialog.querySelectorAll('#discovered-models-list label').forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
  });
  dialog.querySelector('#wizard-back').onclick = () => showStep(Math.max(1, draft.step - 1));
  dialog.querySelector('#wizard-next').onclick = async () => {
    const button = dialog.querySelector('#wizard-next');
    button.disabled = true;
    try {
      if (draft.step === 1) {
        draft.source = selectedSource();
        const preset = WIZARD_PRESETS[draft.source];
        dialog.querySelector('#provider-type').value = preset.kind;
        dialog.querySelector('#provider-label').value = preset.label;
        dialog.querySelector('#provider-url').value = preset.url;
        dialog.querySelector('#provider-url').readOnly = preset.locked && draft.source !== 'custom';
        showStep(2);
      } else if (draft.step === 2) {
        await saveWizardProvider(dialog, draft);
        await loadWizardModels(dialog, draft);
        showStep(3);
      } else if (draft.step === 3) {
        showStep(4);
      } else {
        await finishWizard(dialog, draft);
      }
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = draft.step === 1 && !selectedSource();
    }
  };
  showStep(1);
}

async function saveWizardProvider(dialog, draft) {
  const url = dialog.querySelector('#provider-url').value.trim();
  const key = dialog.querySelector('#provider-key').value;
  const registry = await loadRegistry();
  const duplicate = (registry?.providers || []).some((provider) => provider.baseUrl === url.replace(/\/+$/, ''));
  dialog.querySelector('#wizard-duplicate').hidden = !duplicate;
  if (duplicate) throw new Error('هذا العنوان مضاف مسبقاً');
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
  const cloudHttp = url.startsWith('http://') && !loopback;
  dialog.querySelector('#wizard-http-warning').hidden = !cloudHttp;
  if (cloudHttp && !dialog.querySelector('#wizard-http-ok').checked) throw new Error('وافق على استخدام http للسحابة أو استخدم https');
  const enabled = !(draft.source === 'freellmapi' && dialog.querySelector('#wizard-save-disabled').checked);
  const auth = dialog.querySelector('#provider-auth').value;
  const timeoutMs = Number(dialog.querySelector('#provider-timeout').value);
  const res = await fetch('/api/model-registry/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: dialog.querySelector('#provider-type').value,
      label: dialog.querySelector('#provider-label').value,
      baseUrl: url,
      apiKey: auth === 'key' ? (key || undefined) : undefined,
      envVar: auth === 'env' ? dialog.querySelector('#provider-env').value.trim() : undefined,
      timeoutMs: timeoutMs >= 5000 ? timeoutMs : undefined,
      extraHeaders: headersFromText(dialog.querySelector('#provider-headers').value),
      enabled,
    }),
  });
  const created = await res.json();
  if (!res.ok) throw new Error(created.error || 'فشل حفظ المزود');
  dialog.querySelector('#provider-key').value = '';
  draft.providerId = created.id;
}

async function loadWizardModels(dialog, draft) {
  const list = dialog.querySelector('#discovered-models-list');
  list.textContent = 'جاري الجلب...';
  const res = await fetch(`/api/model-registry/providers/${draft.providerId}/discover`);
  if (!res.ok) {
    dialog.querySelector('#wizard-down').hidden = draft.source !== 'freellmapi';
    list.textContent = 'تعذر جلب القائمة. أدخل المعرّف يدوياً.';
    draft.models = [];
    return;
  }
  const body = await res.json();
  draft.models = body.models || [];
  const registry = await loadRegistry();
  const taken = new Set((registry?.models || []).filter((model) => model.providerId === draft.providerId).map((model) => model.remoteId));
  const row = (model, index) => `<label><input type="checkbox" data-index="${index}" ${taken.has(model.remoteId) ? 'disabled' : ''}> ${model.remoteId}${model.contextWindow ? ` · ${model.contextWindow}` : ''}</label>`;
  const chat = [];
  const other = [];
  draft.models.forEach((model, index) => (/embed/i.test(model.remoteId) ? other : chat).push(row(model, index)));
  list.innerHTML = `${chat.join('')}${other.length ? `<details><summary>نماذج غير محادثة</summary>${other.join('')}</details>` : ''}` || 'لا نماذج. أدخل معرّفاً.';
}

async function finishWizard(dialog, draft) {
  const manual = dialog.querySelector('#wizard-manual-id').value.trim();
  const picked = [...dialog.querySelectorAll('#discovered-models-list input:checked')].map((box) => draft.models[Number(box.dataset.index)]).filter(Boolean);
  if (manual) picked.push({ remoteId: manual });
  if (!picked.length) throw new Error('اختر نموذجاً أو اكتب معرّفه');
  const contextWindow = Number(dialog.querySelector('#wizard-context').value);
  const maxOutput = Number(dialog.querySelector('#wizard-max-output').value);
  const temperature = dialog.querySelector('#wizard-temperature').value;
  const capabilities = {
    tools: dialog.querySelector('#wizard-tools').checked,
    vision: dialog.querySelector('#wizard-vision').checked,
    thinking: dialog.querySelector('#wizard-thinking').value,
    ...(contextWindow > 0 ? { contextWindow } : {}),
    ...(maxOutput > 0 ? { maxOutputTokens: maxOutput } : {}),
  };
  const defaults = temperature === '' ? undefined : { temperature: Number(temperature) };
  const res = await fetch('/api/model-registry/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: draft.providerId, models: picked.map((model) => ({ remoteId: model.remoteId, capabilities, ...(defaults ? { defaults } : {}) })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'فشل حفظ النماذج');
  const ids = (body.models || []).map((model) => model.id);
  if (dialog.querySelector('#wizard-chain').checked && ids.length) {
    const registry = await loadRegistry();
    const chain = (registry?.chains || []).find((item) => item.id === 'default');
    const modelIds = [...(chain?.modelIds || []), ...ids];
    await fetch('/api/model-registry/chains/default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelIds }) });
  }
  if (dialog.querySelector('#wizard-default').checked && ids[0]) {
    await fetch('/api/model-registry/defaults', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultModelId: ids[0], fallbackModelId: null }) });
  }
  dialog.remove();
  const registry = await loadRegistry();
  if (registry) { renderProviders(registry.providers); renderModels(registry.models); renderChains(registry); fillDefaultSelects(registry); }
}

/**
 * Test provider connection.
 */
async function testProviderConnection(dialog = document) {
  const type = dialog.querySelector('#provider-type')?.value;
  const url = dialog.querySelector('#provider-url')?.value;
  const key = dialog.querySelector('#provider-key')?.value;
  const output = dialog.querySelector('#wizard-test');
  if (!type || !url) {
    if (output) output.textContent = 'أدخل النوع والعنوان';
    return;
  }
  if (output) output.textContent = 'جاري الاختبار...';
  try {
    const res = await fetch('/api/model-registry/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: type, baseUrl: url, apiKey: key || undefined }),
    });
    const result = await res.json();
    const down = dialog.querySelector('#wizard-down');
    if (result.success) {
      if (output) output.textContent = `نجح الاتصال. ${result.message || ''}`;
      if (down) down.hidden = true;
    } else {
      if (output) output.textContent = `فشل الاتصال. ${result.error || ''}`;
      if (down && url.includes('31415')) down.hidden = false;
    }
  } catch (error) {
    if (output) output.textContent = `فشل الاتصال. ${error.message}`;
  }
}

/**
 * Show Discover Models dialog.
 */
async function showDiscoverDialog(providerId) {
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">
        <h2>اكتشاف النماذج / Discover Models</h2>
        <button class="btn-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">
        <p>جاري الاتصال بالمزود... / Connecting to provider...</p>
        <div class="loading-spinner"></div>
      </div>
    </div>
  `;
  
  document.body.appendChild(dialog);
  
  try {
    // Call discover API
    const res = await fetch(`/api/model-registry/providers/${providerId}/discover`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    
    const data = await res.json();
    const models = data.models || [];
    
    const body = dialog.querySelector('.modal-body');
    body.innerHTML = `
      <p>تم العثور على ${models.length} نماذج / Found ${models.length} models</p>
      <div class="discovered-models" id="discovered-models-list">
        ${models.map((m, i) => `
          <div class="model-item">
            <label>
              <input type="checkbox" checked data-index="${i}">
              ${m.remoteId || m.id || 'Unknown'}
              ${m.contextWindow ? `<span class="model-context">(${m.contextWindow.toLocaleString()} tokens)</span>` : ''}
            </label>
          </div>
        `).join('')}
      </div>
      <div class="form-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">إلغاء / Cancel</button>
        <button class="btn btn-primary" onclick="addDiscoveredModels('${providerId}', ${JSON.stringify(models).replace(/"/g, '&quot;')})">إضافة / Add Selected</button>
      </div>
    `;
  } catch (error) {
    console.error('[models-settings] Discovery failed:', error);
    const body = dialog.querySelector('.modal-body');
    body.innerHTML = `
      <p class="error">فشل الاكتشاف / Discovery failed</p>
      <p>${error.message}</p>
      <div class="form-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">إغلاق / Close</button>
      </div>
    `;
  }
}

/**
 * Add discovered models to registry.
 */
async function addDiscoveredModels(providerId, allModels) {
  try {
    // Get selected models
    const checkboxes = document.querySelectorAll('#discovered-models-list input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => {
      const idx = parseInt(cb.dataset.index);
      return allModels[idx];
    });
    
    if (selected.length === 0) {
      alert('الرجاء اختيار نموذج واحد على الأقل / Please select at least one model');
      return;
    }
    
    // Send to API
    const res = await fetch('/api/model-registry/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId,
        models: selected,
      }),
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    
    const result = await res.json();
    console.log('[models-settings] Added models:', result);
    
    // Close dialog
    document.querySelector('.modal-overlay').remove();
    
    // Refresh list
    const registry = await loadRegistry();
    if (registry) {
      renderProviders(registry.providers);
      renderModels(registry.models);
    }
  } catch (error) {
    console.error('[models-settings] Failed to add models:', error);
    alert(`فشلت إضافة النماذج / Failed to add models: ${error.message}`);
  }
}

/**
 * Show Edit Provider dialog.
 */
function fillDefaultSelects(registry) {
  const options = ['<option value="">—</option>'].concat((registry.models || []).map((model) => `<option value="${model.id}">${model.label}</option>`)).join('');
  const fallback = document.getElementById('fallback-model');
  const primary = document.getElementById('default-model');
  if (!primary || !fallback) return;
  primary.innerHTML = options;
  fallback.innerHTML = options;
  primary.value = registry.defaultModelId || '';
  fallback.value = registry.fallbackModelId || '';
}

function renderChains(registry) {
  const container = document.getElementById('chains-list');
  if (!container) return;
  const chains = registry.chains || [];
  container.innerHTML = chains.map((chain) => `
    <div class="provider-card" data-chain="${chain.id}">
      <h3>${chain.label || chain.id}</h3>
      <p>اسحب الصف، أو استخدم Alt مع الأسهم.</p>
      <ol>
        ${(chain.modelIds || []).map((id, index) => `<li draggable="true" data-model="${id}" data-index="${index}"><span class="drag-handle">≡</span> ${id}
          <button type="button" class="btn btn-sm" data-move="up" data-chain="${chain.id}" data-index="${index}">أعلى</button>
          <button type="button" class="btn btn-sm" data-move="down" data-chain="${chain.id}" data-index="${index}">أسفل</button>
        </li>`).join('')}
      </ol>
      <label>إضافة نموذج <select data-add-chain="${chain.id}"><option value="">—</option>${(registry.models || []).filter((model) => !(chain.modelIds || []).includes(model.id)).map((model) => `<option value="${model.id}">${model.label}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-sm" data-add="${chain.id}">إضافة للسلسلة</button>
    </div>
  `).join('') || '<div class="empty-state">لا توجد سلاسل</div>';
  container.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const chain = (registry.chains || []).find((item) => item.id === button.dataset.add);
      const select = container.querySelector(`[data-add-chain="${button.dataset.add}"]`);
      if (!chain || !select?.value) return;
      void saveChainOrder(registry, chain.id, [...chain.modelIds, select.value]);
    });
  });
  container.querySelectorAll('[data-move]').forEach((button) => {
    button.addEventListener('click', () => moveChainItem(registry, button.dataset.chain, Number(button.dataset.index), button.dataset.move));
  });
  container.onkeydown = (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const item = event.target.closest('[data-model]');
    if (!item) return;
    const chainId = item.closest('[data-chain]')?.dataset.chain;
    const index = [...item.parentElement.children].indexOf(item);
    moveChainItem(registry, chainId, index, event.key === 'ArrowUp' ? 'up' : 'down');
  };
  let dragged = null;
  container.querySelectorAll('li[data-model]').forEach((row) => {
    row.addEventListener('dragstart', () => { dragged = { chainId: row.closest('[data-chain]').dataset.chain, index: Number(row.dataset.index) }; });
    row.addEventListener('dragover', (event) => event.preventDefault());
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!dragged) return;
      const chainId = row.closest('[data-chain]').dataset.chain;
      const target = Number(row.dataset.index);
      if (dragged.chainId !== chainId || dragged.index === target) return;
      const chain = (registry.chains || []).find((item) => item.id === chainId);
      if (!chain) return;
      const ids = chain.modelIds.slice();
      const [moved] = ids.splice(dragged.index, 1);
      ids.splice(target, 0, moved);
      void saveChainOrder(registry, chainId, ids);
    });
  });
}

async function moveChainItem(registry, chainId, index, direction) {
  const chain = (registry.chains || []).find((item) => item.id === chainId);
  if (!chain) return;
  const next = index + (direction === 'up' ? -1 : 1);
  if (next < 0 || next >= chain.modelIds.length) return;
  const ids = chain.modelIds.slice();
  const [moved] = ids.splice(index, 1);
  ids.splice(next, 0, moved);
  await saveChainOrder(registry, chainId, ids);
}

async function saveChainOrder(registry, chainId, ids) {
  const chain = (registry.chains || []).find((item) => item.id === chainId);
  const res = await fetch(`/api/model-registry/chains/${encodeURIComponent(chainId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelIds: ids }),
  });
  if (!res.ok) { alert((await res.json()).error || 'فشل'); return; }
  if (chain) chain.modelIds = ids;
  renderChains(registry);
}

async function showEditProviderDialog(providerId) {
  const registry = await loadRegistry();
  const provider = registry?.providers?.find((item) => item.id === providerId);
  if (!provider) return;
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header"><h2>تعديل ${provider.label}</h2><button class="btn-close" type="button">✕</button></div>
      <form class="modal-body">
        <label>الاسم <input name="label" value="${provider.label}"></label>
        <label>العنوان <input name="baseUrl" value="${provider.baseUrl}"></label>
        <p>البروتوكول: ${provider.kind}</p>
        <label>المهلة (مللي ثانية) <input name="timeoutMs" type="number" min="5000" value="${provider.timeoutMs || 30000}"></label>
        <label>ترويسات إضافية <textarea name="extraHeaders">${Object.entries(provider.extraHeaders || {}).map(([name, value]) => `${name}: ${value}`).join('\n')}</textarea></label>
        <label>مفتاح جديد <input name="apiKey" type="password" autocomplete="off"></label>
        <button type="button" class="btn" id="toggle-key">إظهار</button>
        <label><input name="enabled" type="checkbox" ${provider.enabled ? 'checked' : ''}> مفعّل</label>
        <label><input name="removeKey" type="checkbox"> إزالة المفتاح</label>
        <button class="btn btn-primary" type="submit">حفظ</button>
        <button class="btn btn-danger" type="button" id="delete-provider">حذف المزود</button>
      </form>
    </div>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.btn-close').onclick = () => dialog.remove();
  const key = dialog.querySelector('[name=apiKey]');
  dialog.querySelector('#toggle-key').onclick = () => { key.type = key.type === 'password' ? 'text' : 'password'; };
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const apiKey = String(data.get('apiKey') || '');
    const res = await fetch(`/api/model-registry/providers/${providerId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: data.get('label'),
        baseUrl: data.get('baseUrl'),
        enabled: data.get('enabled') === 'on',
        timeoutMs: Number(data.get('timeoutMs')) || undefined,
        extraHeaders: headersFromText(data.get('extraHeaders')),
        removeKey: data.get('removeKey') === 'on',
        ...(apiKey ? { apiKey } : {}),
      }),
    });
    key.value = '';
    if (!res.ok) { alert((await res.json()).error || 'فشل'); return; }
    dialog.remove();
    const updated = await loadRegistry();
    if (updated) renderProviders(updated.providers);
  };
  dialog.querySelector('#delete-provider').onclick = () => {
    dialog.remove();
    confirmDeleteProvider(providerId);
  };
}

/**
 * Confirm delete provider.
 */
function confirmDeleteProvider(providerId) {
  if (confirm('هل أنت متأكد من حذف هذا المزود؟ / Are you sure you want to delete this provider?')) {
    deleteProvider(providerId);
  }
}

/**
 * Delete provider.
 */
async function deleteProvider(providerId) {
  try {
    const res = await fetch(`/api/model-registry/providers/${providerId}`, {
      method: 'DELETE',
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    
    console.log('[models-settings] Deleted provider:', providerId);
    
    // Refresh list
    const registry = await loadRegistry();
    if (registry) {
      renderProviders(registry.providers);
      renderModels(registry.models);
    }
  } catch (error) {
    console.error('[models-settings] Failed to delete provider:', error);
    alert(`فشل الحذف / Delete failed: ${error.message}`);
  }
}

async function showEditModelDialog(modelId) {
  const registry = await loadRegistry();
  const model = registry?.models?.find((item) => item.id === modelId);
  if (!model) return;
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header"><h2>تعديل النموذج</h2><button class="btn-close" type="button">✕</button></div>
      <form class="modal-body">
        <p>المعرّف البعيد: ${model.remoteId}</p>
        <label>الاسم <input name="label" value="${model.label}"></label>
        <label><input name="enabled" type="checkbox" ${model.enabled ? 'checked' : ''}> مفعّل</label>
        <label><input name="tools" type="checkbox" ${model.capabilities?.tools === true ? 'checked' : ''}> أدوات</label>
        <label><input name="vision" type="checkbox" ${model.capabilities?.vision === true ? 'checked' : ''}> رؤية</label>
        <label>التفكير <select name="thinking"><option value="unknown">غير معروف</option><option value="none">بدون</option><option value="toggle">قابل للتبديل</option><option value="always">دائماً</option></select></label>
        <label>النافذة <input name="contextWindow" type="number" min="1" value="${model.capabilities?.contextWindow || ''}"></label>
        <label>أقصى إخراج <input name="maxOutputTokens" type="number" min="1" value="${model.capabilities?.maxOutputTokens || ''}"></label>
        <label>الحرارة <input name="temperature" type="number" min="0" max="2" step="0.1" value="${model.defaults?.temperature ?? ''}"></label>
        <label>الوسوم <input name="tags" value="${(model.tags || []).join(', ')}"></label>
        <label>طلبات/دقيقة <input name="rpm" type="number" min="1" value="${model.limits?.rpm || ''}"></label>
        <label>طلبات/يوم <input name="rpd" type="number" min="1" value="${model.limits?.rpd || ''}"></label>
        <label>رموز/دقيقة <input name="tpm" type="number" min="1" value="${model.limits?.tpm || ''}"></label>
        <label>رموز/يوم <input name="tpd" type="number" min="1" value="${model.limits?.tpd || ''}"></label>
        <button type="button" class="btn" id="probe-model">فحص الأدوات</button>
        <p id="probe-model-result"></p>
        <label>استبدال عند الحذف <select name="replacement"><option value="">—</option>${(registry.models || []).filter((item) => item.id !== model.id).map((item) => `<option value="${item.id}">${item.label}</option>`).join('')}</select></label>
        <button class="btn btn-primary" type="submit">حفظ</button>
        <button class="btn btn-danger" type="button" id="delete-model">حذف</button>
      </form>
    </div>`;
  document.body.appendChild(dialog);
  dialog.querySelector('[name=thinking]').value = model.capabilities?.thinking || 'unknown';
  dialog.querySelector('.btn-close').onclick = () => dialog.remove();
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const res = await fetch(`/api/model-registry/models/${encodeURIComponent(model.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: data.get('label'),
        enabled: data.get('enabled') === 'on',
        tags: String(data.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
        capabilities: {
          tools: data.get('tools') === 'on',
          vision: data.get('vision') === 'on',
          thinking: data.get('thinking'),
          ...(Number(data.get('contextWindow')) > 0 ? { contextWindow: Number(data.get('contextWindow')) } : {}),
          ...(Number(data.get('maxOutputTokens')) > 0 ? { maxOutputTokens: Number(data.get('maxOutputTokens')) } : {}),
        },
        ...(data.get('temperature') !== '' ? { defaults: { temperature: Number(data.get('temperature')) } } : {}),
        limits: { rpm: Number(data.get('rpm')) || undefined, rpd: Number(data.get('rpd')) || undefined, tpm: Number(data.get('tpm')) || undefined, tpd: Number(data.get('tpd')) || undefined },
      }),
    });
    if (!res.ok) { alert((await res.json()).error || 'فشل'); return; }
    dialog.remove();
    const updated = await loadRegistry();
    if (updated) renderModels(updated.models);
  };
  dialog.querySelector('#probe-model').onclick = async () => {
    const result = dialog.querySelector('#probe-model-result');
    result.textContent = 'جاري الفحص...';
    const res = await fetch(`/api/model-registry/models/${encodeURIComponent(model.id)}/probe`, { method: 'POST' });
    const body = await res.json();
    result.textContent = body.error ? `تعذر الفحص: ${body.error}` : (body.tools ? 'النموذج استجاب لنداء أداة' : 'النموذج لم ينادِ الأداة');
    if (body.tools === true) dialog.querySelector('[name=tools]').checked = true;
  };
  dialog.querySelector('#delete-model').onclick = async () => {
    if (!confirm('حذف هذا النموذج؟')) return;
    const replacementId = dialog.querySelector('[name=replacement]').value || null;
    const res = await fetch(`/api/model-registry/models/${encodeURIComponent(model.id)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replacementId }),
    });
    if (!res.ok) { alert((await res.json()).error || 'فشل'); return; }
    dialog.remove();
    const updated = await loadRegistry();
    if (updated) { renderModels(updated.models); renderChains(updated); fillDefaultSelects(updated); }
  };
}

window.showDiscoverDialog = showDiscoverDialog;
window.showEditProviderDialog = showEditProviderDialog;
window.confirmDeleteProvider = confirmDeleteProvider;
