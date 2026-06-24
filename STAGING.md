# Working on the `staging` branch

Setup + workflow notes for picking this branch up on another machine. `staging`
holds the DigiFabster integration work (pricing, place-order, technologies,
suitable-materials) ahead of `main`.

## 1. Clone + remotes

`origin` is a personal **fork (do not push there)**. The real upstream is
`entag`. Always push to `entag`.

```bash
git clone https://github.com/tech-entag/project-entag-3d-viewer.git
cd project-entag-3d-viewer
git remote -v   # expect: entag -> tech-entag/...  (add it if missing)
# if only origin exists:
git remote add entag https://github.com/tech-entag/project-entag-3d-viewer.git

git fetch entag
git checkout -b staging entag/staging   # track the staging branch
```

> Rule: **never push to `entag main` without asking first.** Push feature work to
> `staging` (or a topic branch), open a PR into `main`.

## 2. Install + verify

```bash
pnpm install            # packageManager is pnpm@11.5.2
npx tsc -b              # full typecheck (there is no "typecheck" script). Expect exit 0.
```

Hermetic e2e suites (no DigiFabster/Bubble creds needed — they mock everything):

```bash
pnpm test:e2e:batch-price
pnpm test:e2e:place-order
pnpm test:e2e:technologies
pnpm test:e2e:suitable-materials
```

## 3. Endpoints on this branch (Cloudflare Pages Functions, `/api/*`)

Handlers live in `api/*.cts`; the catch-all dispatcher is
`functions/api/[[path]].ts` (add new routes to its `ROUTES` table). Shared
DigiFabster logic is in `api/autodesk_helpers/digifabster-sync.ts`.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/digifabster-batch-price` | Customer price (preselection → batch_price). Writes `requestedPrice` + `materialId` to Bubble OrderPart. |
| `POST /api/digifabster-place-order` | Entag places the order (adm → purchases → submit → confirm). |
| `GET/POST /api/digifabster-technologies` | Widget catalog cached in R2. `?category=cnc-machining\|sheet-metal\|tube`, `?tech=`, `?refresh=true`. |
| `GET/POST /api/digifabster-suitable-materials` | Suitable materials for a model, enriched from the cached catalog (shaped to the Bubble quote form). |

## 4. R2 config objects (editable without redeploy)

Bucket: **`entag-3d-viewer`**. Use **PowerShell** for wrangler (Git Bash crashes
it). `wrangler r2 object put/get` has **no `--remote` flag** (remote is default).

| Key | What |
|-----|------|
| `config/pricing.json` | `priceMultiplier` (1.54), pinned `materialId`, `count` ladder, `config` (tolerance/thickness). |
| `config/place-order.json` | Fixed `clientId` (435622) + customer + submit/place status. |
| `config/widget-technologies.json` | Full widget catalog snapshot (~1 MB). Refresh with `POST /api/digifabster-technologies` or `?refresh=true`. |

Read/update example:

```powershell
npx wrangler r2 object get "entag-3d-viewer/config/pricing.json" --file pricing.json
# edit pricing.json
npx wrangler r2 object put "entag-3d-viewer/config/pricing.json" --file pricing.json --content-type application/json
```

## 5. Env / secrets

DigiFabster/Bubble secrets live in the **Cloudflare Pages** project (not in the
repo). Non-secret defaults are in `wrangler.toml` `[vars]` (e.g.
`DIGIFABSTER_DEFAULT_LEAD_TIME_IDS`, `DIGIFABSTER_DEFAULT_TOLERANCE_ID`). Key one:
`DIGIFABSTER_API_KEY` (S2S token exchange).

## 6. Deploy / inspect

```bash
pnpm build:cloudflare       # vite build (cloudflare config)
pnpm pages:deploy           # build + wrangler pages deploy
```

The price-scheduler cron worker is separate: `pnpm price-scheduler:deploy` /
`price-scheduler:tail`.

## 7. Gotchas

- **GitNexus** index goes stale after commits — `npx gitnexus analyze` to refresh
  (a PostToolUse hook does this automatically on commit/merge for Claude Code).
- `.claude/settings.json` and `price-jobs/` are local — never commit them.
- DigiFabster serializes money as **strings** (`"431.04"`) in many responses —
  parse with care.
- `lead_time` / `tolerance` / `thickness` are **per technology + material**;
  don't hardcode one across technologies.
