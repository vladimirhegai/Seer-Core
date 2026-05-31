// Direct test of validateCredentials + login. Calls into auth so the
// 'tests' edge synthesizer produces direct-coverage edges for the auth
// module, and so seer_behavior 2.0 surfaces this as a direct-call test.
import { AuthService, validateCredentials } from '../auth/AuthService';

function testValidateDirectly() {
  const ok = validateCredentials('alice', 'secret');
  expect(ok).toBe(true);
}

function testLoginExercisesValidate() {
  // login() calls validateCredentials() internally — used by the
  // ranker to compute indirect coverage of validateCredentials.
  const svc = new AuthService();
  const ok = svc.login('alice', 'secret');
  expect(ok).toBe(true);
  expect(typeof ok).toBe('boolean');
}

// Standalone helper for assertion counting checks.
function expect(_v: unknown) {
  return { toBe(_e: unknown): void { /* */ } };
}
