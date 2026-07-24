'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PROJECT = 'robb-agents';
const CDP_URL = process.env.ROBB_PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9333';
const RENDERER_ORIGIN = process.env.ROBB_PLAYWRIGHT_RENDERER_ORIGIN || 'http://localhost:6173';

function unique(values) {
  return [...new Set(values)];
}

(async () => {
  console.log('=== robb-agents — Electron UI Validation ===\n');

  const browser = await chromium.connectOverCDP(CDP_URL);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith(RENDERER_ORIGIN));
  if (!page) {
    throw new Error(`No Electron renderer connected at ${RENDERER_ORIGIN}. Start "bun run electron:dev:playwright" first.`);
  }

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  let collectRequestFailures = false;

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (!collectRequestFailures) return;
    const failure = request.failure();
    failedRequests.push(`${request.method()} ${request.url()} — ${failure?.errorText || 'unknown failure'}`);
  });

  try {
    const target = new URL(page.url());
    target.searchParams.set('route', 'settings/governance');
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#root:not(:empty)', { timeout: 20_000 });

    const deferSetup = page.getByRole('button', {
      name: /Configurer plus tard|Setup later|Más adelante|Später einrichten/i,
    });
    if (await deferSetup.isVisible().catch(() => false)) {
      console.log('Onboarding detected: deferring provider setup for UI validation.');
      await deferSetup.click();
      await page.waitForTimeout(1_000);
    }

    await page.waitForTimeout(1_000);
    console.log(`Navigation probe: ${page.url()} — ${(await page.locator('body').innerText()).slice(0, 180).replace(/\s+/g, ' ')}`);
    await page.getByText(/Gouvernance|Governance/i).first().waitFor({ timeout: 20_000 });

    // Ignore only pre-document Vite/CDP churn. Every request triggered by the
    // real governance interaction below remains part of the validation.
    failedRequests.length = 0;
    collectRequestFailures = true;

    for (const section of [
      /Membres et rôles|Members and roles/i,
      /Mémoire de l'espace|Workspace memory/i,
      /Budgets des missions|Mission budgets/i,
      /Supervision distante|Remote supervision/i,
      /Audit de gouvernance|Governance audit/i,
    ]) {
      await page.getByText(section).first().waitFor({ timeout: 10_000 });
    }

    const member = page.getByText('e2e-validator', { exact: true });
    if (await member.count() === 0) {
      const input = page.getByPlaceholder(/Identifiant du membre|Member identifier/i);
      await input.fill('e2e-validator');
      const form = input.locator('..');
      await form.locator('select').selectOption('validator');
      await form.getByRole('button', { name: /Ajouter|Add/i }).click();
      await member.waitFor({ timeout: 10_000 });
    } else {
      const roleSelect = page.getByLabel(/Rôle de e2e-validator|Role for e2e-validator/i);
      const currentRole = await roleSelect.inputValue();
      await roleSelect.selectOption(currentRole === 'operator' ? 'validator' : 'operator');
    }

    await page.getByText(/Politique de gouvernance enregistrée|Governance policy saved/i).waitFor({ timeout: 10_000 });
    await page.getByText(/Chaîne d'audit vérifiée|Audit chain verified/i).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);

    const remoteSection = page.getByTestId('remote-supervision-section');
    await remoteSection.waitFor({ timeout: 10_000 });
    const remoteToggle = remoteSection.getByRole('switch', {
      name: /Activer la supervision distante des métadonnées|Enable remote metadata supervision/i,
    });
    if (await remoteToggle.isChecked()) {
      await remoteToggle.click();
      await page.getByText(/Supervision distante révoquée|Remote supervision revoked/i).last().waitFor({ timeout: 10_000 });
      await remoteSection.getByText(/Local uniquement|Local only/i).waitFor({ timeout: 10_000 });
    }
    await remoteToggle.click();
    await page.getByText(/Consentement de supervision distante enregistré|Remote supervision consent recorded/i).last().waitFor({ timeout: 10_000 });
    await remoteSection.getByText(/Supervision distante des métadonnées active|Remote metadata supervision active/i).waitFor({ timeout: 10_000 });
    await remoteToggle.click();
    await page.getByText(/Supervision distante révoquée|Remote supervision revoked/i).last().waitFor({ timeout: 10_000 });
    await remoteSection.getByText(/Local uniquement|Local only/i).waitFor({ timeout: 10_000 });

    const title = await page.title();
    const rootText = (await page.locator('#root').innerText()).trim();
    const bodyText = await page.locator('body').innerText();
    const brandVisible = title === 'Robb Agents'
      || bodyText.includes('Robb Agents')
      || await page.locator('img[alt*="Robb"]').count() > 0;
    const legacyBrandVisible = /\bCraft Agents?\b/i.test(bodyText);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

    const screenshotDir = '/tmp/playwright-screenshots';
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `${PROJECT}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const filteredConsoleErrors = unique(consoleErrors).filter((message) =>
      !message.includes('net::ERR_ABORTED') && !message.includes('favicon.ico'));
    const filteredPageErrors = unique(pageErrors);
    const filteredFailedRequests = unique(failedRequests).filter((message) =>
      !message.includes('favicon.ico'));

    console.log(`Renderer: ${page.url()}`);
    console.log(`Title:    ${title}`);
    console.log(`Root:     ${rootText.length > 0 ? 'visible and non-empty' : 'empty'}`);
    console.log(`Brand:    ${brandVisible && !legacyBrandVisible ? 'Robb Agents' : 'invalid'}`);
    console.log('Remote:   grant/revoke verified; final state local-only');
    console.log(`Overflow: ${overflow ? 'horizontal overflow detected' : 'none'}`);
    console.log(`Console errors: ${filteredConsoleErrors.length}`);
    console.log(`Page errors: ${filteredPageErrors.length}`);
    console.log(`Failed requests: ${filteredFailedRequests.length}`);
    console.log(`Screenshot: ${screenshotPath}`);

    for (const error of filteredConsoleErrors) console.log(`  console · ${error}`);
    for (const error of filteredPageErrors) console.log(`  page · ${error}`);
    for (const error of filteredFailedRequests) console.log(`  request · ${error}`);

    const ok = title === 'Robb Agents'
      && rootText.length > 0
      && brandVisible
      && !legacyBrandVisible
      && !overflow
      && filteredConsoleErrors.length === 0
      && filteredPageErrors.length === 0
      && filteredFailedRequests.length === 0;

    console.log(`\n=== RESULT: ${ok ? 'FONCTIONNEL' : 'DÉGRADÉ'} ===`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('ERROR:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
