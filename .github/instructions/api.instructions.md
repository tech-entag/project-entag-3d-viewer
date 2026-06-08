---
applyTo: "api/**/*.cts,api/**/*.ts"
---

<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

# API Route Conventions

- Validate all inputs at the boundary before processing.
- Return consistent error shape: `{ error: string, details?: string }` with appropriate HTTP status codes.
- Always check authorization before processing the request.
- Never expose internal error details to clients — log them server-side.
- For mutations, use POST/PUT/DELETE methods only.
- Return appropriate HTTP status codes: 400 for validation, 401 for auth, 403 for authz, 404 for not found, 500 for unhandled.
- Serverless functions use `.cts` extension (CommonJS TypeScript) for Vercel compatibility.
- Use `@vercel/node` types when needed for request/response typing.
