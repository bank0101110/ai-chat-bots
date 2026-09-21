/**
 * watch.js — ล็อกอินก่อน แล้วต่อ realtime เพื่อ log ทุกครั้งที่มีคนแชทเข้ามา
 *
 *   npm run dev      (nodemon — รีสตาร์ตอัตโนมัติเวลาแก้โค้ด)
 *   npm start        (node เฉย ๆ)
 *
 * ตั้งค่าใน .env:
 *   DUOKE_EMAIL=you@example.com     ← จำเป็น
 *   DUOKE_PASSWORD=...              ← จำเป็น
 *   ONLY_BUYER=true                 ← log เฉพาะข้อความจากลูกค้า (default: true)
 *   LOG_FILE=                       ← เว้นว่าง = ขึ้นจออย่างเดียว ไม่เขียนไฟล์ (ค่าเริ่มต้น)
 *   SHOW_CONVERSATIONS=false        ← log ตอนรายการห้องแชทอัปเดตด้วย
 *   LOG_CONSOLE_MAX=160             ← ย่อข้อความบนจอกี่ตัวอักษร
 *   LOG_RAW=false                   ← ดัมป์ JSON ดิบของทุกข้อความ (รกมาก เปิดเฉพาะตอนดีบั๊ก)
 *
 * เรื่อง log: จัดเป็นบล็อกต่อห้องแชท — ขึ้นหัวว่า "ร้าน·แพลตฟอร์ม ชื่อลูกค้า" หนึ่งครั้ง
 * แล้วข้อความกับสิ่งที่บอททำอยู่ย่อหน้าใต้หัวนั้น จะได้รู้ว่ากำลังคุยกับใครอยู่
 *
 * ลำดับการทำงาน:
 *   1. หา token ที่ใช้ได้ — จากแคช .token.json ก่อน ถ้าใช้ไม่ได้ค่อยล็อกอินด้วย email/password
 *      (ขั้นล็อกอินมีแคปช่ารูปภาพ ต้องพิมพ์เอง — เกิดขึ้นเฉพาะตอน token หมดอายุ ไม่ใช่ทุกครั้งที่รัน)
 *   2. เอา token ที่ได้ไปต่อ REST + socket.io
 *   3. ระหว่างทางถ้าเจอ 401 → ล็อกอินใหม่แล้วต่อ socket ใหม่ให้เอง
 */

// ⚠ ต้องเป็นบรรทัดแรกสุด — โหลด .env ก่อนโมดูลอื่นที่อ่าน process.env ตอน import
// (ai-bot.js อ่านค่า AI_* ตอน import ถ้าโหลด .env ทีหลังค่าจะไม่มีผล)
import './env.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi, parseMessageContent } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';
import { getSession, refreshSession, watchSharedSession } from './duoke-session.js';
import { recordEvent, aiBlockedByUi } from './db-log.js';
import * as ai from './ai-bot.js';
import { writeInbox } from './inbox-store.js';
import { collectAdminExamples } from './admin-examples.js';
import { waitingForStaff } from './waiting-staff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- .env

loadEnv(path.join(__dirname, '.env'));

const EMAIL = process.env.DUOKE_EMAIL;
const PASSWORD = process.env.DUOKE_PASSWORD;
const ONLY_BUYER = (process.env.ONLY_BUYER ?? 'true') !== 'false';
const SHOW_CONVERSATIONS = process.env.SHOW_CONVERSATIONS === 'true';
const AUTO_TAG = (process.env.AUTO_TAG ?? 'true') !== 'false';
const AUTO_TAG_NAME = process.env.AUTO_TAG_NAME || 'รอเจ้าหน้าที่';
const AUTO_TAG_AI_NAME = process.env.AUTO_TAG_AI_NAME || 'AI ตอบ';
// ตามเก็บห้องที่ "ยังไม่อ่าน" — ลูกค้าทักมาก่อนบอทออนไลน์ แชทเด้งจับไม่ได้
// ห้องที่ AI ตอบไม่เคลียร์ ทำเป็น "ยังไม่อ่าน" ให้เจ้าหน้าที่เห็นค้างในลิสต์
const MARK_UNREAD = (process.env.MARK_UNREAD_ON_STAFF ?? 'true') !== 'false';
const CATCHUP = (process.env.CATCHUP_UNREAD ?? 'true') !== 'false';
const CATCHUP_LIMIT = Number(process.env.CATCHUP_LIMIT || 100);     // ตอบได้สูงสุดกี่ห้องต่อรอบ
const CATCHUP_PAGES = Number(process.env.CATCHUP_PAGES || 10);      // ไล่รายการห้องได้กี่หน้า (หน้าละ 100)
const CATCHUP_DAYS = Number(process.env.CATCHUP_DAYS || 3);         // ย้อนหลังไม่เกินกี่วัน
const CATCHUP_EVERY_MIN = Number(process.env.CATCHUP_EVERY_MIN || 15); // วนซ้ำทุกกี่นาที (0=ครั้งเดียว)

// แท็กเคสใบกำกับภาษี — ติดต่อเมื่อลูกค้า "ขอ" ใบกำกับเท่านั้น แล้วแยกตามยอดสั่งซื้อ
const TAG_INVOICE_NAME = process.env.AUTO_TAG_INVOICE_NAME || 'green';            // ยอดถึงเกณฑ์
const TAG_SLIP_NAME = process.env.AUTO_TAG_SLIP_NAME || 'ขอสลิปออนไลน์';          // ยอดไม่ถึง
// ห้องเดิมส่ง "คำตอบเบื้องต้น" ซ้ำได้เร็วสุดกี่นาที (ลูกค้ามักพิมพ์รัวหลายข้อความติดกัน)
const CARD_COOLDOWN_MS = Number(process.env.AI_CARD_COOLDOWN_MIN || 60) * 60_000;
const HOLDING_COOLDOWN_MS = Number(process.env.AI_HOLDING_COOLDOWN_MIN || 30) * 60_000;
// Console only: ignore legacy LOG_FILE settings. State/deduplication files are separate.
const LOG_FILE = null;
// ในไฟล์ log เก็บข้อความเต็มเสมอ (ไม่ตัด …) ส่วนบนจอย่อให้อ่านง่ายตาม LOG_CONSOLE_MAX
const LOG_CONSOLE_MAX = Number(process.env.LOG_CONSOLE_MAX || 160);
// เขียน JSON ดิบของทุกข้อความ + ข้อมูลห้องแชทลงไฟล์ log ด้วย (ปิดด้วย LOG_RAW=false)
const LOG_RAW = (process.env.LOG_RAW ?? 'true') !== 'false';
// แนบคำสั่งซื้อจริงของลูกค้าให้ AI: auto = เฉพาะตอนลูกค้าถามเรื่องออร์เดอร์ · always · off
const ORDER_CONTEXT = (process.env.AI_ORDER_CONTEXT || 'auto').toLowerCase();

const LOGIN_METHOD = (process.env.DUOKE_LOGIN || 'browser').toLowerCase();
// โหมด browser: พิมพ์รหัสผ่านในเบราว์เซอร์เอง จึงไม่บังคับ DUOKE_PASSWORD ใน .env
if (!EMAIL || (LOGIN_METHOD === 'terminal' && !PASSWORD)) {
  console.error(`
❌ ยังไม่ได้ตั้งค่าบัญชี

  1. copy .env.example .env        (macOS/Linux: cp .env.example .env)
  2. เปิด .env แล้วใส่

     DUOKE_EMAIL=you@example.com${LOGIN_METHOD === 'terminal' ? '\n     DUOKE_PASSWORD=รหัสผ่านของคุณ' : '     (รหัสผ่านพิมพ์ในเบราว์เซอร์ตอนล็อกอิน)'}
`);
  process.exit(1);
}

// ------------------------------------------------------------------ helpers

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const PLATFORM_COLOR = {
  shopee: C.red, tiktok: C.magenta, lazada: C.blue,
  daraz: C.yellow, tokopedia: C.green, facebook: C.blue,
  whatsapp: C.green, shopify: C.cyan, mercado: C.yellow,
};

function ts() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', hour12: false,
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ---- log เป็น JSON บรรทัดละอีเวนต์ (JSON Lines) ----
// ไม่มีอีโมจิ ไม่มีสี — เอาไปกรองด้วย jq / grep / ส่งเข้าระบบเก็บ log ได้ตรง ๆ
//   node watch.js | jq -c 'select(.event=="ai_reply")'
// ทุกอีเวนต์ที่เกิดในห้องแชทจะมี shop/platform/buyer/conversationId ติดไปด้วยเสมอ
// จะได้รู้ทันทีว่าเป็นของลูกค้าคนไหน ไม่ต้องไล่ดูบรรทัดก่อนหน้า

