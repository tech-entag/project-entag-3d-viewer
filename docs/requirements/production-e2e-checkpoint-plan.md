<!-- last-verified: 2026-04-08 -->

# Production E2E Checkpoint Test Plan

## Business Context

**Entag** (<https://entag.co>) is an on-demand manufacturing platform. Customers upload 3D CAD files through the Bubble app at `app.entag.co` to get instant quotes for CNC machining, 3D printing, and sheet metal fabrication.

This Vercel project (`entag-3d-viewer`) is the bridge between Bubble and two external services:

1. **Autodesk** — translates uploaded 3D files into SVF (web viewer) format and, when needed, converts them into a Digifabster-compatible format (STEP or DWG).
2. **Digifabster** — the quoting engine that calculates manufacturing cost, materials, and lead times.

### How the real flow works (end to end)

1. **User uploads a 3D file in the Bubble app** for quoting (CNC, 3D printing, sheet metal, etc.).
2. **Bubble triggers `POST /api/autodesk`** on Vercel. Because sending large files directly from Bubble is unreliable, Bubble only sends the file's download URL plus metadata (`part_id`, `version`). Vercel fetches the actual file.
3. **Vercel sends the file to Autodesk for translation.** Two things happen in parallel:
   - The file is translated to **SVF** (Autodesk's viewer format) so the customer can preview the 3D model in-browser.
   - If the file isn't already in a Digifabster-compatible format, it's also translated to **STEP** or **DWG** (the formats Digifabster can price).
4. **The SVF is stored locally on Vercel Blob**, mapped by URN. From this point on, whenever the Bubble app needs to show the 3D viewer (via iframe), Vercel serves the saved SVF directly — **Autodesk is never contacted again** for viewing.
5. **The STEP/DWG derivative is sent to Digifabster** to create a draft quote. Digifabster returns a `objectModelId` and `orderId`, which are written back to Bubble so the part record is linked to its Digifabster quote.
   - If the file is **already** in a Digifabster-native format (e.g. STEP, STL, IGES, DXF), this conversion step is skipped — the original file goes straight to Digifabster.
   - If no conversion path exists (unsupported format), quoting is skipped entirely.
6. **Price tweaking**: Whenever Bubble needs to re-price a part (customer changes quantity, tolerance, finish, etc.), Bubble calls `POST /api/digifabster-price-tweak` on Vercel. Vercel normalizes the payload and forwards it to Digifabster, returning the updated pricing.

### Format classification

| Category | Extensions | What happens |
|---|---|---|
| **Digifabster-native** (no conversion needed) | stl, step, stp, iges, igs, dxf, dwg, 3mf, wrl | File goes directly to Digifabster |
| **Converted to STEP** | f3d, fbx, iam, ipt, smb, smt, wire | Autodesk translates to STEP before quoting |
| **Converted to DWG** | rvt, f2d, slddrw | Autodesk translates to DWG before quoting |
| **Unsupported** | everything else | Viewer-only, no quoting |

## What This Test Proves

Each step validates one link in the chain above. If any step fails, we know exactly where the chain broke.

| Step | What it proves | Business meaning |
|---|---|---|
| **Step 1: Auth** | Vercel share-token works, deployment is reachable | The app is publicly accessible |
| **Step 2: Upload** | File is fetched, sent to Autodesk, translation is queued | "A customer can submit a 3D file" |
| **Step 3: Viewer** | SVF translation succeeds and is cached locally | "The customer can preview their part in 3D" |
| **Step 4: Quote** | Quote derivative reaches a terminal state and (if applicable) Digifabster receives the file | "The customer gets a price for their part" |
| **Step 5: Price tweak** | The pricing route responds and can forward to Digifabster | "The customer can adjust options and see updated pricing" |
| **Step 6: Visual proof** | The 3D viewer actually renders in a browser | "The 3D preview looks right to a human" |

## Expected Outcomes by File Type

| File type | Example | Quote outcome | Why |
|---|---|---|---|
| Digifabster-native | STEP, STL, IGES | `not_required` | Already priceable — no conversion needed |
| STEP-convertible CAD | F3D, IPT, IAM | `success` with `objectModelId` + `orderId` | Autodesk converts to STEP, sent to Digifabster |
| Mesh-to-CAD (known failure) | FBX (`Samba Dancing.fbx`) | `failed` (derivative_empty) | Autodesk produces a 0-byte STEP — expected behaviour for mesh files |
| Unsupported format | — | No quote requested | Viewer-only |

## Preconditions

| Check | What it means |
|---|---|
| Deployment URL responds (200) | Vercel deployment is live |
| Share token produces `_vercel_jwt` | Cookie-based auth works (Vercel share protection) |
| `creds.txt` has `client_id:client_secret` | Autodesk API credentials are available |
| `BLOB_READ_WRITE_TOKEN` in production env | Vercel Blob storage is configured for SVF caching |

## Step-by-Step Test Plan

### Step 0: Setup

Prepare the test run: read credentials, set the base URL and share token, choose a test file, create an artifacts folder.

**What this simulates:** Nothing — it's bookkeeping. But if creds are wrong or the file doesn't exist, everything below will fail.

**Pass:** All inputs defined, artifacts folder created, `run-meta.json` written.

### Step 1: Auth Handshake

Call `GET /?_vercel_share=<token>`. Extract the `_vercel_jwt` cookie from the response. This cookie authenticates all subsequent API calls.

**What this simulates:** A user opening the Entag 3D viewer link (which is share-protected on Vercel).

**Pass:** `_vercel_jwt` cookie is set and non-empty.
**Fail:** No cookie → share token expired or deployment unreachable.

### Step 2: Upload and Translation Kickoff

Call `POST /api/autodesk` with the file URL, `part_id`, `version`, and Autodesk credentials.

**What this simulates:** The Bubble app telling Vercel "a customer uploaded this file — go process it." Vercel downloads the file, uploads it to Autodesk, and starts translation.

**Pass:**
- HTTP 200
- `urn` returned (Autodesk's unique ID for this translation job)
- `viewer.status = queued` (SVF translation started)
- `quote.status` is `queued` (conversion needed) or `not_required` (file is already Digifabster-native)

**Fail:** Upload rejected, missing URN, or bad credentials.

### Step 3: Viewer Readiness

Poll `POST /api/conversion-status` every 10–15 seconds until the viewer is ready.

**What this simulates:** The Bubble app polling "is the 3D preview ready yet?" The SVF needs to translate on Autodesk's side, then get downloaded and cached into Vercel Blob.

**Pass:**
- `viewer.status = success`
- `viewer.mode = local` (SVF cached on Vercel) or `cloud` (fallback to Autodesk CDN)
- `localModelUrl` present when mode is `local`

**Fail:** Viewer stays at `inprogress` until timeout, or reaches `failed`.

### Step 4: Quote Terminal State

Continue polling until `quote.status` reaches a terminal value: `success`, `not_required`, or `failed`.

**What this simulates:** "Can we price this part?" For STEP-convertible files, Autodesk must produce a STEP derivative, then Vercel downloads it and uploads it to Digifabster. For native files (like a STEP input), no conversion is needed.

**Pass (per file type):**
- **Native** (e.g. STEP input): `quote.status = not_required`
- **Convertible** (e.g. IPT): `quote.status = success` with `objectModelId` + `orderId` from Digifabster
- **Known failure** (e.g. FBX): `quote.status = failed` with `derivative_empty` error

**Fail:** Timeout, or `success` without IDs.

### Step 5: Price Tweak Route

Call `GET /api/digifabster-price-tweak` to verify the route exists and returns contract metadata.

If Step 4 produced Digifabster IDs, also call `POST /api/digifabster-price-tweak` with a minimal payload to verify the live Digifabster connection.

**What this simulates:** "Can the Bubble app adjust pricing options (quantity, tolerance, finish) and get updated costs?"

**Pass (GET):** HTTP 200, `endpoint` and `requiredFields` present.
**Pass (POST, optional):** HTTP 200, `success: true`, Digifabster responded.

### Step 6: Viewer Visual Proof

Open the viewer page in a headless browser (Playwright), load the SVF, wait for rendering, and take a screenshot.

**What this simulates:** "What does the customer actually see when they open the 3D preview?"

**Pass:** At least one `<canvas>` element rendered, screenshot captured.
**Watch:** Autodesk error modal visible, or missing geometry despite `success` status.

### Final Verdict

Combine all step results. Overall **PASS** requires Steps 1–5 to pass. Step 6 is evidence (screenshot) and not a hard gate unless geometry is missing.

## Poll Cadence

| Scenario | Interval | Max polls | Window |
|---|---|---|---|
| Fast sanity | 10s | 30 | 5 min |
| Standard | 15s | 60 | 15 min |
| Slow/large file | 20s | 75 | 25 min |

## Failure Triage

| Failing step | First check | Likely cause |
|---|---|---|
| Step 1 | Share token validity | Expired or wrong token |
| Step 2 | Request body + creds | Bad Autodesk credentials, unreachable file URL |
| Step 3 | Poll progression | Autodesk translation stuck or failed |
| Step 4 | Quote error payload | Unsupported conversion, 0-byte derivative, Digifabster down |
| Step 5 | Route response shape | Deployment mismatch, route not deployed |
| Step 6 | Screenshot + DOM | Render timing, empty model, Autodesk CDN issue |

## Current Baseline (2026-04-08)

**STEP file (native Digifabster format):** Expected PASS — viewer success, quote `not_required`, price tweak route live.

**FBX mesh file:** Expected PASS with known `failed` quote (0-byte STEP derivative from Autodesk is expected for mesh-only formats). Viewer still succeeds.
