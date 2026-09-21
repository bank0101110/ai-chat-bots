export const PLATFORM: Record<string, { label: string; color: string; short: string; domain?: string }> = {
  shopee: { label: 'Shopee', color: '#f3c9b6', short: 'S', domain: 'shopee.co.th' },
  lazada: { label: 'Lazada', color: '#c5b0f4', short: 'L', domain: 'lazada.co.th' },
  tiktok: { label: 'TikTok', color: '#efd4d4', short: 'T', domain: 'tiktok.com' },
  facebook: { label: 'Facebook', color: '#c8e6cd', short: 'F', domain: 'facebook.com' },
  line: { label: 'LINE', color: '#dceeb1', short: 'LN', domain: 'line.me' },
  shopify: { label: 'Shopify', color: '#c8e6cd', short: 'SH', domain: 'shopify.com' },
  whatsapp: { label: 'WhatsApp', color: '#c8e6cd', short: 'W', domain: 'whatsapp.com' },
};
/** ไอคอนแพลตฟอร์ม = favicon ของเว็บแพลตฟอร์มนั้นเอง (โหลดไม่ได้ → ใช้ตัวอักษรแทน) */
export const platformIcon = (p?: string | null) => {
  const d = PLATFORM[String(p ?? '').toLowerCase()]?.domain;
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=64` : null;
};
export const platformOf = (p?: string | null) =>
  PLATFORM[String(p ?? '').toLowerCase()] ?? { label: p ?? '-', color: '#f4ecd6', short: String(p ?? '?').slice(0, 1).toUpperCase() };

/** สีแท็กของ Duoke → บล็อกพาสเทลของ DESIGN.md */
export const TAG_TONE: Record<string, string> = {
  red: 'pink', orange: 'coral', green: 'mint', blue: 'lilac', yellow: 'cream', purple: 'lilac',
};
export const tagTone = (color?: string | null) => TAG_TONE[String(color ?? '').toLowerCase()] ?? 'cream';
export const WAITING_TAG = 'รอเจ้าหน้าที่';

export const AI_STATUS: Record<string, { label: string; tone: 'lime' | 'mint' | 'cream' | 'pink' | 'coral' | 'lilac' }> = {
  sent: { label: 'ส่งแล้ว', tone: 'mint' },
  sent_staff: { label: 'ส่งแล้ว · รอแอดมิน', tone: 'lime' },
  suggested: { label: 'ร่าง (ยังไม่ส่ง)', tone: 'cream' },
  draft_staff: { label: 'ร่าง · รอแอดมิน', tone: 'lilac' },
  blocked: { label: 'ไม่ส่ง · ข้อมูลไม่ยืนยัน', tone: 'coral' },
  no_draft: { label: 'ไม่มีร่าง', tone: 'pink' },
};
export const aiStatus = (s: string) => AI_STATUS[s] ?? { label: s, tone: 'cream' as const };

export const ORDER_STATUS: Record<string, string> = {
  UNPAID: 'ยังไม่ชำระ', TO_PAY: 'ยังไม่ชำระ', READY_TO_SHIP: 'รอจัดส่ง', PROCESSED: 'เตรียมพัสดุแล้ว',
  RETRY_SHIP: 'รอจัดส่งใหม่', SHIPPED: 'กำลังจัดส่ง', TO_CONFIRM_RECEIVE: 'ถึงแล้ว รอกดรับ',
  COMPLETED: 'สำเร็จ', DELIVERED: 'ส่งถึงแล้ว', CANCELLED: 'ยกเลิก', TO_RETURN: 'กำลังคืนสินค้า',
  RETURNED: 'คืนแล้ว', IN_CANCEL: 'กำลังขอยกเลิก', INVALID: 'ไม่สมบูรณ์',
};

const TZ = 'Asia/Bangkok';
export function timeShort(t?: number | string | null) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toLocaleDateString('en-CA', { timeZone: TZ }) === now.toLocaleDateString('en-CA', { timeZone: TZ });
  return sameDay
    ? d.toLocaleTimeString('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('th-TH', { timeZone: TZ, day: 'numeric', month: 'short' });
}
export function timeFull(t?: number | string | null) {
  if (!t) return '';
  return new Date(t).toLocaleString('th-TH', {
    timeZone: TZ, day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
export function money(v: unknown, currency?: string | null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  const s = n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
  return currency === 'THB' || !currency ? `฿${s}` : `${s} ${currency}`;
}
export const initials = (name?: string | null) => (name ?? '?').trim().slice(0, 2).toUpperCase();
/** 09/21 11:36 — แบบเดียวกับในแอป Duoke */
export function timeStamp(t?: number | string | null) {
  if (!t) return '';
  const d = new Date(t);
  const p = (x: Intl.DateTimeFormatPartTypes) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).find(v => v.type === x)?.value;
  return `${p('month')}/${p('day')} ${p('hour')}:${p('minute')}`;
}
