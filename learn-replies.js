/**
 * learn-replies.js — ดูดแชทที่ "แอดมินเคยตอบจริง" มาเก็บเป็นข้อมูลให้ AI เลียนแบบ
 *
 *   npm run learn                 → อ่าน 80 ห้องล่าสุด เขียนลง knowledge/หัวข้อ/
 *   npm run learn -- --rooms 200  → อ่านมากขึ้น
 *   npm run learn -- --dry        → ดูผลก่อน ยังไม่เขียนไฟล์
 *
 * เก็บเป็นคู่ "ลูกค้าถาม → ร้านตอบ" เฉพาะที่แอดมินพิมพ์เอง
 * ข้อความ auto-reply สำเร็จรูปจะถูกกรองทิ้ง (ซ้ำเกิน 2 ครั้ง = ไม่ใช่คำตอบจริง)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi, parseMessageContent } from './duoke-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ROOMS = Number(argv('--rooms') || 80);
const DRY = args.includes('--dry');
const OUT = path.join(__dirname, 'knowledge', 'หัวข้อ', 'ตัวอย่างการตอบของแอดมิน.md');

const token = JSON.parse(fs.readFileSync(path.join(__dirname, '.token.json'), 'utf8')).token;
const api = new DuokeApi({ token });

const text = m => (parseMessageContent(m)?.text ?? '').trim();
const norm = s => s.replace(/\s+/g, ' ').trim();

let shops, conv;
try {
  shops = await api.getShops();
  conv = await api.queryConversationList({
    shopIdList: shops.map(s => s.id ?? s.shopId), size: ROOMS, offset: 0,
  });
} catch (err) {
  if (err?.code === 401 || err?.code === 403) {
    console.error('token หมดอายุแล้ว — รัน `npm run login` ก่อน แล้วค่อยรันคำสั่งนี้ใหม่');
    process.exit(1);
  }
  throw err;
}
const rooms = conv?.list ?? conv?.records ?? [];
console.log(`อ่าน ${rooms.length} ห้อง...`);

const pairs = [];
for (const c of rooms) {
  try {
    const hist = await api.getMessageList({
      shopId: c.shopId, conversationId: c.conversationId, platform: c.platform,
      pageNo: 1, pageSize: 50,
    });
    const msgs = (hist?.list ?? []).slice().reverse();
    for (let i = 1; i < msgs.length; i++) {
      const q = msgs[i - 1], a = msgs[i];
      if (q.fromAccountType !== 1 || a.fromAccountType === 1) continue;   // ลูกค้าถาม → ร้านตอบ
      const qt = norm(text(q)), at = norm(text(a));
      if (qt.length < 4 || at.length < 15) continue;      // สั้นเกินไปไม่ได้สาระ
      if (at.length > 400) continue;                       // ยาวผิดปกติ มักเป็นข้อความสำเร็จรูป
      pairs.push({ q: qt, a: at });
    }
  } catch { /* ห้องไหนอ่านไม่ได้ก็ข้าม */ }
}

// ข้อความสำเร็จรูปของร้าน/แพลตฟอร์ม และข้อความระบบ — ไม่ใช่คำตอบที่แอดมินคิดเอง
const CANNED_RE = new RegExp([
  'เรียนคุณลูกค้าที่เคารพ', 'นอกเวลาทำการ', 'ได้รับข้อความของ(คุณ|ท่าน)แล้ว',
  'กรุณารอสักครู่', 'ทีมงานของเรากำลังยุ่ง', 'ยินดีต้อนรับ',
  'มีอะไรให้ช่วยเหลือ', 'สอบถามด้านใด', 'ถามมาได้เลย',
  'ขอบคุณสำหรับความสนใจ', 'คลิกที่ "?ซื้อเลย', 'ติดตามคำสั่งซื้อ',
  'ลูกค้าติดตามร้าน', 'วันนี้มีอะไรให้เราช่วย',
  'has been assigned', 'chat has been', 'Baanthai Hardware CS',
].join('|'), 'i');

// ข้อความที่ร้านตอบซ้ำ = สำเร็จรูป ไม่ใช่คำตอบจริง (ซ้ำแม้ครั้งเดียวก็ตัด)
const answerCount = new Map();
for (const p of pairs) answerCount.set(p.a, (answerCount.get(p.a) ?? 0) + 1);
const real = pairs.filter(p => answerCount.get(p.a) === 1 && !CANNED_RE.test(p.a));

// ตัดคู่ที่คำถามซ้ำ เก็บอันแรกไว้
const seen = new Set();
const uniq = real.filter(p => { const k = p.q.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; });

console.log(`เจอคู่ถาม-ตอบ ${pairs.length} · ตัด auto-reply เหลือ ${real.length} · ไม่ซ้ำ ${uniq.length}`);

const body = [
  'keywords: ' + ['ตัวอย่างการตอบ', 'สำนวน', 'แอดมิน'].join(', '),
  '',
  '# ตัวอย่างคำตอบที่แอดมินเคยตอบลูกค้าจริง',
  '',
  'ใช้เป็นแนวสำนวนและน้ำเสียง ไม่ใช่ข้อเท็จจริง — ถ้าเนื้อหาขัดกับไฟล์ข้อมูลร้าน ให้ยึดไฟล์ข้อมูลร้าน',
  '',
  ...uniq.slice(0, 60).flatMap(p => [`- ลูกค้า: ${p.q}`, `  ร้าน: ${p.a}`, '']),
].join('\n');

if (DRY) {
  console.log('\n--- ตัวอย่าง 8 คู่แรก ---');
  for (const p of uniq.slice(0, 8)) console.log(`  ลูกค้า: ${p.q}\n  ร้าน  : ${p.a}\n`);
  console.log(`(--dry ไม่เขียนไฟล์) ถ้าพอใจให้รัน: npm run learn`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  console.log(`เขียนแล้ว: ${path.relative(__dirname, OUT)} (${body.length} ตัวอักษร · ${Math.min(uniq.length, 60)} คู่)`);
}
