export default async function accept(page) {
  await page.waitForSelector('#files .file-row');
  await page.fill('#search', 'notes');
  await page.waitForFunction(() => document.querySelectorAll('#files .file-row').length === 1);
  await page.fill('#tag-input', 'important');
  await page.click('#tag-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Tag added.');
  await page.fill('#tag-filter', 'important');
  await page.waitForFunction(() => document.querySelectorAll('#files .file-row').length === 1);
  return { tagged: true };
}
