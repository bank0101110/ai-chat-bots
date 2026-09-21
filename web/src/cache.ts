import { api } from './api';
import type { Message } from './types';

// แคชข้อความต่อห้องในหน่วยความจำ — สลับห้องแล้วเห็นทันที แล้วค่อยอัปเดตของสดตามหลัง
type Entry = { list: Message[]; hasMore: boolean; at: number };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const MAX = 60;

export const getCached = (id: string) => store.get(id);

export function putCached(id: string, e: Omit<Entry, 'at'>) {
  store.delete(id);
  store.set(id, { ...e, at: Date.now() });
  if (store.size > MAX) store.delete(store.keys().next().value!);
}

export function fetchMessages(id: string, q: Record<string, unknown>, force = false): Promise<Entry> {
  const key = id;
  const running = inflight.get(key);
  if (running && !force) return running;
  const p = api<{ list: Message[]; hasMore: boolean }>(`/conversations/${id}/messages`, { query: { ...q, size: 40 } })
    .then(r => { putCached(id, r); return store.get(id)!; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** โหลดล่วงหน้าตอนเอาเมาส์ชี้ห้อง (ข้ามถ้าเพิ่งโหลดไปไม่ถึง 20 วินาที) */
export function prefetch(id: string, q: Record<string, unknown>) {
  const hit = store.get(id);
  if (hit && Date.now() - hit.at < 20_000) return;
  fetchMessages(id, q).catch(() => {});
}
