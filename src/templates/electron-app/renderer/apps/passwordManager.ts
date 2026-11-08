import { element, errorStatus, page, status } from '../dom.js';
import type { DesktopApi, SecretRecord } from '../types.js';

export function initPasswordManager(desktop: DesktopApi): void {
  page('Loam Password Manager', 'Encrypted local secrets protected by this Windows user account.', `
    <section id="vault-locked" class="workspace vault-locked"><h2>Your vault is locked</h2><p class="muted">Unlock it to add or reveal secrets.</p><button id="vault-unlock" type="button">Unlock vault</button><p id="status" class="status" role="status"></p></section>
    <section id="vault-open" class="workspace" hidden>
      <div class="list-heading"><h2>Saved secrets</h2><button id="vault-lock" class="secondary" type="button">Lock vault</button></div>
      <div id="vault-records"></div><p id="secret-output" class="muted" aria-live="polite"></p>
      <form id="vault-form" class="form-grid">
        <label>Service<input id="vault-service" maxlength="100" required placeholder="Example service"></label>
        <label>Username<input id="vault-username" maxlength="160" required placeholder="you@example.com"></label>
        <label>Secret<input id="vault-secret" type="password" maxlength="500" required></label>
        <button type="submit">Add secret</button>
      </form>
    </section>`);

  const locked = element<HTMLElement>('#vault-locked');
  const open = element<HTMLElement>('#vault-open');
  const output = element<HTMLParagraphElement>('#secret-output');

  function row(record: SecretRecord): HTMLElement {
    const row = document.createElement('article');
    row.className = 'vault-row';
    const service = document.createElement('strong');
    service.textContent = record.service;
    const username = document.createElement('span');
    username.textContent = record.username;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'secondary reveal-secret';
    reveal.textContent = 'Reveal';
    reveal.addEventListener('click', async () => {
      try { output.textContent = `${record.service}: ${await desktop.revealSecret(record.id)}`; } catch (error) { errorStatus(error); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      try { render(await desktop.removeSecret(record.id)); output.textContent = ''; } catch (error) { errorStatus(error); }
    });
    actions.append(reveal, remove);
    row.append(service, username, actions);
    return row;
  }

  function render(records: SecretRecord[]): void {
    element<HTMLDivElement>('#vault-records').replaceChildren(...records.map(row));
  }

  element<HTMLButtonElement>('#vault-unlock').addEventListener('click', async () => {
    try {
      await desktop.unlockVault();
      locked.hidden = true;
      open.hidden = false;
      render(await desktop.listSecrets());
    } catch (error) { errorStatus(error); }
  });
  element<HTMLButtonElement>('#vault-lock').addEventListener('click', async () => {
    await desktop.lockVault();
    output.textContent = '';
    element<HTMLInputElement>('#vault-secret').value = '';
    open.hidden = true;
    locked.hidden = false;
  });
  element<HTMLFormElement>('#vault-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const secret = element<HTMLInputElement>('#vault-secret');
      render(await desktop.addSecret({
        service: element<HTMLInputElement>('#vault-service').value,
        username: element<HTMLInputElement>('#vault-username').value,
        secret: secret.value,
      }));
      secret.value = '';
      status('Secret encrypted and saved.');
    } catch (error) { errorStatus(error); }
  });
}
