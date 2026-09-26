// The ui-lab end-to-end harness (F-001 design §8.1, §8.2; T13). It runs against `vite preview` of
// the production builds of ui-lab and apps/web, never a dev server, so what is tested is what a
// build emits. Build both first (`turbo run build --filter=@ralysa/ui-lab... --filter=@ralysa/web`);
// global-setup.ts fails fast when a build or the right Node is missing.
//
// In CI this runs inside the pinned Playwright image (the `ui-e2e` job). Locally, run it through
// `pnpm --filter @ralysa/ui-lab e2e:container`, which uses the same image digest, so the browsers
// and fonts match CI.
//
// Projects (§8.2):
//   chromium  every spec
//   firefox   keyboard, radiogroup-shift-tab, shaping
//   webkit    radiogroup-shift-tab, shaping. The keyboard walk excludes WebKit: its Tab-to-links
//             default differs from Safari's user setting; Safari keyboard is the manual
//             TC-F-001-25. radiogroup-shift-tab (D-F001-E2E-1) doesn't depend on that setting.
// Snapshots (T14): visual (chromium) and shaping (each engine). A missing baseline fails in CI
// (`updateSnapshots: 'none'`); only `e2e:update` writes baselines, in the pinned image (§5.4).
import { defineConfig, devices } from '@playwright/test';
import { UI_LAB_URL, WEB_URL } from './e2e/helpers/urls.js';

const CI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'test-results',
  // Visual baselines are per project (per engine) and never per platform: the image is the platform.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  // Inside the 20-minute job budget (§8.2), with room for install and build.
  globalTimeout: 12 * 60_000,
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  updateSnapshots: 'none',
  workers: CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: UI_LAB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } },
      testMatch: ['keyboard.spec.ts', 'radiogroup-shift-tab.spec.ts', 'shaping.spec.ts'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } },
      testMatch: ['radiogroup-shift-tab.spec.ts', 'shaping.spec.ts'],
    },
  ],
  webServer: [
    {
      command:
        'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
      url: UI_LAB_URL,
      reuseExistingServer: !CI,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command:
        'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4174 --strictPort',
      cwd: '../web',
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
