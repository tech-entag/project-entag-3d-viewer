import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4173";
const runAgainstLocalDevServer = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL,
    headless: true,
  },
  ...(runAgainstLocalDevServer
    ? {
        webServer: {
          command: "pnpm dev --host 127.0.0.1 --port 4173",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }
    : {}),
});
