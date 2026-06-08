<!-- session-type: credential-validation, integration-testing -->
<!-- timestamp: 2026-04-09T00:00:00Z -->
<!-- status: completed -->

# Session: Credential Rotation & E2E Validation

## Summary

Autodesk APS production credentials became inaccessible (403 AUTH-001 on unchanged code). User provided replacement credentials. Agent validated new credentials, updated E2E runner to support env-driven credential injection (simulating Bubble payload pattern), redeployed production, and executed full end-to-end proof with Bubble-style request body. 

**Verdict: PASS** — All 4 requirements validated in production:
1. Upload STEP file → URN ✓
2. Viewer (local SVF mode) ✓
3. DigiFabster model creation ✓
4. Price tweaker endpoint ✓

Duration: ~31 seconds end-to-end.

---

## Context

### Prior Session State
- DigiFabster upload integration complete
- Full E2E script created (`scripts/e2e-production-proof.cjs`)
- Most requirements met; local viewer mode blocked by Blob token + credential issues

### User Request
> "Fix then redeploy then run e2e test yourself, simulating Bubble calling `/api/autodesk` with body `{url, part_id, version, client_id, client_secret}` using working file + provided credentials"

---

## Work Completed

### 1. Credential Validation (Direct OAuth Test)
- Tested new APS credentials directly against Autodesk OAuth endpoint
- **Result:** HTTP 200, access token generated successfully
- Confirmed credentials are valid and entitlement restored

### 2. E2E Runner Refactor (`scripts/full-e2e-proof.cjs`)
**Changes:**
- Added env var support for runtime credential injection:
  - `E2E_CLIENT_ID` (overrides creds.txt)
  - `E2E_CLIENT_SECRET` (overrides creds.txt)
  - `E2E_BASE_URL` (overrides hardcoded URL)
  - `E2E_MODEL_URL` (overrides hardcoded MODEL_URL)
- Updated `readCreds()` function to prioritize env vars
- Simplified STEP model URL (removed long tracking params)

**Code Example:**
```javascript
// Line 23
const BASE = process.env.E2E_BASE_URL || "https://project-entag-3d-viewer.vercel.app";

// Line 28-29
const CLIENT_ID = process.env.E2E_CLIENT_ID || "";
const CLIENT_SECRET = process.env.E2E_CLIENT_SECRET || "";

// Line 37-45: readCreds() now checks env first
```

### 3. Production Redeploy
- Deployed latest codebase to Vercel
- New production alias: `https://entag.project.citizendev.io`
- Deployment stable; all endpoints accessible

### 4. Full E2E Execution
**Command:**
```bash
E2E_CLIENT_ID="<new_id>" E2E_CLIENT_SECRET="<new_secret>" node scripts/full-e2e-proof.cjs
```

**Flow executed:**
```
[1/4] Auth Check
  → GET /api/autodesk (endpoint access verify)
  → Status: 200 ✓

[2/4] Upload
  → POST /api/autodesk with Bubble-style body
  → URN generated: dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6MTc3NTY5MTM2ND...
  → Format: step
  → Viewer status: queued
  → Quote status: not_required
  → Status: 200 ✓

[3/4] Viewer (Polling)
  → POST /api/conversion-status (poll 1)
    - Status: queued → inprogress
  → POST /api/conversion-status (poll 2)
    - Status: inprogress → success
    - Mode: local (SVF from Blob)
    - LocalModelUrl: https://myk7onojdk1izpvf.public.blob.vercel-storage.com/...
  → Status: 200 ✓

[4/4] DigiFabster + Price
  → DigiFabster sync: objectModelId=4290754, quoteStatus=success
  → Price tweak: objectModelId=4290754, price=$1462.66, holes=1
  → Status: 200 ✓

Final Verdict: PASS ✓
Duration: 31.57 seconds (start: 2026-04-08T23:36:00.651Z, end: 23:36:31.221Z)
```

### 5. Documentation Updates
- Updated `experience-log.md` with 3 key lessons
- Added to `tech-pitfalls.md`: Autodesk entitlement pitfalls
- Updated `memories/repo/api-routes.md` with credential injection pattern
- Confirmed credentials NOT stored in Vercel env per design

---

## Key Findings

### Architectural Understanding
1. **Local viewer mode doesn't require Autodesk for playback:**
   - Cache generation: needs APS (manifest fetch, SVF download)
   - Cache playback: Blob-only (cached SVF URLs)
   - Design is sound; APS calls only on first load per model

2. **Credential pattern validated:**
   - Credentials come from Bubble per request (request body)
   - Not cached in Vercel env
   - Allows credential rotation without redeploy

3. **Blob token functionality:**
   - Token valid in production
   - Local mode successfully stored SVF to Blob and retrieved it

### Why 403 Happened
- Old APS app registration lost product subscription/entitlement on Autodesk platform
- Not a code defect; credentials themselves were invalid
- New app registration restored access immediately

### What This Validates
- Bubble can call `/api/autodesk` with its own credentials safely
- No Vercel env dependency for Autodesk access
- Full pipeline works: upload → local cache → model creation → pricing

---

## Artifacts

| Artifact | Location | Purpose |
|---|---|---|
| E2E Result (Full) | `full-e2e-result.json` | Complete JSON proof of all 4 steps passing |
| E2E Script (Updated) | `scripts/full-e2e-proof.cjs` | Refactored to support env-driven credentials |
| Experience Log | `docs/ai/experience-log.md` | Appended 3 new entries |
| Tech Pitfalls | `/memories/tech-pitfalls.md` | Added Autodesk entitlement + Blob token notes |
| API Doc | `memories/repo/api-routes.md` | Updated with credential injection pattern |

---

## Recommendations

### Immediate (Next Session)
1. Confirm Bubble production config uses new APS credentials
2. Run E2E again against canonical alias to validate Bubble integration point
3. Monitor production `/api/autodesk` logs for any 403 patterns

### Strategic
1. Add monitoring/alerting for 403 responses on Model Derivative endpoints
2. Implement request-scoped error tracking (which app registration failed?)
3. Document APS credential rotation runbook for Bubble ops team

---

## Testing & Validation

- [x] New credentials validated (OAuth token exchange)
- [x] E2E script refactored for env injection
- [x] Production redeployed
- [x] Full 4-step flow executed
- [x] Local viewer mode confirmed working
- [x] DigiFabster integration confirmed working
- [x] Price tweaker endpoint confirmed working
- [x] All documentation updated

---

## Session Metadata

| Field | Value |
|---|---|
| Status | ✓ Completed |
| Verdict | PASS (all 4 requirements) |
| Duration | ~31 seconds (E2E execution) |
| Deployment | `https://entag.project.citizendev.io` |
| Blockers Resolved | Credential entitlement + Blob token validation |
| Remaining Work | Bubble production setup (external to this session) |
