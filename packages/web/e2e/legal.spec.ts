import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Document, Packer, Paragraph } from 'docx';
import { startMockServer, type MockServer } from '../../../src/scripts/legal-mock-server';
import { StaticKeyProvider } from '../../../src/legal/crypto';
import { fillAvids } from '../../../src/legal/__tests__/helpers';
import type { LegalModelPort } from '../../../src/legal/model/types';

let srv: MockServer;
let dataDir: string;
let modelDelegate: LegalModelPort;
const keys = new StaticKeyProvider(crypto.randomBytes(32));

async function proxyLegalApi(page: Page): Promise<void> {
  await page.route('**/api/legal**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${srv.url}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), 'x-loam-local-token': srv.token },
    });
    await route.fulfill({ response });
  });
}

test.beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-workspace-e2e-'));
  srv = await startMockServer(0, 'legal-e2e-token', undefined, { dataDir, keys });
  srv.ctx.model.port = (req) => modelDelegate(req);
  modelDelegate = async (req) => {
    const contract = (req as typeof req & { contract?: string }).contract ?? '';
    let value: unknown;
    if (contract.startsWith('contract-analysis:') || contract === 'legal-adversarial-review') value = { findings: [] };
    else if (contract === 'legal-document-analysis') value = { summary: 'ملخص اختباري مرتبط بالمستند المرفوع.', obligations: [], risks: [], missingInformation: [], questions: [] };
    else if (contract === 'defense-case-theory') value = {
      summary: 'الدفاع بعدم استحقاق التعويض الاتفاقي',
      pleas: [{ id: 'penalty', type: 'substantive', title: 'التعويض الاتفاقي مبالغ فيه', factIds: [], researchQueries: ['المادة 3 من القانون المدني الاختباري'], priority: 1 }],
      primaryRequests: ['تخفيض التعويض'], alternativeRequests: ['رفض المطالبة'], weaknesses: ['يلزم إثبات المبالغة'], unresolvedQuestions: [],
    };
    else if (contract === 'legal-response-allegations') value = {
      entries: [{ id: 'a1', allegation: 'استحقاق التعويض كاملاً', sourceQuote: 'استحقاق التعويض كاملاً', kind: 'legal', disposition: 'explain', evidenceFactIds: [], researchQueries: ['المادة 3 من القانون المدني الاختباري'], response: 'التعويض قابل للتخفيض', attachments: [], needsClientDecision: false }],
      unresolvedQuestions: [],
    };
    else if (contract.startsWith('legal-research:')) value = {
      claims: [{ id: contract.slice('legal-research:'.length), text: 'يجوز تخفيض التعويض', support: 'supported', authorityAvids: ['QL-3bacb8d64e'], evidenceFactIds: [], exceptions: [], reason: 'النص يجيز التخفيض' }],
    };
    else if (contract === 'defense-memo-draft' || contract === 'legal-response-draft') value = {
      markdown: `## بيانات الدعوى\nالدائرة المدنية — الدعوى 1/2092\n## الوقائع\nثبت بالمستندات أن التعويض الاتفاقي محل نزاع.\n## الدفاع الموضوعي\n${fillAvids('«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2091-07-01}}⟧')}\n## الطلبات\nأصلياً: تخفيض التعويض.`,
    };
    else throw new Error(`unexpected contract ${contract}`);
    return { content: JSON.stringify(value), model: req.model, usage: { promptTokens: 1, completionTokens: 1 } };
  };
  const verifiedAt = new Date().toISOString();
  srv.ctx.corpus.db.prepare('UPDATE legislations SET source_json=json_set(source_json,\'$.verifiedAt\',?)').run(verifiedAt);
  srv.ctx.corpus.setCoverageManifest([{ legKey: 'law/2090/1', titleAr: 'القانون المدني الاختباري', requiredFor: ['contract_review', 'research', 'defense_memo'] }]);
});

