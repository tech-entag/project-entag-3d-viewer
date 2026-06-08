# Security Review

<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

Review the changed code for security vulnerabilities. Focus on:

## Checks

1. **Hardcoded secrets** — API keys, tokens, passwords, connection strings in source code
2. **Input validation** — user inputs must be validated/sanitized before use (Zod schemas, parameterized queries)
3. **SQL injection** — no string concatenation in SQL queries; use parameterized queries or ORM methods
4. **XSS prevention** — user-generated content must be escaped before rendering; no `dangerouslySetInnerHTML` with unsanitized input
5. **Authentication/authorization** — protected routes must check auth state; API endpoints must verify permissions
6. **RLS policies** — new Supabase tables must have Row Level Security enabled with appropriate policies
7. **Sensitive data exposure** — no logging of passwords, tokens, or PII; no secrets in client bundles
8. **Dependency safety** — new dependencies should not have known critical CVEs

## Output Format

For each finding, report:
- **Severity**: Critical / High / Medium / Low
- **File and line**: exact location
- **Issue**: what's wrong
- **Fix**: how to resolve it

If no issues found, report "No security issues detected."
