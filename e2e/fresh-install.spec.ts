import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Fresh installation -> owner bootstrap -> project/environment -> local provider -> domain
 * -> API key -> send via the PUBLIC API -> message really arrives in Mailpit -> visible in
 * the dashboard as "Submitted" (not "Delivered") -> HTML preview cannot run scripts.
 */
const root = path.resolve(__dirname, '..');
const stackEnv = () =>
  JSON.parse(readFileSync(path.join(root, 'e2e', '.auth', 'stack-env.json'), 'utf8')) as Record<
    string,
    string
  >;
const API = 'http://localhost:3101';
const OWNER = { email: `owner-${Date.now()}@e2e.test`, password: 'e2e-owner-password-123' };

test('fresh install to message in Mailpit, end to end', async ({ page, request }) => {
  const env = stackEnv();
  // The operator CLI prints the one-time token on stderr.
  const cli = spawnSync(
    process.execPath,
    [path.join(root, 'apps/api/dist/cli.js'), 'bootstrap-token'],
    { env, encoding: 'utf8' },
  );
  const setupToken = `${cli.stdout}\n${cli.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  expect(setupToken).toBeTruthy();

  // 1. Bootstrap the first owner.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(setupToken!);
  await page.getByLabel('Organization name').fill('E2E Agency');
  await page.getByLabel('Your name').fill('E2E Owner');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByLabel('Repeat password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Create owner and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // Setup is closed now.
  const again = await request.get(`${API}/api/setup/status`);
  expect((await again.json()).needsSetup).toBe(false);

  // 2. Project + environments.
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Project name').fill('Client E2E');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Getting started')).toBeVisible();
  const envUrl = page.url();

  // Keep content for the preview check (default policy purges it right after hand-off).
  await page.goto(`${envUrl}/settings`);
  await page.getByLabel('Message content (days)').fill('7');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Retention policy saved')).toBeVisible();

  // 3. Local provider.
  await page.goto(`${envUrl}/providers`);
  await page.getByRole('button', { name: 'Save as default connection' }).click();
  await expect(page.getByRole('heading', { name: 'Mailpit', level: 3 })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Connection and authentication succeeded' }),
  ).toBeVisible();

  // 4. Domain (reserved local-only test domain).
  await page.goto(`${envUrl}/domains`);
  await page.getByLabel('Domain').fill('client-e2e.test');
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByText('Can send')).toBeVisible();

  // 5. API key (shown once).
  await page.goto(`${envUrl}/api-keys`);
  await page.getByLabel('Name').fill('e2e');
  await page.getByRole('button', { name: 'Create key' }).click();
  const apiKey = (await page.getByTestId('one-time-secret').textContent())!.trim();
  expect(apiKey).toMatch(/^os_/);

  // 6. Send through the public API with hostile HTML.
  const subject = `E2E ${Date.now()}`;
  const res = await request.post(`${API}/v1/emails`, {
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `e2e-${Date.now()}` },
    data: {
      from: 'Client E2E <hello@client-e2e.test>',
      to: ['recipient@e2e.test'],
      subject,
      html: `<p id="safe">Safe content</p><img src="https://tracker.invalid/open.gif" alt="t"><script>try{parent.document.title='PWNED'}catch(e){};document.body.setAttribute('data-ran','yes')</script>`,
      text: 'Safe content',
    },
  });
  expect(res.status()).toBe(202);
  const { id } = await res.json();

  // 7. The message really arrives in Mailpit.
  await expect
    .poll(
      async () => {
        const r = await request.get(
          `${env.MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`message-id:"${id}@client-e2e.test"`)}`,
        );
        return (await r.json()).messages?.length ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  // 8. Visible in the dashboard: "Submitted", never claiming delivery.
  await page.goto(`${envUrl}/emails`);
  await expect(page.getByRole('link', { name: subject })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: subject }).click();
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  await expect(page.getByText('Not a delivery confirmation.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('none reported')).toBeVisible();
  await expect(page.getByText('email.submitted')).toBeVisible();

  // 9. HTML preview is isolated: sandboxed, no script execution, no remote images by default.
  const frameEl = page.getByTestId('html-preview');
  await expect(frameEl).toHaveAttribute('sandbox', '');
  const frame = page.frameLocator('[data-testid="html-preview"]');
  await expect(frame.locator('#safe')).toHaveText('Safe content');
  await expect(frame.locator('body')).not.toHaveAttribute('data-ran', 'yes');
  expect(await page.title()).not.toBe('PWNED');
  await expect(page.getByText('Remote images are blocked')).toBeVisible();
});
