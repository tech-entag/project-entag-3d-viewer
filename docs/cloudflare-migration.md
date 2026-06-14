# Cloudflare Pages Migration (interim, Vercel-preserving)

This adds a parallel **Cloudflare Pages** deployment **without removing or editing
any Vercel code**. `vercel.json`, `vite.config.ts` (Vercel plugin), the
`@vercel/blob` storage, and the `export const config = { maxDuration }` exports are
all left in place. Cloudflare ignores the inert ones; the rest is bridged.

## What was added

| File | Purpose |
|---|---|
| `functions/api/[[path]].ts` | Catch-all Pages Function. Routes `/api/*` to the existing `api/**.cts` handlers, bridges `env` → `process.env`, applies CORS. |
| `functions/tsconfig.json` | Standalone TS config for the functions dir (does not affect the Vercel build). |
| `vite.config.cloudflare.ts` | Vite build **without** `vite-plugin-vercel`; emits a plain `dist/`. |
| `wrangler.toml` | Pages config: `nodejs_compat`, `pages_build_output_dir = "dist"`. |
| `public/_routes.json` | Scopes Pages Functions to `/api/*` only; everything else is static. |
| `public/_redirects` | SPA fallback (`/* /index.html 200`) — already present, replaces `vercel.json` rewrites. |
| `package.json` | Adds `build:cloudflare`, `pages:dev`, `pages:deploy`, `wrangler`, `@cloudflare/workers-types`. |

## How it works

The Vercel route handlers export Web-standard `GET`/`POST`/`OPTIONS(request)` functions
that take a bare `Request`, return a `Response`, and **self-parse dynamic path params**
from `request.url` (e.g. `getPartIdFromPath`). So no rewrite was needed — the dispatcher
just maps the URL to the right module and calls the matching method. Dynamic segments
(`[vercelPartId]`, `[embedSessionId]`) are matched by the dispatcher's route table.

The handlers read configuration from `process.env.*`. Cloudflare exposes vars on the
`env` binding instead, so the dispatcher copies `env` → `process.env` on each request
(requires `nodejs_compat`). This is why the `api/` code needs no changes.

## Deploy

```bash
pnpm install            # pulls in wrangler + workers-types
pnpm build:cloudflare   # vite build -> dist/
pnpm pages:deploy       # wrangler pages deploy
# local: pnpm pages:dev
```

Or connect the repo in the Cloudflare Pages dashboard with:
- **Build command:** `pnpm build:cloudflare`
- **Output directory:** `dist`
- **Compatibility flags:** `nodejs_compat`

## Environment variables to set in Cloudflare Pages

Set these in **Pages project → Settings → Environment variables** (secrets via
`wrangler pages secret put`). All are optional/feature-gated except where noted.

Storage (keep Vercel Blob alive for now — see caveat):
- `BLOB_READ_WRITE_TOKEN`

DigiFabster:
- `DIGIFABSTER_API_KEY` (or `DIGIFABSTER_API_TOKEN`)
- `DIGIFABSTER_UPLOAD_ENDPOINT` (required for upload sync)
- `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` (required for price-tweak POST)
- `DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT`, `DIGIFABSTER_UPLOAD_BASE_URL`,
  `DIGIFABSTER_UPLOAD_TIMEOUT_MS`, `DIGIFABSTER_S2S_TOKEN_TTL_MS`,
  `DIGIFABSTER_UPLOAD_SHARED_SECRET`, `DIGIFABSTER_DISABLE_DIRECT_TOKEN_FALLBACK`

Bubble:
- `BUBBLE_DATA_API_TOKEN` (or `BUBBLE_API_TOKEN` / `BUBBLE_DATA_API_BEARER_TOKEN`)
- `BUBBLE_DATA_API_BASE_URL`, `BUBBLE_ORDERPART_TYPE`, `BUBBLE_MODELID_FIELD`,
  `BUBBLE_THUMBNAIL_FIELD`

Embed / misc:
- `EMBED_SESSION_SECRET` (use a real value in production), `EMBED_GUEST_TOKEN_TTL_SECONDS`
- `AUTO_MODELID_ATTEMPTS`, `AUTO_MODELID_INTERVAL_MS`
- `QUOTE_SUPPORTED_FORMATS`, `DIGIFABSTER_NATIVE_FORMATS`, `DIRECT_2D_NO_TRANSLATION_FORMATS`

> `VERCEL_REGION` (health check in `bubble-trigger.cts`) is unset on Cloudflare →
> the health response shows `undefined`. Cosmetic.

## Known risks / follow-ups (not blockers for the interim)

1. **`@vercel/blob` on Workers** — it's HTTP-based and bundles under `nodejs_compat`,
   and works cross-cloud while `BLOB_READ_WRITE_TOKEN` points at Vercel Blob. The clean
   follow-up is migrating storage to **R2** (centralize behind `api/embed_helpers/blob-storage.ts`
   first — four files currently call `@vercel/blob` directly).
2. **`axios`** (used in some helpers) on the Workers runtime — verify HTTP calls work; the
   `fetch` adapter may be needed if the default Node adapter misbehaves.
3. **Module-load-time `process.env` reads** — the env bridge runs per request, so any
   top-level env read at first import could see empty values. The current `api/` code reads
   env lazily inside handlers, so this is not an issue today; keep in mind if that changes.
4. **`vercel.json` CORS quirk** — its header rule effectively matched only `/api/` exactly.
   The dispatcher applies sane CORS to all `/api/*` responses without overriding handler-set
   headers, which matches intent.

## Removing Vercel later

When you're ready to drop Vercel: delete `vercel.json`, remove `vite-plugin-vercel`
from `vite.config.ts` (or make `vite.config.cloudflare.ts` the default), drop
`@vercel/blob`/`@vercel/node` after the R2 migration, and remove the `maxDuration`
config exports. None of that is required for the Cloudflare deployment to run.
