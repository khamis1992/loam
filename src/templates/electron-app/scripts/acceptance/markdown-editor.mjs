export default async function accept(page) {
  await page.waitForSelector('#markdown-input');
  await page.fill('#markdown-input', '# Loam notes\n\n**Offline** editor with `safe` preview.');
  await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Loam notes');
  await page.waitForFunction(() => document.querySelector('#preview strong')?.textContent === 'Offline');
  await page.click('#save-document');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Document saved locally.');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#markdown-input')?.value.includes('# Loam notes'));
  return { markdownSaved: true, previewRendered: true };
}
