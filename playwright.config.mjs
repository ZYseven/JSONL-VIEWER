import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/webview',
  testMatch: '**/*.spec.mjs',
  timeout: 15_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8765',
    headless: true,
    viewport: { width: 1280, height: 720 }
  },
  webServer: {
    command: 'node test/webview/server.mjs',
    url: 'http://127.0.0.1:8765/test/webview/harness.html',
    reuseExistingServer: true,
    timeout: 10_000
  }
});
