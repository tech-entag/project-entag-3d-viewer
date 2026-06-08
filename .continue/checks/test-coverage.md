# Test Coverage

<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

Review the changed code to verify adequate test coverage.

## Checks

1. **New functions/endpoints have tests** — any new exported function, API route, or server action must have at least one test
2. **Edge cases covered** — tests include happy path, error path, and boundary conditions
3. **No test-only shortcuts** — tests don't mock away the logic under test; assertions are meaningful (not just `toBeDefined`)
4. **Critical paths tested** — auth flows, payment logic, data mutations, and permission checks must have integration tests
5. **UI components tested** — interactive components have at least render + key interaction tests
6. **Regression tests for bugs** — bug fixes should include a test that would have caught the original bug
7. **Test isolation** — tests don't depend on execution order or shared mutable state

## Output Format

For each finding, report:
- **Severity**: Critical / Warning / Info
- **File**: which source file lacks coverage
- **Gap**: what's not tested
- **Suggestion**: recommended test to add

If coverage is adequate, report "Test coverage is sufficient for the changes."
