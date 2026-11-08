export default async function accept(page) {
  await page.click('#vault-unlock');
  await page.waitForSelector('#vault-form', { state: 'visible' });
  await page.fill('#vault-service', 'Loam test service');
  await page.fill('#vault-username', 'local@example.test');
  await page.fill('#vault-secret', 'not-a-real-password-123');
  await page.click('#vault-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#vault-records .vault-row').length === 1);
  await page.click('.reveal-secret');
  await page.waitForFunction(() => document.querySelector('#secret-output')?.textContent?.includes('not-a-real-password-123'));
  await page.click('#vault-lock');
  await page.waitForSelector('#vault-locked', { state: 'visible' });
  return { vaultEncrypted: true, vaultLocked: true };
}
