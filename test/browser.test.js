'use strict';
// Drives the built page in a real browser and checks it produces the same
// numbers as the CLI. The page runs the same lib/ modules, but through a
// different file-reading path (DecompressionStream rather than zlib), so this
// is what proves the two stay in step.
//
// Skipped when Playwright or a built page is unavailable.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const fs     = require('node:fs');

const ROOT     = path.join(__dirname, '..');
const PAGE     = path.join(ROOT, 'dist', 'weekly-report.html');
const PERIODIC = path.join(__dirname, 'fixtures', 'periodic-sample.csv');
const LEDGER   = path.join(__dirname, 'fixtures', 'ledger-sample.csv');

function loadPlaywright() {
  for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(id); } catch { /* try the next */ }
  }
  return null;
}

const playwright = loadPlaywright();
const reason = !playwright ? 'Playwright not installed'
  : !fs.existsSync(PAGE) ? 'dist/weekly-report.html not built (run: npm run build)'
  : null;
// node:test treats a present `skip` key as a skip whatever its value, so the
// option has to be absent entirely when the test should run.
const skipOpts = reason ? { skip: reason } : {};

test('the page produces the same report as the CLI', skipOpts, async () => {
  const { loadRows }          = require('../lib/load');
  const { readFile }          = require('../lib/sheet');
  const { buildWeeklyReport } = require('../lib/weekly');

  // What the CLI computes, from the same two fixtures.
  const merged = loadRows([PERIODIC, LEDGER].map(f => ({ name: f, rows: readFile(f) })));
  const expected = buildWeeklyReport(merged.accounts, merged.referrals);

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', err => failures.push(err.message));

    await page.goto('file://' + PAGE);
    await page.setInputFiles('#file-input', [PERIODIC, LEDGER]);
    await page.waitForSelector('.file-row');
    await page.click('#run-btn');
    await page.waitForSelector('#bonus-body tr');

    assert.deepStrictEqual(failures, [], 'the page should raise no errors');

    // Both files are recognised for what they are.
    const badges = await page.$$eval('.file-row .badge', els => els.map(e => e.textContent.trim()));
    assert.deepStrictEqual(badges.sort(), ['Ledger', 'Periodic']);

    // Same accounts, in the same order, with the same bonuses.
    const rendered = await page.$$eval('#bonus-body tr', trs => trs.map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      return { account: cells[1], bonus: cells[8] };
    }));
    const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    assert.strictEqual(rendered.length, expected.bonus.eligible.length);
    expected.bonus.eligible.forEach((account, i) => {
      assert.strictEqual(rendered[i].account, account.player ?? account.account,
        `row ${i + 1} should be the same account as the CLI`);
      assert.strictEqual(rendered[i].bonus, money(account.bonus),
        `row ${i + 1} should carry the same bonus as the CLI`);
    });

    // The referral section rendered the same referrer.
    const referrers = await page.$$eval('.group-name', els => els.map(e => e.textContent.trim()));
    assert.deepStrictEqual(referrers, expected.referral.groups.map(g => g.referrer));
  } finally {
    await browser.close();
  }
});

test('an .xlsx is decompressed correctly in the browser', skipOpts, async () => {
  // The browser inflates with DecompressionStream instead of zlib, so a real
  // workbook is worth exercising rather than only the CSV path.
  const workbook = path.join(__dirname, 'fixtures', 'periodic-sample.xlsx');

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + PAGE);
    await page.setInputFiles('#file-input', [workbook]);
    await page.waitForSelector('.file-row');
    assert.strictEqual((await page.textContent('.file-row .badge')).trim(), 'Periodic');
    assert.strictEqual((await page.textContent('.file-row .file-meta')).trim(), '16 rows');

    // And the numbers match the same workbook read through the Node path.
    await page.click('#run-btn');
    await page.waitForSelector('#bonus-body tr');
    const { readFile }          = require('../lib/sheet');
    const { loadRows }          = require('../lib/load');
    const { buildWeeklyReport } = require('../lib/weekly');
    const merged   = loadRows([{ name: workbook, rows: readFile(workbook) }]);
    const expected = buildWeeklyReport(merged.accounts, merged.referrals);

    const accounts = await page.$$eval('#bonus-body tr',
      trs => trs.map(tr => tr.querySelectorAll('td')[1].textContent.trim()));
    assert.deepStrictEqual(accounts,
      expected.bonus.eligible.map(a => a.player ?? a.account));
  } finally {
    await browser.close();
  }
});
