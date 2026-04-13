import { defineConfig, devices } from '@playwright/test';
//import { AUTH_FILE } from './tests/auth.config';
import dotenv from 'dotenv';
import path from 'node:path';

const envFile = process.env.TEST_ENV ? `.env.${process.env.TEST_ENV}` : '.env';
dotenv.config({ path: path.resolve(envFile) });

export default defineConfig({
    testDir: './tests',

    timeout: 60_000,
    expect: { timeout: 10_000 },

    fullyParallel: true,
    workers: process.env.CI ? 2 : undefined,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,

    reporter: process.env.CI
        ? [
            ['html', { outputFolder: 'playwright-report' }],
            ['list'],
            ['json', { outputFile: 'test-results/results.json' }],
            ['junit', { outputFile: 'test-results/junit.xml' }],
            ['allure-playwright', { outputFolder: 'allure-results' }],
          ]
        : [
            ['html', { outputFolder: 'playwright-report' }],
            ['list'],
            ['allure-playwright', { outputFolder: 'allure-results' }],
          ],

    use: {
        baseURL: process.env.BASE_URL  || "http://localhost:3000/parabank/",

        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',

        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },

    projects: [
        // {
        //     name: 'setup',
        //     testMatch: /.*\.setup\.ts/,
        // },
        // {
        //     name: 'chromium',
        //     testDir: './tests/ui',
        //     use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
        //     dependencies: ['setup'],
        // },
        // {
        //     name: 'firefox',
        //     testDir: './tests/ui',
        //     use: { ...devices['Desktop Firefox'], storageState: AUTH_FILE },
        //     dependencies: ['setup'],
        // },
        // {
        //     name: 'webkit',
        //     testDir: './tests/ui',
        //     use: { ...devices['Desktop Safari'], storageState: AUTH_FILE },
        //     dependencies: ['setup'],
        // },

        {
            name: 'chromium',
            testDir: './tests/ui',
            use: { ...devices['Desktop Chrome'] },
            //dependencies: ['setup'],
        },
        {
            name: 'firefox',
            testDir: './tests/ui',
            use: { ...devices['Desktop Firefox'] },
            //dependencies: ['setup'],
        },
        {
            name: 'webkit',
            testDir: './tests/ui',
            use: { ...devices['Desktop Safari'] },
            //dependencies: ['setup'],
        },
        {
            name: 'api',
            testDir: './tests/api',
            use: {
                baseURL: 'http://localhost:3000/parabank/',
                extraHTTPHeaders: {
                    'Accept': 'application/json',
                    //'Authorization': `Bearer ${process.env.API_TOKEN}`,
                },
            },
        },
    ],
});
