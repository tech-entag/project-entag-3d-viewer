import { expect, test } from "@playwright/test";

const SHARE_TOKEN = process.env.E2E_VERCEL_SHARE || "";
const RUNNING_AGAINST_LOCAL_DEV = !process.env.E2E_BASE_URL;

const withShare = (path: string) => {
  if (!SHARE_TOKEN) {
    return path;
  }

  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}_vercel_share=${SHARE_TOKEN}`;
};

const autodeskStubScript = `
  (() => {
    const GEOMETRY_LOADED_EVENT = 'geometry-loaded';

    class GuiViewer3D {
      constructor(_element, _options) {
        this.listeners = {};
      }
      start() {}
      addEventListener(eventName, cb) {
        if (!this.listeners[eventName]) {
          this.listeners[eventName] = [];
        }
        this.listeners[eventName].push(cb);
      }
      emit(eventName) {
        (this.listeners[eventName] || []).forEach((cb) => cb({ type: eventName }));
      }
      fitToView() {}
      explode() {}
      loadModel(_url, _opts, onSuccess, _onError) {
        setTimeout(() => {
          document.body.setAttribute('data-viewer-loaded', 'true');
          if (onSuccess) onSuccess({});
          this.emit(GEOMETRY_LOADED_EVENT);
        }, 25);
      }
      loadDocumentNode(_doc, _node) {
        setTimeout(() => {
          document.body.setAttribute('data-viewer-loaded', 'true');
          this.emit(GEOMETRY_LOADED_EVENT);
        }, 25);
      }
    }

    window.Autodesk = {
      Viewing: {
        GEOMETRY_LOADED_EVENT,
        GuiViewer3D,
        Initializer: (_opts, cb) => cb(),
        Document: {
          load: (_urn, onSuccess, _onError) => {
            onSuccess({
              getRoot() {
                return {
                  getDefaultGeometry() {
                    return {};
                  },
                };
              },
            });
          },
        },
      },
    };
  })();
`;

test.beforeEach(async ({ page }) => {
  await page.route("**/developer.api.autodesk.com/modelderivative/v2/viewers/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith(".css")) {
      await route.fulfill({ status: 200, body: "" });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: autodeskStubScript,
    });
  });
});

test("viewer supports local bubbleUrl mode and captures screenshot", async ({ page }) => {
  await page.goto(withShare("/viewer?bubbleUrl=https://blob.vercel-storage.com/saved/model.svf"));
  await expect(page.locator("body")).toHaveAttribute("data-viewer-loaded", "true");
  await page.screenshot({ path: "test-results/viewer-local-mode.png", fullPage: true });
});

test("viewer resolves urn-only mode to local bubble and captures screenshot", async ({ page }) => {
  await page.route("**/api/viewer-source?urn=urn-local-001**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        mode: "local",
        urn: "urn-local-001",
        bubbleUrl: "https://blob.vercel-storage.com/saved/model.svf",
      }),
    });
  });

  await page.goto(withShare("/viewer?urn=urn-local-001"));
  await expect(page.locator("body")).toHaveAttribute("data-viewer-loaded", "true");
  await page.screenshot({ path: "test-results/viewer-urn-local-mode.png", fullPage: true });
});

test("viewer keeps polling while token-backed local source is processing", async ({ page }) => {
  let lookupCount = 0;

  await page.route("**/api/viewer-source?urn=urn-processing-001**", async (route) => {
    lookupCount += 1;

    if (lookupCount < 3) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          status: "processing",
          viewerStatus: "inprogress",
          retryAfterMs: 20,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        mode: "local",
        urn: "urn-processing-001",
        localModelUrl: "https://blob.vercel-storage.com/saved/model.svf",
      }),
    });
  });

  await page.goto(withShare("/viewer?urn=urn-processing-001&access_token=test-token&lookupAttempts=5&lookupIntervalMs=20"));
  await expect(page.locator("body")).toHaveAttribute("data-viewer-loaded", "true");
  expect(lookupCount).toBeGreaterThanOrEqual(3);
  expect(lookupCount).toBeLessThanOrEqual(4);
});

test("viewer ignores placeholder token query values", async ({ page }) => {
  let lookupUrl = "";

  await page.route("**/api/viewer-source?urn=urn-placeholder-token**", async (route) => {
    lookupUrl = route.request().url();
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, status: "queued" }),
    });
  });

  await page.goto(withShare("/viewer?urn=urn-placeholder-token&access_token=undefined&lookupAttempts=1&lookupIntervalMs=20"));
  await expect(page.getByText("Cloud fallback is disabled.")).toBeVisible();
  expect(lookupUrl).toContain("urn=urn-placeholder-token");
  expect(lookupUrl).not.toContain("access_token=");
});

test("viewer blocks cloud fallback when only cloud URN params are provided", async ({ page }) => {
  await page.route("**/api/viewer-source?urn=dryrun-urn**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ success: false }) });
  });

  await page.goto(withShare("/viewer?urn=dryrun-urn&access_token=dryrun-token&lookupAttempts=2&lookupIntervalMs=20"));
  await expect(page.getByText("Cloud fallback is disabled.")).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-viewer-loaded", "true");
  await page.screenshot({ path: "test-results/viewer-cloud-fallback-disabled.png", fullPage: true });
});

test("supported STEP and DWG files queue quote conversion", async ({ request }) => {
  test.skip(
    RUNNING_AGAINST_LOCAL_DEV,
    "Local Vite /api routing may return EISDIR. Use scripts/viewer-resilience-smoke.ts for API contract checks."
  );

  const stepResponse = await request.post(withShare("/api/autodesk"), {
    data: {
      dry_run: true,
      url: "https://example.com/model.fbx",
      part_id: "e2e-1",
      version: "test",
    },
  });

  expect(stepResponse.ok()).toBeTruthy();
  const stepJson = await stepResponse.json();
  expect(stepJson.quote.targetFormat).toBe("step");
  expect(stepJson.quote.status).toBe("queued");

  const dwgResponse = await request.post(withShare("/api/autodesk"), {
    data: {
      dry_run: true,
      url: "https://example.com/model.rvt",
      part_id: "e2e-2",
      version: "test",
    },
  });

  expect(dwgResponse.ok()).toBeTruthy();
  const dwgJson = await dwgResponse.json();
  expect(dwgJson.quote.targetFormat).toBe("dwg");
  expect(dwgJson.quote.status).toBe("queued");
});

test("quote failure is reported while viewer remains prioritized", async ({ request }) => {
  test.skip(
    RUNNING_AGAINST_LOCAL_DEV,
    "Local Vite /api routing may return EISDIR. Use scripts/viewer-resilience-smoke.ts for API contract checks."
  );

  const response = await request.post(withShare("/api/conversion-status"), {
    data: {
      dry_run: true,
      quoteTarget: "step",
      viewer_status: "success",
      quote_status: "failed",
      quote_error: "STEP derivative generation failed.",
    },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.success).toBeTruthy();
  expect(json.viewer.status).toBe("success");
  expect(json.viewer.priority).toBeTruthy();
  expect(json.quote.status).toBe("failed");
  expect(json.quote.error).toContain("failed");
});
