export default async function accept(page) {
  await page.waitForSelector('#scan-photos');
  await page.click('#scan-photos');
  await page.waitForFunction(() => document.querySelectorAll('#photos .photo-row').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('#photos .duplicate').length === 1);
  await page.click('#sort-photos');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Sorted 3 photos into the local sorted folder.');
  return { photos: 3, duplicates: 1, sorted: 3 };
}