/** พิมพ์ 1 อีเวนต์ */
function out(obj) {
  const line = JSON.stringify({ time: ts(), ...obj }, null, obj.event === 'ai_reply' ? 2 : undefined);
  console.log(line);
  recordEvent(obj);                 // บันทึกลง Supabase ให้ UI เปิดดูย้อนหลัง (ไม่ได้ตั้ง DATABASE_URL = ข้าม)
}

// viewConversation ไม่คืน buyerNick มาให้ (ชื่อลูกค้ามาจากลิสต์ห้องหรือ socket เท่านั้น)
// จึงจำไว้ครั้งแรกที่รู้ แล้วใช้กับอีเวนต์ถัด ๆ ไปของห้องเดียวกัน
const buyerNames = new Map();

/** พิมพ์อีเวนต์ที่ผูกกับห้องแชท — เติมข้อมูลห้องให้อัตโนมัติ */
function outRoom(e, info, obj) {
  const cid = e?.conversationId;
  const nick = info?.buyerNick ?? convCache.get(cid)?.buyerNick;
  if (nick) buyerNames.set(cid, nick);
  out({
    shop: info?.shopName ?? shopNameOf(e?.shopId) ?? e?.shopId,
    platform: e?.platform,
    shopId: e?.shopId,
    buyer: buyerNames.get(cid) ?? cid,
    conversationId: cid,
    replyTo: e?.replyTo,
    result: obj.event === 'ai_reply' ? ({
      sent: 'ส่งคำตอบแล้ว', sent_staff: 'ส่งคำตอบแล้ว รอเจ้าหน้าที่ดูต่อ',
      suggested: 'ร่างเท่านั้น ยังไม่ได้ส่ง', draft_staff: 'ร่างเท่านั้น รอเจ้าหน้าที่',
      blocked: 'ไม่ส่งร่าง ข้อมูลยังยืนยันไม่ได้', no_draft: 'ยังไม่มีร่างคำตอบ',
    }[obj.status] ?? obj.status) : undefined,
    ...obj,
  });
}

function log(line, plain = null) {
  console.log(line);
}

/** เขียนลงไฟล์ log อย่างเดียว ไม่ขึ้นจอ (ใช้กับ JSON ดิบที่ยาวมาก) */
function logFile(_text) {} // Legacy raw-log callers intentionally do not persist chat data.

/**
 * log บรรทัดที่มีเนื้อความยาว — บนจอย่อให้พอดีตา แต่ในไฟล์เก็บเต็มไม่ตัด
 * (ชื่อสินค้าบน Shopee ยาว 100+ ตัวอักษร ถ้าตัดจะหาย่อไม่รู้ว่าลูกค้าถามตัวไหน)
 */
function logLong(prefix, body) {
  const full = String(body ?? '');
  log(`${prefix}${preview(full, LOG_CONSOLE_MAX)}`, stripAnsi(`${prefix}${oneLine(full)}`));
}

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const oneLine = s => String(s ?? '').replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim();

/** อ่าน .env แบบง่าย ไม่ต้องลง dotenv */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      if (v.startsWith('#')) v = '';           // ทั้งบรรทัดหลัง = เป็นคอมเมนต์ → ถือว่าไม่ได้ตั้งค่า

      const h = v.search(/[ 	]#/);           // ตัดคอมเมนต์ท้ายบรรทัด (เว้นวรรค + #)
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

/** ชื่อร้านจาก shopId (เผื่อ info ไม่มีมาให้ เช่นตอนตามเก็บห้องค้าง) */
function shopNameOf(shopId) {
  return shopList.find(s => String(s.id ?? s.shopId) === String(shopId))?.shopName;
}
let shopList = [];

function preview(text, max = LOG_CONSOLE_MAX) {
  const one = oneLine(text);
  return one.length > max ? one.slice(0, max) + '…' : one;
}

const CURRENCY_NAME = { THB: 'บาท', USD: 'ดอลลาร์', SGD: 'ดอลลาร์สิงคโปร์', MYR: 'ริงกิต', VND: 'ดอง', IDR: 'รูเปียห์' };

/** "1089.00000" → "1089 บาท" · "132.50000" → "132.50 บาท" */
function money(price, currency) {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price ?? '').trim();
  return `${Number.isInteger(n) ? n : n.toFixed(2)} ${CURRENCY_NAME[currency] ?? currency ?? ''}`.trim();
}

