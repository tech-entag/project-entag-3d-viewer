# Style Consistency

<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

Review the changed code for adherence to project coding standards.

## Checks

1. **Naming conventions** — components use PascalCase, functions/variables use camelCase, constants use UPPER_SNAKE_CASE, files match their default/named export
2. **Import organization** — external imports first, then internal (absolute paths), then relative; no unused imports
3. **Component patterns** — named exports preferred over default exports; `"use client"` only when component needs interactivity
4. **Error handling** — API routes return consistent error shapes; try/catch blocks don't silently swallow errors
5. **Type safety** — no `any` types without justification; Zod schemas for external data boundaries
6. **File organization** — colocated tests, consistent directory structure, no orphaned files
7. **Code duplication** — flag identical logic appearing in 3+ places that should be extracted
8. **Comment quality** — no commented-out code committed; no TODO without a linked issue

## Output Format

For each finding, report:
- **Severity**: Error / Warning / Info
- **File and line**: exact location
- **Rule**: which convention is violated
- **Fix**: how to resolve it

If no issues found, report "Code follows project style conventions."
