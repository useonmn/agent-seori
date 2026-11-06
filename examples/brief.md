# Lane brief: fix-flaky-login

Goal: the login test in tests/auth/login.test.ts fails about 1 run in 20. Find why and fix the cause, not the symptom.

Inputs: CI runs of the last week; the test file; src/auth/session.ts.

Deliverable: one PR that fixes the root cause, with a test that fails before the fix and passes after.

Exit condition: the PR is open, `gh pr checks` shows every check passing, the login test passed 50 runs in a row on your branch, and `seori ready fix-flaky-login` has succeeded with the PR link as evidence. Until all of that holds, keep working.

Constraints: no retries or longer timeouts as the fix; do not touch unrelated tests.
