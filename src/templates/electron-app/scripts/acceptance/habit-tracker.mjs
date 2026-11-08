export default async function accept(page) {
  await page.waitForSelector('#habit-form');
  await page.fill('#habit-name', 'Read for 20 minutes');
  await page.click('#habit-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#habits .habit-row').length === 1);
  await page.click('.complete-habit');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Completed. Streak: 1 day.');
  return { habitCompleted: true, streak: 1 };
}
