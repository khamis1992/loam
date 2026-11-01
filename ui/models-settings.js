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
      <div class="provider-actions">
        <button class="btn btn-sm" onclick="showDiscoverDialog('${p.id}')">اكتشاف / Discover</button>
        <button class="btn btn-sm" onclick="showEditProviderDialog('${p.id}')">تعديل / Edit</button>
        <button class="btn btn-sm btn-danger" onclick="confirmDeleteProvider('${p.id}')">حذف / Delete</button>
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
    addBtn.addEventListener('click', () => showAddProviderDialog());
  }
}

/**
 * Show Add Provider dialog.
 */
function showAddProviderDialog() {
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">
        <h2>${T.addProvider}</h2>
        <button class="btn-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <form id="add-provider-form" class="modal-body">
        <div class="form-group">
          <label>نوع المزود / Provider Type</label>
          <select id="provider-type" required>
            <option value="">اختر / Select...</option>
            <option value="ollama">Ollama (محلي / Local)</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini</option>
            <option value="lmstudio">LM Studio</option>
            <option value="llamacpp">llama.cpp server</option>
            <option value="custom">مخصص / Custom</option>
          </select>
        </div>
        
        <div class="form-group">
          <label>الاسم / Label</label>
          <input type="text" id="provider-label" required placeholder="My Provider">
        </div>
        
        <div class="form-group">
          <label>عنوان URL الأساسي / Base URL</label>
          <input type="url" id="provider-url" required placeholder="https://api.example.com/v1">
        </div>
        
        <div class="form-group">
          <label>مفتاح API / API Key <span class="optional">(اختياري / optional)</span></label>
          <input type="password" id="provider-key" placeholder="sk-...">
        </div>
        
        <div class="form-group">
          <label>
            <input type="checkbox" id="provider-enabled" checked>
            مفعّل / Enabled
          </label>
        </div>
        
        <div class="form-actions">
          <button type="button" class="btn" onclick="this.closest('.modal-overlay').remove()">إلغاء / Cancel</button>
          <button type="button" class="btn" onclick="testProviderConnection()">اختبار / Test Connection</button>
          <button type="submit" class="btn btn-primary">حفظ / Save</button>
        </div>
      </form>
    </div>
  `;
  
  document.body.appendChild(dialog);
  
  // Handle type change to update URL
  const typeSelect = dialog.querySelector('#provider-type');
  const urlInput = dialog.querySelector('#provider-url');
  typeSelect.addEventListener('change', (e) => {
    const presets = {
      ollama: 'http://127.0.0.1:11434',
      openai: 'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic: 'https://api.anthropic.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      lmstudio: 'http://127.0.0.1:1234/v1',
      llamacpp: 'http://127.0.0.1:8080/v1',
    };
    if (presets[e.target.value]) {
      urlInput.value = presets[e.target.value];
    }
  });
  
  // Handle form submit
  const form = dialog.querySelector('#add-provider-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const type = dialog.querySelector('#provider-type').value;
    const label = dialog.querySelector('#provider-label').value;
    const url = dialog.querySelector('#provider-url').value;
    const key = dialog.querySelector('#provider-key').value;
    const enabled = dialog.querySelector('#provider-enabled').checked;
    
    try {
      // Send to API
      const res = await fetch('/api/model-registry/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: type,
          label,
          baseUrl: url,
          apiKey: key || undefined,
          enabled,
        }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      
      const created = await res.json();
      console.log('[models-settings] Provider created:', created);
      
      dialog.remove();
      
      // Refresh the list
      const registry = await loadRegistry();
      if (registry) {
        renderProviders(registry.providers);
        renderModels(registry.models);
      }
    } catch (error) {
      console.error('[models-settings] Failed to add provider:', error);
      alert(`Failed to add provider: ${error.message}`);
    }
  });
}

/**
 * Test provider connection.
 */
async function testProviderConnection() {
  const type = document.getElementById('provider-type').value;
  const url = document.getElementById('provider-url').value;
  const key = document.getElementById('provider-key').value;
  
  if (!type || !url) {
    alert('الرجاء إدخال النوع وعنوان URL / Please enter type and URL');
    return;
  }
  
  try {
    const res = await fetch('/api/model-registry/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: type,
        baseUrl: url,
        apiKey: key || undefined,
      }),
    });
    
    const result = await res.json();
    
    if (result.success) {
      alert(`✓ نجح الاتصال / Connection successful\n\n${result.message || ''}`);
    } else {
      alert(`✗ فشل الاتصال / Connection failed\n\n${result.error || 'Unknown error'}`);
    }
  } catch (error) {
    alert(`✗ فشل الاتصال / Connection failed\n\n${error.message}`);
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
function showEditProviderDialog(providerId) {
  alert(`Edit provider ${providerId} - TODO`);
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