/** ต่อเป็น "ก: ข · ค: ง" เฉพาะช่องที่มีค่า */
const fields = pairs => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`).join(' · ');

/** การ์ดสินค้า — Shopee ใช้ messageType 'item', TikTok ใช้ 'goods_card', อื่น ๆ ใช้ 'product' */
const itemCard = c => fields([
  ['ชื่อ', oneLine(c.title)],
  ['ตัวเลือก', oneLine(c.skuValue ?? c.skuName)],
  ['ราคา', c.price ? money(c.price, c.currency) : ''],
  ['ราคาเดิม', c.originalPrice && c.originalPrice !== c.price ? money(c.originalPrice, c.currency) : ''],
  ['จำนวน', c.quantity],
  ['พรีออเดอร์', Number(c.isPreOrder) ? 'ใช่' : ''],
  ['itemId', c.itemId],
  ['ลิงก์', c.actionUrl || c.itemUrl || ''],
]);

/** การ์ดออร์เดอร์ — 'order' (Shopee/Lazada) หรือ 'order_card' (TikTok) */
const orderCard = c => fields([
  ['orderId', c.orderId ?? c.orderSn ?? c.orderNumber],
  ['สินค้า', oneLine(c.productName ?? c.title ?? c.itemTitle)],
  ['ตัวเลือก', oneLine(c.skuValue ?? c.skuName)],
  ['ราคา', c.price ? money(c.price, c.currency) : ''],
  ['ยอดรวม', c.totalAmount ? money(c.totalAmount, c.currency) : ''],
  ['จำนวน', c.quantity],
  ['สถานะ', oneLine(c.statusText ?? c.status)],
  ['ลิงก์', c.actionUrl || ''],
]);

/**
 * บรรยายข้อความ 1 ข้อความ — ค่าที่คืนไปใช้กับ logLong() ซึ่งจะย่อเฉพาะบนจอ
 * ส่วนในไฟล์ log ได้ข้อความเต็ม (ชื่อสินค้ายาว ๆ ไม่โดนตัด)
 */
function describe(msg) {
  const c = parseMessageContent(msg) || {};
  const tag = t => `${C.dim}[${t}]${C.reset} `;
  // ชนิดข้อความต่างแพลตฟอร์ม: shopee=item/file_image/unknown · tiktok=goods_card/order_card · lazada=1/10007
  switch (String(msg.messageType)) {
    case 'text':
    case 'attachment_text':
    case '1': return oneLine(c.text) + (c.translateTxt ? ` ${C.dim}(แปล: ${oneLine(c.translateTxt)})${C.reset}` : '');
    case 'image':
    case 'file_image':
    case 'attachment_image': return tag('รูปภาพ') + (c.imageUrl ?? c.url ?? c.fileUrl ?? '');
    case 'video': return tag('วิดีโอ') + (c.videoUrl ?? '');
    case 'sticker': return tag('สติกเกอร์') + (c.imageUrl ?? '');
    case 'item':
    case 'goods_card':
    case 'product': return tag('การ์ดสินค้า') + (itemCard(c) || JSON.stringify(c));
    case 'order':
    case 'order_card':
    case '10007': return tag('การ์ดออร์เดอร์') + (orderCard(c) || JSON.stringify(c));
    case 'voucher': return tag('คูปอง') + fields([['promotionId', c.promotionId], ['ชื่อ', oneLine(c.title)], ['ส่วนลด', c.discountValue]]);
    case 'file': return tag('ไฟล์') + fields([['ชื่อไฟล์', c.fileName], ['ลิงก์', c.fileUrl ?? c.url]]);
    // ชนิดที่ยังไม่รู้จัก → ทิ้ง JSON เต็มไว้ในไฟล์ log จะได้เพิ่ม case ทีหลังได้
    default: return tag(msg.messageType) + (oneLine(c.text) || JSON.stringify(c));
  }
}

const isAuthError = err => err?.code === 401 || err?.code === 403 || /401|403/.test(err?.message ?? '');

// --------------------------------------------------------------------- state

const convCache = new Map();        // conversationId -> conversation object
const seenMessageIds = new Set();   // กัน log ซ้ำ
// conversationId → messageId ล่าสุดของลูกค้าที่ตอบไปแล้ว (กันตอบซ้ำ)
// เก็บลงไฟล์ด้วย — บอทยอมตอบต่อจากข้อความของบอทเอง ถ้ารีสตาร์ตแล้วลืม จะตอบคำถามเดิมซ้ำ
const ANSWERED_FILE = path.join(__dirname, '.answered.json');
let answeredMsgId = new Map();
try {
  answeredMsgId = new Map(Object.entries(JSON.parse(fs.readFileSync(ANSWERED_FILE, 'utf8'))));
} catch { /* ไฟล์ยังไม่มี */ }
let answeredDirty = false;

// ---- จำว่าห้องไหนจัดการไปแล้วถึงเมื่อไหร่ (เก็บลงไฟล์) ----
// ⚠ เดิมจำในหน่วยความจำอย่างเดียว พอรีสตาร์ตบอทก็ลืมหมด แล้วไล่ตอบห้องเก่าซ้ำทั้งหมด
// ยิ่งบอทเป็นคนทำห้องให้เป็น "ยังไม่อ่าน" เอง ห้องนั้นจะถูกหยิบมาใหม่ทุกรอบไม่รู้จบ
// เก็บเป็น conversationId → เวลาที่จัดการล่าสุด แล้วข้ามห้องที่ไม่มีข้อความใหม่กว่านั้น
const HANDLED_FILE = path.join(__dirname, '.handled.json');
let handledAt = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf8'));
  handledAt = new Map(Object.entries(raw));
} catch { /* ไฟล์ยังไม่มี = เริ่มใหม่ */ }

let handledDirty = false;
function markHandled(conversationId) {
  handledAt.set(conversationId, Date.now());
  handledDirty = true;
}
/** เขียนลงไฟล์เป็นระยะ + ตัดของเก่าที่พ้นช่วงตามเก็บไปแล้ว */
function saveHandled() {
  if (!handledDirty) return;
  handledDirty = false;
  const cutoff = Date.now() - CATCHUP_DAYS * 86400_000;
  for (const [k, v] of handledAt) if (v < cutoff) handledAt.delete(k);
  fs.writeFile(HANDLED_FILE, JSON.stringify(Object.fromEntries(handledAt)), () => {});
}
function saveAnswered() {
  if (!answeredDirty) return;
  answeredDirty = false;
  fs.writeFile(ANSWERED_FILE, JSON.stringify(Object.fromEntries(answeredMsgId)), () => {});
}
setInterval(saveAnswered, 30_000).unref();
setInterval(saveHandled, 30_000).unref();
const sentCards = new Map();        // conversationId → Map(itemId → เวลาที่ส่ง) กันส่งการ์ดสินค้าซ้ำ
// แคชออร์เดอร์สั้น ๆ ต่อห้อง — เดิม tagInvoiceCase กับ orderContextFor ยิง getOrderList คนละครั้ง
// ทั้งที่เป็นข้อมูลชุดเดียวกัน ทำให้ช้าและเปลือง API เปล่า ๆ
const orderCache = new Map();       // conversationId → { at, list }
const ORDER_CACHE_MS = 60_000;
async function ordersFor(e, buyerId) {
  if (!buyerId) return [];
  const hit = orderCache.get(e.conversationId);
  if (hit && Date.now() - hit.at < ORDER_CACHE_MS) return hit.list;
  const res = await api.getOrderList({ shopId: e.shopId, buyerId, platform: e.platform, pageSize: 5 });
  const list = res?.list ?? [];
  orderCache.set(e.conversationId, { at: Date.now(), list });
  if (orderCache.size > 500) orderCache.clear();
  return list;
}
const holdingSentAt = new Map();    // conversationId -> เวลาที่ส่ง "คำตอบเบื้องต้น" ล่าสุด (กันส่งซ้ำ)
let api = null;
let rt = null;
let stopping = false;
let autoTagId = null;               // tagId ของ "รอเจ้าหน้าที่" (resolve ตอน start)
let aiTagId = null;                 // tagId ของ "AI ตอบ" (resolve ตอน start ถ้าเปิด AI)
let invoiceTagId = null;            // tagId ของแท็กใบกำกับ (ยอดถึงเกณฑ์)
let slipTagId = null;               // tagId ของแท็กสลิปออนไลน์ (ยอดไม่ถึง)
let myPuid = null;                  // puid ของบัญชี — ใช้ตอนส่งข้อความกลับ
let myUid = null;                   // uid ของบัญชี — ใช้แยกว่าข้อความฝั่งร้านเป็นของบอทเราหรือคนอื่น

// ---------------------------------------------------------------- ขั้นที่ 1: login

async function authenticate({ staleToken } = {}) {
  // staleToken = token ที่เพิ่งโดน 401 — ถ้าโปรเซสอื่น (เช่น ui-server) ล็อกอินไปแล้ว จะได้ token ตัวใหม่
  // จาก .token.json ทันที ไม่ล็อกอินซ้ำ (ล็อกอินซ้ำ = token ของโปรเซสอื่นโดนเตะ)
  const s = staleToken
    ? await refreshSession(staleToken, { email: EMAIL, password: PASSWORD })
    : await getSession({ email: EMAIL, password: PASSWORD });
  const how = { cache: 'ใช้ token ที่แชร์ไว้', env: 'ใช้ DUOKE_TOKEN จาก .env', login: 'ล็อกอินใหม่', shared: 'ใช้ token ที่โปรเซสอื่นเพิ่งล็อกอิน' }[s.source];
  const left = s.expAt ? ` (เหลืออีก ~${Math.floor((s.expAt - Date.now()) / 86400000)} วัน)` : '';
  out({ event: 'login', how: stripAnsi(how).trim(), detail: stripAnsi(left).trim() || undefined });
  return s;
}

// ------------------------------------------------- ขั้นที่ 2: ต่อ REST + socket

async function getConvInfo({ shopId, conversationId, platform }) {
  if (convCache.has(conversationId)) return convCache.get(conversationId);
  try {
    const v = await api.viewConversation({ shopId, conversationId, platform });
    const info = v?.dkConversationVO ?? v ?? {};
    convCache.set(conversationId, info);
    return info;
  } catch (err) {
    if (isAuthError(err)) relogin();
    return {};
  }
}

// เพิ่มแท็กให้ห้องแชท (idempotent — มีอยู่แล้วไม่ทำซ้ำ)
// tagId → ชื่อแท็ก (โหลดรายการแท็กทั้งบัญชีไว้ตอนเริ่ม) เพื่อให้ log อ่านรู้เรื่อง
let tagNameById = new Map();
function tagName(id) {
  return tagNameById.get(String(id)) ?? String(id);
}

async function addConversationTag(e, info, tagId, label) {
  if (!tagId) return;
  try {
    // ⚠ ห้ามส่งรายการแท็กจาก cache — updateConversationTag เป็นการ "เขียนทับทั้งชุด"
    // ถ้าเจ้าหน้าที่เพิ่งติดแท็กในเว็บหลังจากบอทแคชไว้ แท็กนั้นจะถูกลบทิ้ง
    // ปล่อยให้ addTagToConversation ไปอ่านของสด ๆ เองทุกครั้ง (แลกกับ API อีก 1 ครั้ง)
    const before = info.tagIdList ?? info.dkConversationVO?.tagIdList;
    const newList = await api.addTagToConversation({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
      tagId,
    });
    info.tagIdList = newList;         // อัปเดต cache
    if (newList.includes(tagId)) {
      // log แท็กทั้งชุดก่อน/หลัง เพื่อให้ตรวจย้อนได้ว่าไม่มีของใครหายไป
      outRoom(e, info, {
        event: 'tag_add',
        tag: label,
        tagsBefore: Array.isArray(before) ? before.map(tagName) : undefined,
        tagsAfter: newList.map(tagName),
      });
    }
  } catch (err) {
    if (isAuthError(err)) return relogin();
    out({ event: 'warn', what: 'ติดแท็ก', error: err.message });
  }
}

// ⚠ บอทไม่มีฟังก์ชันลบแท็กโดยตั้งใจ — "เพิ่มอย่างเดียว ห้ามลบ"
// แม้แต่แท็กที่บอทติดเอง ก็ให้เจ้าหน้าที่เป็นคนลบเท่านั้น
// (ถ้าจะเพิ่มกลับมาในอนาคต ระวัง updateConversationTag ที่เขียนทับทั้งชุด ดู duoke-api.js)

// ส่ง "คำตอบเบื้องต้น" ให้ลูกค้าตอนที่ยังไม่มีคำตอบที่ส่งได้จริง (เคสละเอียดอ่อนที่ร่างยืนยันไม่ได้ /
// AI ร่างไม่ได้ / โหมดคิวรอคนตอบ) — ลูกค้าจะได้ไม่เงียบระหว่างรอเจ้าหน้าที่
// กันสแปม: ห้องหนึ่งส่งได้ครั้งเดียวต่อ HOLDING_COOLDOWN_MS (ลูกค้ามักพิมพ์รัวหลายข้อความติดกัน)
async function skipWaitingStaff(e, info) {
  try {
    const ids = [...tagNameById].filter(([, name]) => name === AUTO_TAG_NAME || name === 'รอเจ้าหน้าที่').map(([id]) => id);
    if (autoTagId) ids.push(autoTagId);
    if (!await waitingForStaff(api, { shopId: e.shopId, conversationId: e.conversationId, platform: e.platform }, AUTO_TAG_NAME, ids)) return false;
    outRoom(e, info, { event: 'ai_skip', reason: 'ติดแท็กรอเจ้าหน้าที่แล้ว', tag: AUTO_TAG_NAME });
  } catch (err) {
    outRoom(e, info, { event: 'ai_skip', reason: 'ตรวจแท็กไม่ได้ พักการตอบก่อน', error: shortError(err) });
  }
  return true;
}

async function sendHolding(e) {
  if (!ai.autoSend()) return false;
  if (await skipWaitingStaff(e)) return false;
  const current = await api.getMessageList({ ...e, pageNo: 1, pageSize: 30 });
  if (!current?.list?.length || humanAfterBuyer(current.list.slice().reverse())) return false;
  const text = ai.holdingMessage();
  if (!text) return false;

  const last = holdingSentAt.get(e.conversationId) ?? 0;
  if (Date.now() - last < HOLDING_COOLDOWN_MS) {
    outRoom(e, null, { event: 'holding', skipped: 'ส่งไปแล้วเมื่อไม่นานนี้' });
    return false;
  }
  try {
    await rt.sendText({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
      text, puid: myPuid,
    });
    if (holdingSentAt.size > 1000) holdingSentAt.clear();
    holdingSentAt.set(e.conversationId, Date.now());
    outRoom(e, null, { event: 'holding', sent: true, text: oneLine(text) });
    return true;
  } catch (err) {
    if (isAuthError(err)) relogin();
    else outRoom(e, null, { event: 'holding', sent: false, error: err.message });
    return false;
  }
}

/**
 * ดึงคำสั่งซื้อจริงของลูกค้าห้องนี้จาก Duoke มาให้ AI ใช้ตอบ
 *
 * ดึงเมื่อลูกค้าถามเรื่องออร์เดอร์/พัสดุ/ใบกำกับ หรือส่งการ์ดคำสั่งซื้อมาเท่านั้น (AI_ORDER_CONTEXT=auto)
 * ตั้ง always = ดึงทุกครั้งที่ลูกค้าทัก · off = ไม่ดึงเลย
 * ต้องมี buyerId (อยู่ใน conversation) ไม่งั้น Duoke คืน list ว่าง
 */
async function orderContextFor(e, info, messages) {
  if (ORDER_CONTEXT === 'off') return '';
  const buyerId = info.buyerId ?? info.dkConversationVO?.buyerId;
  if (!buyerId) return '';

  if (ORDER_CONTEXT !== 'always') {
    const lastBuyer = [...messages].reverse().filter(m => m.fromAccountType === 1).slice(0, 3);
    if (!lastBuyer.some(m => ai.needsOrderInfo(m))) return '';
  }

  try {
    const list = await ordersFor(e, buyerId);
    const text = ai.formatOrders(list);
    if (text) outRoom(e, info, { event: 'order_context', orders: list.length });
    return text;
  } catch (err) {
    if (isAuthError(err)) relogin();
    out({ event: 'warn', what: 'ดึงออร์เดอร์', error: err.message });
    return '';
  }
}

/**
 * ลูกค้าขอใบกำกับภาษี → ติดแท็กตามยอดสั่งซื้อ
 *   ยอด >= เกณฑ์ (1000)  → แท็ก "green"           (ออกใบกำกับได้)
 *   ยอดต่ำกว่าเกณฑ์       → แท็ก "ขอสลิปออนไลน์"
 * ติดต่อเมื่อลูกค้า "ขอ" เท่านั้น และต้องรู้ยอดจริง ไม่รู้ยอด = ไม่ติด (กันติดผิด)
 */
async function tagInvoiceCase(e, info, messages) {
  if (!AUTO_TAG || (!invoiceTagId && !slipTagId)) return;
  if (!ai.invoiceTagFor) return;

  // ยิง API ดึงออร์เดอร์เฉพาะตอนลูกค้าพูดถึงใบกำกับจริง ๆ จะได้ไม่เปลืองทุกข้อความ
  const asked = messages.some(m => m.fromAccountType === 1
    && /ใบกำกับ|ใบเสร็จ|ใบเสด|vat|แวท/i.test(parseMessageContent(m)?.text ?? ''));
  if (!asked) return;

  // ยอดจากออร์เดอร์จริงใน Duoke — แม่นกว่าตัวเลขที่ลูกค้าพิมพ์
  let orders = [];
  const buyerId = info.buyerId ?? info.dkConversationVO?.buyerId;
  if (buyerId) {
    try {
      orders = await ordersFor(e, buyerId);
    } catch { /* ดึงไม่ได้ก็ใช้ยอดที่ลูกค้าพิมพ์แทน */ }
  }

  const hit = ai.invoiceTagFor({ messages, orders });
  if (!hit) return;

  const tagId = hit.kind === 'invoice' ? invoiceTagId : slipTagId;
  const label = hit.kind === 'invoice' ? TAG_INVOICE_NAME : TAG_SLIP_NAME;
  if (!tagId) return;
  outRoom(e, info, { event: 'invoice_tag', amount: hit.amount, source: hit.from, tag: label });
  await addConversationTag(e, info, tagId, label);
}

/**
 * หา groupId ของห้อง (ต้องใช้กับคำสั่งทาง socket)
 * ⚠ viewConversation ไม่คืน groupId มาให้ (เช็คแล้ว 0/6 ห้อง) ต้องหาจากทางอื่น:
 *   1. อ็อบเจ็กต์ห้องที่ได้จาก queryConversationList / socket event 'conversations'
 *   2. claimConversation — ได้แน่นอน แต่ยิง API เพิ่ม จึงใช้เป็นทางสุดท้าย
 *      (เส้นทางที่ส่งข้อความอยู่แล้วก็เรียกตัวนี้อยู่ดี ไม่ได้เพิ่มผลข้างเคียงใหม่)
 */
async function resolveGroupId(e, info) {
  const fromInfo = info?.groupId ?? info?.dkConversationVO?.groupId;
  if (fromInfo) return fromInfo;
  const cached = convCache.get(e.conversationId);
  if (cached?.groupId) return cached.groupId;
  try {
    const claimed = await api.claimConversation({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
    });
    if (claimed?.groupId) {
      if (info) info.groupId = claimed.groupId;      // จำไว้ ไม่ต้องยิงซ้ำ
      return claimed.groupId;
    }
  } catch { /* หาไม่ได้ก็ไม่เป็นไร */ }
  return null;
}

/**
 * ทำเครื่องหมาย "ยังไม่อ่าน" ให้ห้องที่ AI ตอบไม่เคลียร์ — เจ้าหน้าที่จะได้เห็นค้างในลิสต์
 * ใช้ groupId ของห้องแปลงเป็น TIM conversationID (GROUP_<groupId>)
 * ไม่เรียก claimConversation เพื่อหา groupId เพราะการ claim อาจไปทำให้ห้องนับว่าอ่านแล้ว
 */
async function markUnread(e, info) {
  if (!MARK_UNREAD) return;
  const groupId = await resolveGroupId(e, info);
  if (!groupId) {
    outRoom(e, info, { event: 'mark_unread', ok: false, error: 'หา groupId ไม่เจอ' });
    return;
  }
  try {
    await rt.markConversation({
      conversationIDList: [`GROUP_${groupId}`],
      markType: 2,                          // 1=ดาว · 2=ยังไม่อ่าน · 3=พับ
      enableMark: true,
    });
    outRoom(e, info, { event: 'mark_unread', ok: true });
  } catch (err) {
    outRoom(e, info, { event: 'mark_unread', ok: false, error: err.message });
  }
}

// ---- คิวงาน AI: ทำทีละห้อง เว้นจังหวะ ไม่ยิงรวดเดียว ----
// เดิมตามเก็บห้องค้างยิง AI 20 ห้องติดกันจนโดน 429 quota (ทั้งลิมิตต่อนาทีและต่อวัน)
// คิวนี้บังคับให้มีงาน AI แค่ 1 งานทำอยู่เสมอ และหน่วงระหว่างงานตาม AI_QUEUE_DELAY_MS
const QUEUE_DELAY_MS = Number(process.env.AI_QUEUE_DELAY_MS || 1500);
const QUEUE_MAX = Number(process.env.AI_QUEUE_MAX || 200);      // คิวยาวเกินนี้ทิ้งงานใหม่
const RETRY_429_MAX = Number(process.env.AI_RETRY_429 || 2);    // โดนจำกัดโควตาแล้วลองใหม่กี่ครั้ง

const aiQueue = [];
const activeRooms = new Set();
const pendingLive = new Map();
const seenInQueue = new Set();          // กันห้องเดิมเข้าคิวซ้ำระหว่างที่ยังไม่ได้ทำ

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isRateLimit = err => err?.status === 429 || /429|quota|rate limit/i.test(err?.message ?? '');

/** ย่อ error ยาว ๆ (429 ของ Google ยาวเป็นหน้า) ให้เหลือใจความ + ลิมิตที่ชนและเวลาที่ต้องรอ */
function shortError(err) {
  const m = String(err?.message ?? err);
  const limit = /limit: (\d+)/.exec(m)?.[1];
  const retry = /retry in ([\d.]+)s/i.exec(m)?.[1];
  const quotaId = /"quotaId":"([^"]+)"/.exec(m)?.[1];
  if (limit || retry) {
    return [
      'โควตาเต็ม',
      limit ? `ลิมิต ${limit}` : '',
      quotaId ? `(${quotaId})` : '',
      retry ? `· ลองใหม่ใน ${Math.ceil(Number(retry))} วิ` : '',
    ].filter(Boolean).join(' ');
  }
  return m.replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * เอาห้องเข้าคิวให้ AI จัดการ (ไม่ต้อง await — คิวจะทยอยทำเอง)
 * live=true คือลูกค้าเพิ่งทักเข้ามาสด ๆ → แทรกหน้าคิวและไม่ต้องหน่วง
 * เพราะถ้าต่อท้ายหลังห้องค้าง 20 ห้อง ลูกค้าจะรอเป็นนาที
 */
function enqueueRoom(e, info, note, live = false) {
  const cid = e.conversationId;
  if (activeRooms.has(cid)) {
    if (live) pendingLive.set(cid, { e, info, note });
    return;
  }
  const queued = aiQueue.findIndex(j => j.e.conversationId === cid);
  if (queued >= 0 && live) {
    const [job] = aiQueue.splice(queued, 1);
    Object.assign(job, { e, info, note, live: true });
    const at = aiQueue.findIndex(j => !j.live);
    aiQueue.splice(at < 0 ? aiQueue.length : at, 0, job);
    runQueue();
    return;
  }
  if (seenInQueue.has(cid)) return;                 // อยู่ในคิวอยู่แล้ว
  if (aiQueue.length >= QUEUE_MAX) {
    out({ event: 'warn', what: 'คิว AI', error: `คิวเต็ม ${QUEUE_MAX} งาน — ข้ามห้อง ${cid}` });
    return;
  }
  seenInQueue.add(cid);
  const job = { e, info, note, live };
  if (live) {
    // แทรกต่อจากงาน live ที่รออยู่ แต่อยู่หน้างานตามเก็บทั้งหมด
    const at = aiQueue.findIndex(j => !j.live);
    if (at < 0) aiQueue.push(job); else aiQueue.splice(at, 0, job);
  } else {
    aiQueue.push(job);
  }
  runQueue();
}

// ทำพร้อมกันหลายห้อง (เดิมทีละห้อง 20 ห้องใช้ ~2 นาที) — ลิมิตต่อนาทีของ Gemini ยังรับไหว
// ถ้าเจอ rate_limited บ่อยให้ลด AI_QUEUE_CONCURRENCY ลง
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.AI_QUEUE_CONCURRENCY || 3));
let activeWorkers = 0;
let activeBackground = 0;

function runQueue() {
  while (activeWorkers < QUEUE_CONCURRENCY && aiQueue.length) {
    const index = aiQueue.findIndex(j => j.live || activeBackground === 0);
    if (index < 0) break;
    const [job] = aiQueue.splice(index, 1);
    activeRooms.add(job.e.conversationId);
    if (!job.live) activeBackground++;
    activeWorkers++;
    queueWorker(job).catch(err => {
      outRoom(job.e, job.info, { event: 'error', what: 'queue_worker', error: shortError(err) });
    }).finally(() => {
      activeWorkers--;
      if (!job.live) activeBackground--;
      activeRooms.delete(job.e.conversationId);
      seenInQueue.delete(job.e.conversationId);
      const pending = pendingLive.get(job.e.conversationId);
      pendingLive.delete(job.e.conversationId);
      if (pending) enqueueRoom(pending.e, pending.info, pending.note, true);
      if (aiQueue.length) runQueue();
    });
  }
}

async function queueWorker({ e, info, note, live }) {
    if (note) outRoom(e, info, { ...note, queued: aiQueue.length });

    for (let attempt = 0; attempt <= RETRY_429_MAX; attempt++) {
      try {
        const outcome = await aiRespond(e, info);
        await applyOutcomeTag(e, info, outcome);
        // จดว่าจัดการแล้ว "เฉพาะตอนทำเสร็จจริง" — เดิมจดตั้งแต่ก่อนเริ่ม
        // ทำให้ห้องที่โดนโควตาเต็ม/พลาด ถูกนับว่าเสร็จแล้วและไม่มีวันถูกหยิบมาตอบอีก
        if (outcome !== 'error' && outcome !== 'stale') markHandled(e.conversationId);
        break;
      } catch (err) {
        if (isAuthError(err)) { relogin(); break; }
        if (isRateLimit(err) && attempt < RETRY_429_MAX) {
          const wait = QUEUE_DELAY_MS * (attempt + 1) * 5;      // ถอยรอนานขึ้นทุกครั้ง
          outRoom(e, info, { event: 'rate_limited', waitMs: wait, attempt: attempt + 1 });
          await sleep(wait);
          continue;
        }
        out({ event: 'warn', what: 'คิว AI', error: shortError(err) });
        if (isRateLimit(err)) await sendHolding(e);   // ลองใหม่หมดแล้วยังไม่ได้ → ตอบเบื้องต้นไว้ก่อน
        break;
      }
    }
    // หน่วงเฉพาะตอนไล่ห้องค้าง (กันชนลิมิตต่อนาที) ส่วนงานสดปล่อยให้ต่อเนื่อง
    // ถ้างานถัดไปเป็นงานสด ก็ไม่ต้องหน่วงเช่นกัน — ลูกค้ากำลังรออยู่
    const nextIsLive = aiQueue[0]?.live;
    if (aiQueue.length && !live && !nextIsLive) await sleep(QUEUE_DELAY_MS);
}

/** ติดแท็กตามผลที่ AI จัดการห้องนั้น (ใช้ร่วมกันทั้งแชทเด้งและตอนตามเก็บห้องค้าง) */
async function applyOutcomeTag(e, info, outcome) {
  if (outcome === 'stale' || outcome === 'error' || outcome === 'disabled') return;
  if (!AUTO_TAG) return;
  // ไม่ต้องตอบ (ร้านตอบไปแล้ว / ลูกค้าพิมพ์แค่ "ครับ" / สติกเกอร์) → ไม่ยุ่งกับแท็กเลย
  // ปล่อยแท็กเดิมของห้องไว้อย่างที่เจ้าหน้าที่ตั้งไว้ ห้ามติด "รอเจ้าหน้าที่" ทับเคสที่จบแล้ว
  // แท็กเฉพาะเคสที่ต้องให้คนตามต่อจริง ๆ นอกนั้นปล่อยห้องไว้เฉย ๆ ไม่แตะแท็กเลย:
  //   'skipped'          = มีคนตอบไปแล้ว / ลูกค้าพิมพ์แค่คำรับ
  //   'sent'/'suggested' = AI ตอบจบเองได้ (รวมเคสส่งการ์ดสินค้าแล้วตอบรายละเอียดไป)
  if (outcome === 'skipped' || outcome === 'sent' || outcome === 'suggested') return;
  const latest = await api.getMessageList({ ...e, pageNo: 1, pageSize: 30 });
  if (!latest?.list?.length || humanAfterBuyer(latest.list.slice().reverse())) return;

  // เหลือแค่เคสละเอียดอ่อน (ส่งของผิด ของขาด เคลม คืนเงิน ร้องเรียน) หรือ AI ตอบไม่ได้
  // ⚠ บอท "เพิ่มแท็กอย่างเดียว ห้ามลบ" — แม้แต่แท็กที่บอทติดเอง ให้เจ้าหน้าที่เป็นคนลบเท่านั้น
  await addConversationTag(e, info, autoTagId, AUTO_TAG_NAME);
  await markUnread(e, info);
}

/**
 * ตามเก็บห้องที่ "ยังไม่อ่าน" — ลูกค้าทักมาแล้วแต่ยังไม่มีใครตอบ
 * แชทเด้ง (socket) จับได้เฉพาะข้อความที่เข้ามาตอนบอทออนไลน์ ห้องที่ค้างมาก่อนหน้าจะตกหล่น
 * รันตอนเริ่มระบบ และซ้ำทุก CATCHUP_EVERY_MIN นาที
 */
/**
 * ห้องนี้ "ยังรอคำตอบ" ไหม — ดูจากฟิลด์ในรายการห้อง ไม่ต้องดึงข้อความทีละห้อง
 * ⚠ เดิมดูแค่ unReadCount > 0 ซึ่งพลาดหนัก: ข้อมูลจริง 100 ห้องเป็น 0 ทั้งหมด
 *   เพราะแค่มีคนเปิดดูในเว็บ Duoke ห้องก็กลายเป็น "อ่านแล้ว" ทั้งที่ยังไม่มีใครตอบ
 * สัญญาณที่ใช้ (ตรวจกับข้อความจริงแล้ว):
 *   noReplyBuyerMessageTime มีค่า     → ลูกค้าพูดล่าสุด ยังไม่มีใครตอบ
 *   latestSellerMessageSourceType = 1 → ข้อความร้านล่าสุดเป็นบอทแพลตฟอร์ม ไม่ใช่แอดมิน
 *   unReadCount > 0                   → ยังไม่มีใครเปิดอ่าน
 * ส่วนที่คลุมเครือ ai-bot.js จะเช็คซ้ำจากข้อความจริงอีกชั้น (มีแอดมินตอบแล้ว = ข้าม ไม่เสียโควตา AI)
 */
function awaitingReply(c) {
  return Boolean(c.noReplyBuyerMessageTime)
    || Number(c.latestSellerMessageSourceType) === 1
    || Number(c.unReadCount) > 0;
}

let catchupRunning = false;
async function catchUpUnread() {
  if (catchupRunning) return;
  catchupRunning = true;
  try { await scanPendingRooms(); }
  finally { catchupRunning = false; }
}

async function scanPendingRooms() {
  if (!CATCHUP) return;
  const cutoff = Date.now() - CATCHUP_DAYS * 86400_000;

  // ไล่หลายหน้า จนกว่าจะเจอห้องที่เก่ากว่าช่วงตามเก็บ (เดิมดูแค่หน้าแรกหน้าเดียว)
  let rooms = [];
  let scanned = 0;
  try {
    for (let page = 0; page < CATCHUP_PAGES; page++) {
      const res = await api.queryConversationList({
        shopIdList: shops.map(s => s.id ?? s.shopId), size: 100, offset: page * 100,
      });
      const list = res?.list ?? [];
      scanned += list.length;
      rooms.push(...list);
      const oldest = Math.min(...list.map(c => c.lastMessageTimestamp ?? Infinity));
      if (!res?.hasMore || list.length < 100 || oldest < cutoff) break;
    }
  } catch (err) {
    if (isAuthError(err)) relogin();
    out({ event: 'warn', what: 'ดึงห้องค้าง', error: err.message });
    return;
  }

  // เอาเฉพาะที่ยังใหม่พอ และยังรอคำตอบอยู่
  const fresh = rooms.filter(c => (!c.lastMessageTimestamp || c.lastMessageTimestamp >= cutoff) && awaitingReply(c));

  // ข้ามห้องที่จัดการไปแล้วและยังไม่มีข้อความใหม่เข้ามาหลังจากนั้น
  // กรองตรงนี้ก่อนดึงข้อความ จะได้ไม่เสีย API เปล่าทุก 15 นาที
  // (ห้องที่บอททำเป็น "ยังไม่อ่าน" ไว้ให้เจ้าหน้าที่ จะค้างเป็นยังไม่อ่านจนกว่าคนจะเปิดอ่าน
  //  ถ้าไม่กรองตรงนี้ มันจะถูกหยิบมาวนซ้ำทุกรอบไม่รู้จบ)
  let skipped = 0;
  const todo = fresh
    .filter(c => {
      const done = handledAt.get(c.conversationId);
      if (done && done >= (c.lastMessageTimestamp ?? 0)) { skipped++; return false; }
      return true;
    })
    .sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0))
    .slice(0, CATCHUP_LIMIT);

  if (!todo.length) return;
  out({
    event: 'catchup_start', rooms: todo.length, scanned,
    awaiting: fresh.length, skippedHandled: skipped || undefined,
  });

  for (const c of todo) {
    const e = { shopId: c.shopId, conversationId: c.conversationId, platform: c.platform };
    // ใช้ข้อมูลห้องจากรายการได้เลย ไม่ต้องยิง viewConversation ทีละห้อง
    // (แถมรายการมี buyerNick/groupId/tagIdList ครบกว่า viewConversation ที่คืนไม่ครบ)
    convCache.set(c.conversationId, { ...(convCache.get(c.conversationId) ?? {}), ...c });
    enqueueRoom(e, c, { event: 'catchup_room', reason: c.noReplyBuyerMessageTime ? 'ลูกค้ารอคำตอบ' : 'บอทแพลตฟอร์มตอบล่าสุด' });
  }
}

/** ส่งการ์ดสินค้าตามหลังข้อความ (AI สั่งมาด้วย [[SEND_ITEM:...]] — รหัสผ่านการตรวจแล้ว) */
async function sendProductCard(e, itemId) {
  if (!itemId) return;
  if (await skipWaitingStaff(e)) return;

  // ห้องเดิม การ์ดใบเดิม ไม่ส่งซ้ำภายในเวลาที่กำหนด (ลูกค้าเห็นไปแล้ว ส่งซ้ำรก)
  const room = sentCards.get(e.conversationId) ?? new Map();
  const last = room.get(itemId);
  if (last && Date.now() - last < CARD_COOLDOWN_MS) {
    outRoom(e, null, { event: 'send_card', itemId, skipped: 'ส่งไปแล้วเมื่อกี้' });
    return;
  }

  try {
    await rt.sendProduct({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
      itemId, puid: myPuid,
    });
    room.set(itemId, Date.now());
    sentCards.set(e.conversationId, room);
    outRoom(e, null, { event: 'send_card', itemId });
  } catch (err) {
    // ส่งการ์ดไม่ได้ไม่ใช่เรื่องคอขาดบาดตาย ข้อความหลักส่งไปแล้ว
    outRoom(e, null, { event: 'send_card', itemId, ok: false, error: err.message });
  }
}

// ให้ AI ร่างคำตอบทุกข้อความ (จุดต่อ AI อยู่ที่ ai-bot.js)
// จะ "log ร่างคำตอบก่อนเสมอ" แล้วค่อยให้ตัวเรียกจัดการแท็ก
// คืนสถานะ: 'sent' | 'suggested' | 'staff' | 'skipped' | 'declined' | 'disabled' | 'error'
//   'skipped' = ไม่ต้องตอบ (ร้านตอบไปแล้ว / ลูกค้าพิมพ์แค่คำรับ) → ตัวเรียกจะไม่แตะแท็กเลย
function humanAfterBuyer(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Number(messages[i].fromAccountType) === 1) return null;
    if (ai.shopSenderKind(messages[i], myUid) === 'staff') return messages[i];
  }
  return null;
}

function buyerVersion(messages) {
  const buyer = [...messages].reverse().find(m => Number(m.fromAccountType) === 1);
  return buyer ? String(buyer.messageId ?? buyer.id ?? JSON.stringify(buyer)) : null;
}

async function aiRespond(e, info) {
  if (!ai.isEnabled()) return 'disabled';
  try {
    if (await skipWaitingStaff(e, info)) return 'stale';
    // ดึงประวัติล่าสุดเป็นบริบท (เก่า → ใหม่)
    const hist = await api.getMessageList({ ...e, pageNo: 1, pageSize: 30 });
    const messages = (hist?.list ?? []).slice().reverse();
    const question = [...messages].reverse().find(m => Number(m.fromAccountType) === 1);
    e = { ...e, replyTo: question ? {
      messageId: question.messageId ?? question.id,
      type: question.messageType,
      text: stripAnsi(describe(question)),
    } : undefined };
    const human = humanAfterBuyer(messages);
    if (human || !buyerVersion(messages)) {
      outRoom(e, info, { event: 'ai_skip', reason: human ? 'human_already_replied' : 'no_customer_message', sender: human?.account });
      return 'skipped';
    }
    // สั่งจาก UI: ปิด AI ห้องนี้ / แอดมินตอบผ่าน UI หลังข้อความล่าสุดของลูกค้าแล้ว
    // (ข้อความที่ส่งจาก UI ใช้บัญชีเดียวกับบอท Duoke จึงมองว่าเป็น "me" ไม่ใช่ staff ต้องเช็คจาก DB)
    const uiBlock = await aiBlockedByUi(e.conversationId, question?.createTime);
    if (uiBlock) {
      outRoom(e, info, { event: 'ai_skip', reason: uiBlock === 'paused' ? 'ปิด AI ห้องนี้จาก UI' : 'แอดมินตอบผ่าน UI แล้ว' });
      return 'skipped';
    }
    const stillCurrent = async () => {
      if (await skipWaitingStaff(e, info)) return false;
      const latest = await api.getMessageList({ ...e, pageNo: 1, pageSize: 30 });
      const current = (latest?.list ?? []).slice().reverse();
      if (!current.length) throw new Error('Cannot verify current conversation before sending');
      const staff = humanAfterBuyer(current);
      if (staff) {
        outRoom(e, info, { event: 'ai_skip', reason: 'human_replied_while_drafting', sender: staff.account });
        return false;
      }
      const lastQ = [...current].reverse().find(m => Number(m.fromAccountType) === 1);
      if (await aiBlockedByUi(e.conversationId, lastQ?.createTime)) {
        outRoom(e, info, { event: 'ai_skip', reason: 'แอดมินตอบ/ปิด AI ผ่าน UI ระหว่างร่าง' });
        return false;
      }
      if (buyerVersion(current) !== buyerVersion(messages)) {
        pendingLive.set(e.conversationId, { e, info, note: { event: 'redraft', reason: 'new_customer_message' } });
        outRoom(e, info, { event: 'ai_skip', reason: 'draft_outdated' });
        return false;
      }
      return true;
    };

    // กันตอบซ้ำ: ทั้ง "ตามเก็บห้องค้าง" และ "แชทเด้ง" อาจเข้าห้องเดียวกันห่างกันไม่กี่วินาที
    // ถ้าข้อความล่าสุดของลูกค้ายังเป็นตัวเดิมที่ตอบไปแล้ว = ไม่มีอะไรใหม่ ไม่ต้องตอบอีก
    const lastBuyerMsg = [...messages].reverse().find(m => Number(m.fromAccountType) === 1);
    const lastId = lastBuyerMsg?.messageId ?? lastBuyerMsg?.id;
    if (lastId && String(answeredMsgId.get(e.conversationId)) === String(lastId)) {
      outRoom(e, info, { event: 'ai_skip', reason: 'ตอบข้อความนี้ไปแล้ว' });
      return 'skipped';
    }
    const rememberSent = () => { if (lastId) {
      answeredMsgId.set(e.conversationId, lastId);
      answeredDirty = true;
      // อย่าล้างทั้งก้อน (เดิมใช้ clear() ทำให้ห้องที่ตอบแล้วโดนตอบซ้ำ) — ตัดเฉพาะตัวเก่าสุด
      if (answeredMsgId.size > 2000) {
        for (const k of [...answeredMsgId.keys()].slice(0, 500)) answeredMsgId.delete(k);
      }
    } };

    // เคสใบกำกับภาษี — ติดแท็กตามยอดสั่งซื้อ ทำก่อนเรียก AI เพราะเป็นกฎตายตัว
    // ไม่เกี่ยวกับว่า AI จะตอบว่าอะไร และต้องทำงานในโหมดคิวไฟล์ด้วย
    await tagInvoiceCase(e, info, messages);

    // โหมด claude-code: โยนคำถาม+บริบทลงคิวไฟล์ ให้ Claude Code/คน ตอบ (ไม่เรียก API)
    if (ai.isInboxMode()) {
      writeInbox({
        conversationId: e.conversationId,
        shopId: e.shopId,
        platform: e.platform,
        buyerName: info.buyerNick,
        shopName: info.shopName ?? e.shopId,
        messages: messages.map(m => ({
          from: m.fromAccountType === 1 ? 'ลูกค้า' : 'ร้าน',
          text: parseMessageContent(m)?.text ?? `(${m.messageType})`,
          time: m.createTime,
        })),
      });
      outRoom(e, info, { event: 'queued_inbox', note: 'npm run inbox' });
      await sendHolding(e);          // ตอบเบื้องต้นไปก่อน ระหว่างรอคนในคิวตอบจริง
      return 'staff';
    }

    const r = await ai.generateReply({
      messages,
      shopName: info.shopName ?? e.shopId,
      platform: e.platform,
      buyerName: info.buyerNick,
      orderContext: await orderContextFor(e, info, messages),
      myUid,                       // ให้ ai-bot แยกออกว่าข้อความฝั่งร้านเป็นของบอทเราเองไหม
    });

    // โชว์ token ที่ใช้ไป — cacheR=0 ตลอด แปลว่า prompt caching ไม่ติด (ดู AI_CACHE_TTL ใน .env)
    const u = ai.lastUsage?.();
    if (u) {

      outRoom(e, info, { event: 'usage', model: u.model, switched: u.switched, in: u.in, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, out: u.out, webSearches: u.searches || 0 });
    }

    // ร้านตอบคำถามนี้ครบไปแล้ว (หรือลูกค้าพิมพ์แค่คำรับ) → เงียบไว้ทั้งข้อความและแท็ก
    // คืน 'skipped' ไม่ใช่ 'declined' เพราะ 'declined' จะไปติดแท็ก "รอเจ้าหน้าที่" ทับเคสที่จบไปแล้ว
    if (r.skip) {
      outRoom(e, info, { event: 'ai_skip', reason: r.reason ?? 'ร้านตอบไปแล้ว' });
      return 'skipped';
    }

    // ไม่มีร่างคำตอบเลย → อย่างน้อยต้องตอบเบื้องต้นให้ลูกค้า แล้วให้เจ้าหน้าที่ตามต่อ
    if (!await stillCurrent()) return 'stale';
    if (!r.reply) {
      outRoom(e, info, { event: 'ai_reply', status: 'no_draft', reason: r.reason ?? 'ไม่มีคำตอบ' });
      await sendHolding(e);
      return 'staff';
    }

    // เคสละเอียดอ่อน → ส่งคำตอบเบื้องต้นให้ลูกค้าก่อน แล้วยังติดแท็กให้เจ้าหน้าที่ตามไปตอบต่อเสมอ
    if (r.needsStaff) {
      const why = r.reason ? ` ${C.dim}[${r.reason}]${C.reset}` : '';
      if (!ai.autoSend()) {
        outRoom(e, info, { event: 'ai_reply', status: 'draft_staff', note: 'ยังไม่ส่ง (AI_AUTO_SEND=false)', reason: r.reason, text: oneLine(r.reply) });
        return 'staff';
      }
      // ร่างมีข้อมูลที่ยืนยันไม่ได้ (เช่น แต่งตัวเลขเอง) → ห้ามส่งร่าง ส่งข้อความสำเร็จรูปแทน
      if (r.unsafe) {
        outRoom(e, info, { event: 'ai_reply', status: 'blocked', reason: r.reason, text: oneLine(r.reply) });
        await sendHolding(e);
        return 'staff';
      }
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
      rememberSent();
      outRoom(e, info, { event: 'ai_reply', status: 'sent_staff', reason: r.reason, text: oneLine(r.reply) });
      return 'staff';
    }

    // เคสพื้น ๆ ตอบได้เอง
    if (ai.autoSend()) {
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
      rememberSent();
      outRoom(e, info, { event: 'ai_reply', status: 'sent', text: oneLine(r.reply), swapped: r.swapped?.length ? r.swapped : undefined });
      await sendProductCard(e, r.sendItemId);
      return 'sent';
    }
    outRoom(e, info, { event: 'ai_reply', status: 'suggested', note: 'ยังไม่ส่ง (AI_AUTO_SEND=false)', text: oneLine(r.reply) });
    if (r.sendItemId) outRoom(e, info, { event: 'send_card', itemId: r.sendItemId, skipped: 'AI_AUTO_SEND=false' });
    return 'suggested';
  } catch (err) {
    if (isAuthError(err)) { relogin(); return 'error'; }
    // โควตาหมด/ถูกจำกัดอัตรา → โยนต่อให้คิวจัดการ (ถอยรอแล้วลองใหม่)
    // ห้ามส่งข้อความเบื้องต้นตรงนี้ ไม่งั้นลูกค้าจะได้ข้อความซ้ำตอนลองใหม่สำเร็จ
    if (isRateLimit(err)) throw err;
    outRoom(e, info, { event: 'error', what: 'AI ร่างคำตอบ', error: shortError(err) });
    await sendHolding(e);            // AI ล่ม ลูกค้าก็ยังต้องได้คำตอบเบื้องต้น
    return 'error';
  }
}

function wireEvents() {
  rt.on('state', s => {
    const icon = s.state === 'connected' ? '🟢' : s.state === 'reconnecting' ? '🟡' : '🔴';
    out({ event: 'socket', state: s.state, reason: s.reason || undefined });
  });

  rt.on('newMessage', async e => {
    try {
      const info = await getConvInfo(e);
      const msgs = await rt.fetchNewMessages({ ...e, pageSize: 10 });
      const list = (msgs?.list ?? []).slice().reverse();      // เก่า → ใหม่

      let sawBuyerMsg = false;
      let sawHumanReply = false;
      for (const m of list) {
        if (seenMessageIds.has(m.messageId)) continue;
        seenMessageIds.add(m.messageId);
        if (seenMessageIds.size > 5000) seenMessageIds.clear();

        const fromBuyer = m.fromAccountType === 1;
        if (fromBuyer) sawBuyerMsg = true;
        if (!fromBuyer && ai.shopSenderKind(m, myUid) === 'staff') sawHumanReply = true;
        if (ONLY_BUYER && !fromBuyer) continue;



        outRoom(e, info, {
          event: 'message',
          messageId: m.messageId ?? m.id,
          from: fromBuyer ? 'customer' : ai.shopSenderKind(m, myUid),   // shop: platform-bot | me | staff
          sender: m.account ?? undefined,
          type: m.messageType,
          text: oneLine(describe(m)),
          unread: info.unReadCount || 0,
        });

        // ข้อมูลดิบทั้งก้อนที่ดึงมาได้ตอนลูกค้าทัก — ลงไฟล์ log อย่างเดียว ไม่รกจอ
        if (LOG_RAW) {
          logFile(`  ↳ raw ${JSON.stringify({
            event: e,
            conversation: {
              conversationId: e.conversationId, shopId: e.shopId, platform: e.platform,
              shopName: info.shopName, buyerNick: info.buyerNick, buyerId: info.buyerId,
              unReadCount: info.unReadCount, status: info.status, subStatus: info.subStatus,
            },
            message: m,
            content: parseMessageContent(m),
          })}`);
        }
      }

      // มีข้อความจากลูกค้า → ให้ AI ตอบ/แนะนำก่อน (log ออกทันที) แล้วค่อยจัดการแท็ก
      // เข้าคิวเหมือนกับตอนตามเก็บ เพื่อไม่ให้แชทเด้งหลายห้องพร้อมกันยิง AI ซ้อนกัน
      // (การติดแท็กย้ายไปทำในคิวแล้ว ดู runQueue)
      if (sawBuyerMsg) enqueueRoom(e, info, null, true);   // true = ลูกค้าทักสด ๆ ให้แซงคิว
      if (sawHumanReply && process.env.AI_LEARN_ADMIN !== 'false') {
        // Learning does not occupy an AI worker or delay enqueueing a live customer.
        api.getMessageList({ ...e, pageNo: 1, pageSize: 30 }).then(hist => {
          const added = collectAdminExamples((hist?.list ?? []).slice().reverse(),
            m => ai.shopSenderKind(m, myUid) === 'staff', { buyerName: info.buyerNick });
          if (added) outRoom(e, info, { event: 'admin_example_saved', added });
        }).catch(err => outRoom(e, info, { event: 'warn', what: 'learn_admin', error: shortError(err) }));
      }
    } catch (err) {
      if (isAuthError(err)) return relogin();
      out({ event: 'error', what: 'ดึงข้อความ', error: err.message });
    }
  });

  rt.on('conversations', e => {
    for (const c of e.conversations) {
      convCache.set(c.conversationId, c);
      if (!SHOW_CONVERSATIONS) continue;
      const pc = PLATFORM_COLOR[c.platform] ?? C.gray;
      log(`${C.gray}${ts()}${C.reset} 📋 ${pc}${c.shopName}·${c.platform}${C.reset} ${c.buyerNick} ` +
          `${C.dim}ยังไม่อ่าน=${c.unReadCount} status=${c.status}/${c.subStatus}${C.reset}`);
    }
  });

  rt.on('kicked', () => {
    log(`${C.red}❌ ถูกเตะออก — บัญชีนี้ถูกล็อกอินที่อื่น${C.reset}`);
    process.exit(1);
  });

  rt.on('error', err => out({ event: 'error', error: err.message }));
}

async function connect(token) {
  api = new DuokeApi({ token, language: 'th' });
  rt = new DuokeRealtime({ api });
  wireEvents();
  await rt.connect();
}

let reloggingIn = false;
async function relogin() {
  if (reloggingIn || stopping) return;
  reloggingIn = true;
  try {
    log(`${C.yellow}⚠️  token ใช้ไม่ได้แล้ว — กำลังล็อกอินใหม่${C.reset}`);
    const stale = api?.token;
    rt?.disconnect();
    const s = await authenticate({ staleToken: stale });
    await connect(s.token);
    out({ event: 'relogin', state: 'ok' });
  } catch (err) {
    out({ event: 'relogin', state: 'failed', error: err.message });
    process.exit(1);
  } finally {
    reloggingIn = false;
  }
}

// ------------------------------------------------------------------- start

const session = await authenticate();
await connect(session.token);

const user = await api.getUser();
myPuid = (user.user ?? user).puid ?? user.puid ?? session.puid;
myUid = (user.user ?? user).id ?? user.uid ?? user.id ?? session.uid;
const shops = await api.getShops();
shopList = shops;                      // ให้ shopNameOf() แปลง shopId เป็นชื่อร้านได้

// resolve tagId ของ "รอเจ้าหน้าที่" (เจอของเดิมก็ใช้เลย ไม่มีก็สร้างให้)
if (AUTO_TAG) {
  try {
    autoTagId = await api.ensureTag({ tagName: AUTO_TAG_NAME });
    if (!autoTagId) out({ event: 'warn', what: 'เตรียมแท็ก', tag: AUTO_TAG_NAME, error: 'หา/สร้างไม่ได้ — ปิดการติดแท็กอัตโนมัติ' });
    if (ai.isEnabled()) {
      aiTagId = await api.ensureTag({ tagName: AUTO_TAG_AI_NAME, tagColor: 'green' });
      if (!aiTagId) out({ event: 'warn', what: 'เตรียมแท็ก', tag: AUTO_TAG_AI_NAME, error: 'หา/สร้างไม่ได้' });
    }
    // แท็กเคสใบกำกับ — ทั้งสองอันมีอยู่แล้วในบัญชี ensureTag จะเจอของเดิม ไม่สร้างซ้ำ
    // โหลดรายชื่อแท็กทั้งบัญชีไว้ เพื่อให้ log แสดงชื่อแท็กแทนตัวเลข id
    try {
      const all = await api.getTagList();
      for (const g of (Array.isArray(all) ? all : (all?.list ?? []))) tagNameById.set(String(g.id), g.tagName);
    } catch {}
    invoiceTagId = await api.ensureTag({ tagName: TAG_INVOICE_NAME, tagColor: 'green' });
    slipTagId = await api.ensureTag({ tagName: TAG_SLIP_NAME, tagColor: 'green' });
    if (!invoiceTagId || !slipTagId) {
      out({ event: 'warn', what: 'เตรียมแท็กใบกำกับ', tags: [TAG_INVOICE_NAME, TAG_SLIP_NAME], error: 'หาไม่ครบ — ข้ามการติดแท็กเคสใบกำกับ' });
    }
  } catch (err) {
    out({ event: 'warn', what: 'เตรียมแท็ก', error: err.message });
  }
}

{
  const kb = ai.knowledgeInfo();
  const p = ai.providerInfo();
  out({
    event: 'ready',
    account: user.email ?? user.account ?? user.uid,
    shops: shops.map(s => ({ name: s.shopName, platform: s.platform })),
    onlyBuyer: ONLY_BUYER,
    logFile: LOG_FILE ? path.basename(LOG_FILE) : null,
    tag: AUTO_TAG && autoTagId
      ? { sensitiveOnly: AUTO_TAG_NAME, markUnread: MARK_UNREAD }
      : null,
    ai: ai.isEnabled()
      ? { autoSend: ai.autoSend(), provider: p.provider, model: p.model, knowledgeFiles: kb.count, warning: p.warning }
      : null,
    catchup: CATCHUP && ai.isEnabled()
      ? { days: CATCHUP_DAYS, limit: CATCHUP_LIMIT, everyMin: CATCHUP_EVERY_MIN }
      : null,
  });
}

// ตามเก็บห้องที่ค้างอยู่ก่อนบอทออนไลน์ แล้ววนซ้ำเป็นระยะ (เผื่อแชทเด้งหลุด)
if (CATCHUP && ai.isEnabled()) {
  await catchUpUnread();
  if (CATCHUP_EVERY_MIN > 0) {
    setInterval(() => { catchUpUnread().catch(() => {}); }, CATCHUP_EVERY_MIN * 60_000).unref();
  }
}

// โปรเซสอื่น (ui-server.js / outbox.js) ล็อกอินได้ token ใหม่ → สลับมาใช้ตัวเดียวกัน ไม่ล็อกอินซ้ำ
watchSharedSession(async s => {
  if (stopping || reloggingIn || s.token === api?.token) return;
  reloggingIn = true;
  try {
    out({ event: 'token_shared', note: 'ใช้ token ใหม่จาก .token.json (โปรเซสอื่นล็อกอิน)' });
    rt?.disconnect();
    await connect(s.token);
  } catch (err) {
    out({ event: 'warn', what: 'สลับ token', error: err.message });
  } finally {
    reloggingIn = false;
  }
});

// ปิด socket ให้เรียบร้อยเวลา nodemon รีสตาร์ต (SIGUSR2) หรือกด Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, () => {
    stopping = true;
    rt?.disconnect();
    process.kill(process.pid, sig);
  });
}
