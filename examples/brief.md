# Lane brief: fix-flaky-login

Goal: the login test in tests/auth/login.test.ts fails about 1 run in 20. Find why and fix the cause, not the symptom.

Inputs: CI runs of the last week; the test file; src/auth/session.ts.

Deliverable: one PR that fixes the root cause, with a test that fails before the fix and passes after.

Stop condition: the PR is open, its checks are green, and you have sent READY with the PR link as evidence.

Constraints: no retries or longer timeouts as the fix; do not touch unrelated tests.
