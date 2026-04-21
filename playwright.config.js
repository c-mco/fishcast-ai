// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    geolocation: { latitude: -33.8688, longitude: 151.2093 },
    permissions: ['geolocation'],
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
