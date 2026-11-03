'use strict';
/**
 * Runs the real Mochi backend (service.cjs) on the invented data in examples/
 * and drives the real interface in Chromium, without Electron.
 * Used for README screenshots and for the interface smoke test.
 *
 *   node scripts/demo-browser.cjs OUT_DIR
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createService } = require('../app/service.cjs');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'screenshots');

const METHODS = {
  overview: 'overview', selectDroppedKross: 'selectKross', runKross: 'runKross', latestKrossReport: 'latestKrossReport',
  confirmKrossCancellation: 'confirmKrossCancellation', generateReceipt: 'generateReceipt',
  suggestReceiptNumber: 'suggestReceiptNumber', lookupReceiptBooking: 'lookupReceiptBooking', taxLoad: 'taxLoad',
  taxSaveStay: 'taxSaveStay', taxQuickConfirm: 'taxQuickConfirm', taxSaveCoverage: 'taxSaveCoverage',
  taxExcludeStay: 'taxExcludeStay', taxExport: 'taxExport', cleaningLoad: 'cleaningLoad',
  cleaningSetExcluded: 'cleaningSetExcluded', krossColorsLoad: 'krossColorsLoad', krossColorsApply: 'krossColorsApply',
  profileDetails: 'profileDetails', saveProfile: 'saveProfile', checkGoogleConnection: 'checkGoogleConnection',
};

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-demo-'));
  fs.cpSync(path.join(root, 'examples'), path.join(work, 'examples'), { recursive: true });
  const python = process.env.MOCHI_PYTHON || (process.platform === 'win32' ? 'python' : '/usr/bin/python3');
  const service = createService({
    appDir: root, dataDir: path.join(work, 'data'), outputDir: path.join(work, 'ricevute'),
    profilePath: path.join(work, 'examples', 'receipt-profiles.json'),
    runtimeDefaults: { krossBase: path.join(work, 'examples', 'calendari'), alloggiatiState: path.join(work, 'alloggiati'),
      nodePath: process.execPath, pythonPath: python, powershellPath: path.join(work, 'powershell.exe') },
  });
  await service.initialize({ inspect: false });
  await service.selectKross(path.join(work, 'examples', 'kross-export-esempio.xlsx'));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1020, height: 760 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => console.error('page error:', error.message));
  await page.exposeFunction('__mochi', async (name, args) => {
    const fn = service[METHODS[name]];
    if (typeof fn !== 'function') return { ok: false, error: 'Non disponibile nella demo.' };
    return fn.apply(service, args);
  });
  await page.addInitScript(names => {
    const api = {};
    for (const name of names) api[name] = (...args) => window.__mochi(name, args);
    Object.assign(api, {
      chooseKross: () => window.__mochi('overview', []).then(() => ({ ok: true })),
      chooseKrossFolder: async () => ({ ok: false, canceled: true }), runAlloggiati: async () => ({ ok: false, error: 'Non disponibile nella demo.' }),
      reconnectGoogle: async () => ({ ok: false }), cancelGoogleConnection: async () => ({ ok: true }),
      openOutput: async () => ({ ok: true }), openFolder: async () => ({ ok: true }), openAlloggiatiFolder: async () => ({ ok: true }),
      minimize() {}, close() {}, resize() {}, onProgress: () => () => {},
    });
    window.mochi = api;
  }, Object.keys(METHODS));
  fs.mkdirSync(out, { recursive: true });
  await page.goto('file://' + path.join(root, 'app', 'ui', 'index.html'));
  await page.waitForTimeout(1500);
  const shot = name => page.screenshot({ path: path.join(out, name + '.png'), omitBackground: true });
  const open = async module => { await page.click(`[data-module="${module}"]`); await page.waitForTimeout(900); };
  const back = async () => { await page.keyboard.press('Escape'); await page.click('.mp-b, [data-action="back"]').catch(() => {}); await page.waitForTimeout(500); };
  await shot('home');
  await open('calendari');
  await page.click('[data-action="simulate"]');
  await page.waitForFunction(() => !document.querySelector('[data-action="simulate"]')?.disabled
    && /simulazione|aggiorn|cambi/i.test(document.querySelector('[data-result="calendari"]')?.textContent || ''), null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await shot('calendari');
  await page.goto('file://' + path.join(root, 'app', 'ui', 'index.html')); await page.waitForTimeout(1200);
  await open('ricevuta'); await page.waitForTimeout(800); await shot('ricevuta');
  await page.goto('file://' + path.join(root, 'app', 'ui', 'index.html')); await page.waitForTimeout(1200);
  await open('tasse'); await page.waitForTimeout(2500); await shot('tasse');
  await page.goto('file://' + path.join(root, 'app', 'ui', 'index.html')); await page.waitForTimeout(1200);
  await open('pulizie'); await page.waitForTimeout(2500); await shot('pulizie');
  await browser.close();
  console.log('screenshots in', out);
}

main().catch(error => { console.error(error); process.exit(1); });