test.afterAll(async () => {
  await srv.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('matter, evidence, document analysis, redline and exact approved download', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await proxyLegalApi(page);
  await page.goto('/legal', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Matter title').fill('مسألة E2E اصطناعية');
  await page.getByLabel('Applicable law date').fill('2092-01-01');
  await page.locator('select').selectOption('contract_review');
  const createResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/legal/matters', { timeout: 5000 });
  await page.getByRole('button', { name: 'New matter' }).click();
  const created = await createResponse.catch(async (error: unknown) => { console.log('E2E body', await page.locator('body').innerText()); throw error; });
  expect(created.status()).toBe(201);
  await page.getByRole('link', { name: /مسألة E2E اصطناعية/ }).click();
  await expect(page).toHaveURL(/\/legal\/matter\?id=mt-/);

  await page.locator('input[type=file]').first().setInputFiles({
    name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('المبلغ 1000 ريال بتاريخ 2024/01/15.', 'utf8'),
  });
  await page.getByRole('tab', { name: 'evidence', exact: true }).click();
  await expect(page.getByText('evidence.txt', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1000', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Analyze documents' }).click();
  await page.getByRole('button', { name: 'Approve lawyer review' }).click();
  await page.getByRole('tab', { name: 'analysis', exact: true }).click();
  await expect(page.getByText('ملخص اختباري مرتبط بالمستند المرفوع.')).toBeVisible();

  const citation = fillAvids('«يجب تنفيذ العقد طبقاً لما اشتمل عليه وبطريقة تتفق مع ما يوجبه حسن النية.» ⟦cite:{{law/2090/1:body:4@2090-04-01}}⟧');
  const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(`البند 1\nيلتزم الطرفان بحسن النية. ${citation}`)] }] }));
  await page.getByRole('tab', { name: 'contract', exact: true }).click();
  await page.locator('input[accept=".docx,.txt,.md"]').setInputFiles({ name: 'contract.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: original });
  await page.getByRole('button', { name: 'Review contract' }).click();
  await page.getByRole('button', { name: 'Approve lawyer review' }).click();
  await expect(page.getByRole('button', { name: 'Create redline' })).toBeVisible();
  const redlineResponse = page.waitForResponse((response) => response.url().includes('/redline') && response.status() === 200);
  await page.getByRole('button', { name: 'Create redline' }).click();
  const redline = await (await redlineResponse).json() as { dataBase64: string };
  await page.getByRole('button', { name: 'Verify artifact' }).click();
  await expect(page.getByText('verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send to lawyer review' }).click();
  await page.getByPlaceholder('Reviewing lawyer').fill('مراجع E2E');
  await page.getByPlaceholder('Licence number').fill('QA-E2E');
  await page.getByPlaceholder('Lawyer comment').fill('تعليق E2E على الفقرة');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('تعليق E2E على الفقرة', { exact: true })).toBeVisible();
  const packageEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download internal review package' }).click();
  const reviewDownload = await packageEvent;
  const reviewPath = await reviewDownload.path();
  if (!reviewPath) throw new Error('review package has no local path');
  const reviewBundle = JSON.parse(await fs.readFile(reviewPath, 'utf8')) as { internal: boolean; review: { comments: unknown[]; decisions: unknown[] } };
  expect(reviewBundle.internal).toBe(true);
  expect(reviewBundle.review.comments).toHaveLength(1);
  expect(reviewBundle.review.decisions).toHaveLength(1);
  await reviewDownload.saveAs(testInfo.outputPath('internal-review.json'));
  const approvalResponse = page.waitForResponse((response) => response.url().includes('/approve-artifact') && response.status() === 200);
  await page.getByRole('button', { name: 'Approve this exact artifact' }).click();
  const approval = await (await approvalResponse).json() as { artifact: { dataBase64: string } };
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export approved DOCX' }).click();
  const download = await downloadEvent;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('download has no local path');
  const downloaded = await fs.readFile(downloadPath);
  expect(downloaded.equals(Buffer.from(approval.artifact.dataBase64, 'base64'))).toBe(true);
  expect(downloaded.equals(Buffer.from(redline.dataBase64, 'base64'))).toBe(false);
  await download.saveAs(testInfo.outputPath('approved-redline.docx'));
});

