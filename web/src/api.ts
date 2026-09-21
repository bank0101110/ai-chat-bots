const KEY_STORE = 'duoke-desk-key';

export function getKey(): string {
  try { return localStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; }
}
export function setKey(k: string) {
  try { localStorage.setItem(KEY_STORE, k); } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  let url = `/api${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(getKey() ? { 'x-ui-key': getKey() } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && /รหัสผ่าน UI/.test(data?.error ?? '')) window.dispatchEvent(new Event('duoke:need-key'));
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return data as T;
}

export function streamUrl() {
  const k = getKey();
  return `/api/stream${k ? `?key=${encodeURIComponent(k)}` : ''}`;
}
