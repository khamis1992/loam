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
      </div>
      <div class="provider-meta">
        <span class="provider-kind">${p.kind}</span>
        <span class="provider-url">${p.baseUrl}</span>
      </div>
    </div>
  `).join('');

  container.innerHTML = html;
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
        ${m.capabilities.contextWindow ? `<span>${m.capabilities.contextWindow.toLocaleString()} tokens</span>` : ''}
      </div>
    </div>
  `).join('');

  container.innerHTML = html;
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
          <button id="refresh-btn" class="btn">${T.refresh}</button>
        </header>
        
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

  // Wire up refresh button
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await fetch('/api/model-registry/reload', { method: 'POST' });
      const updated = await loadRegistry();
      if (updated) {
        renderProviders(updated.providers);
        renderModels(updated.models);
      }
    });
  }

  // Wire up add provider button
  const addBtn = document.getElementById('add-provider-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      alert('Add provider dialog (Phase 6b)');
    });
  }
}