test('defense, legal response and persisted evidence after reopening a matter', async ({ page }) => {
  test.setTimeout(60_000);
  await proxyLegalApi(page);
  await page.goto('/legal', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Matter title').fill('دعوى E2E اصطناعية');
  await page.getByLabel('Applicable law date').fill('2092-01-01');
  await page.locator('select').selectOption('defense_memo');
  await page.getByRole('button', { name: 'New matter' }).click();
  await page.getByRole('link', { name: /دعوى E2E اصطناعية/ }).click();
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/documents'));
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'defense-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('ثبت بالمستندات أن التعويض الاتفاقي محل نزاع بتاريخ 2091/12/01.', 'utf8'),
  });
  expect((await uploadResponse).status()).toBe(201);
  const model = srv.ctx.model.port;
  await srv.close();
  srv = await startMockServer(0, 'legal-e2e-token', undefined, { dataDir, keys });
  srv.ctx.model.port = model;
  const verifiedAt = new Date().toISOString();
  srv.ctx.corpus.db.prepare('UPDATE legislations SET source_json=json_set(source_json,\'$.verifiedAt\',?)').run(verifiedAt);
  srv.ctx.corpus.setCoverageManifest([{ legKey: 'law/2090/1', titleAr: 'القانون المدني الاختباري', requiredFor: ['contract_review', 'research', 'defense_memo'] }]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'evidence', exact: true }).click();
  await expect(page.getByText('defense-evidence.txt', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Build defense' }).click();
  await page.getByRole('button', { name: 'Approve strategy' }).click();
  await page.getByRole('button', { name: 'Approve lawyer review' }).click();
  await page.getByRole('tab', { name: 'defense', exact: true }).click();
  await expect(page.getByText('الدفاع بعدم استحقاق التعويض الاتفاقي', { exact: true })).toBeVisible();
  await expect(page.getByText('التعويض الاتفاقي مبالغ فيه', { exact: true })).toBeVisible();
  await expect(page.getByText(/## الدفاع الموضوعي/)).toBeVisible();
  const modelAfterDefense = srv.ctx.model.port;
  await srv.close();
  srv = await startMockServer(0, 'legal-e2e-token', undefined, { dataDir, keys });
  srv.ctx.model.port = modelAfterDefense;
  const verifiedAfterDefense = new Date().toISOString();
  srv.ctx.corpus.db.prepare('UPDATE legislations SET source_json=json_set(source_json,\'$.verifiedAt\',?)').run(verifiedAfterDefense);
  srv.ctx.corpus.setCoverageManifest([{ legKey: 'law/2090/1', titleAr: 'القانون المدني الاختباري', requiredFor: ['contract_review', 'research', 'defense_memo'] }]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'defense', exact: true }).click();
  await expect(page.getByText('الدفاع بعدم استحقاق التعويض الاتفاقي', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'response', exact: true }).click();
  await page.getByPlaceholder('Paste the opposing memorandum or legal letter').fill('استحقاق التعويض كاملاً');
  await page.getByRole('button', { name: 'Build legal response' }).click();
  await page.getByRole('button', { name: 'Approve strategy' }).click();
  await page.getByRole('button', { name: 'Approve lawyer review' }).click();
  await expect(page.getByRole('cell', { name: 'استحقاق التعويض كاملاً', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'التعويض قابل للتخفيض', exact: true })).toBeVisible();
  await expect(page.getByText(/## الدفاع الموضوعي/)).toBeVisible();
});

test('a running model call can be cancelled and explicitly resumed', async ({ page }) => {
  const baseModel = modelDelegate;
  modelDelegate = async (req) => {
    if ((req as typeof req & { contract?: string }).contract === 'defense-case-theory') {
      return new Promise((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return baseModel(req);
  };
  try {
    await proxyLegalApi(page);
    await page.goto('/legal', { waitUntil: 'networkidle' });
    await page.getByPlaceholder('Matter title').fill('إلغاء E2E');
    await page.getByLabel('Applicable law date').fill('2092-01-01');
    await page.locator('select').selectOption('defense_memo');
    await page.getByRole('button', { name: 'New matter' }).click();
    await page.getByRole('link', { name: /إلغاء E2E/ }).click();
    await page.getByRole('button', { name: 'Build defense' }).click();
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByRole('status')).toContainText('cancelled');
    modelDelegate = baseModel;
    await page.getByRole('button', { name: 'Resume run' }).click();
    await expect(page.getByRole('button', { name: 'Approve strategy' })).toBeVisible();
  } finally {
    modelDelegate = baseModel;
  }
});

test('legal home supports Arabic, English, light and dark without horizontal overflow', async ({ browser }, testInfo) => {
  for (const locale of ['ar', 'en'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ baseURL: 'http://localhost:3000', viewport: { width: 1280, height: 900 }, colorScheme: theme });
      await context.addInitScript(({ locale: selectedLocale, theme: selectedTheme }) => {
        window.localStorage.setItem('agent-studio:locale', selectedLocale);
        window.localStorage.setItem('agent-studio:theme', selectedTheme);
        (window as unknown as { __FORCE_LOCALE__: string }).__FORCE_LOCALE__ = selectedLocale;
      }, { locale, theme });
      const page = await context.newPage();
      await proxyLegalApi(page);
      await page.goto('/legal', { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('html')).toHaveClass(new RegExp(`(?:^|\\s)${theme}(?:\\s|$)`));
      await expect(page.locator('main')).toHaveCSS('direction', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByRole('button', { name: locale === 'ar' ? 'مسألة جديدة' : 'New matter' })).toBeVisible();
      const contrast = await page.locator('select').evaluate((element) => {
        const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const luminance = (rgb: number[]) => {
          const values = rgb.map((channel) => { const normalized = channel / 255; return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; });
          return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(channels(style.color));
        const background = luminance(channels(style.backgroundColor));
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`legal-${locale}-${theme}.png`), fullPage: true });
      await context.close();
    }
  }
});
