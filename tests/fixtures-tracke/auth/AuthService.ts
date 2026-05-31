// Auth module entry point used by tests + billing.
import { hashPassword } from './crypto';

export class AuthService {
  login(username: string, password: string): boolean {
    if (!username || !password) return false;
    const hashed = hashPassword(password);
    return validateCredentials(username, hashed);
  }

  logout(token: string): void {
    invalidateToken(token);
  }
}

export function validateCredentials(username: string, password: string): boolean {
  // Trivial check — fixture only.
  return username.length > 0 && password.length > 0;
}

export function invalidateToken(_token: string): void {
  // no-op
}
