// Fixture: HTTP calls that target k8s/Docker-declared service hostnames.
// The resolver should classify these as match_kind='service_host' when both
// the host AND the path match a route in the workspace.

export async function paymentCall(): Promise<unknown> {
  // payment-service is declared in k8s/payment-service.yaml AND in
  // docker-compose.yml. /api/charge is registered in billing.ts.
  return fetch('http://payment-service/api/charge', { method: 'POST' });
}

export async function unknownHostCall(): Promise<unknown> {
  // No matching k8s/Docker host; falls back to a literal_path link.
  return fetch('http://random-unknown-host/api/charge', { method: 'POST' });
}

export async function hostOnlyCall(): Promise<unknown> {
  // Host is known but path doesn't exist in any workspace route → must NOT
  // link via service_host alone (host alone is not enough evidence).
  return fetch('http://notifier/no-such-path', { method: 'GET' });
}
