// Auth module — used as the target of SCIP precision imports in tests.

export class AuthService {
  login(user: string, pass: string): boolean {
    if (!user || !pass) return false;
    return this.checkCredentials(user, pass);
  }

  logout(token: string): void {
    if (!token) return;
    this.revokeToken(token);
  }

  private checkCredentials(_user: string, _pass: string): boolean {
    return true;
  }

  private revokeToken(_token: string): void {
    return;
  }
}

export function authenticate(user: string, pass: string): boolean {
  const svc = new AuthService();
  return svc.login(user, pass);
}
