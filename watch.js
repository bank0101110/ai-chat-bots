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
import { getSession, clearCache } from './duoke-session.js';
import * as ai from './ai-bot.js';
import { writeInbox } from './inbox-store.js';

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
const CATCHUP_LIMIT = Number(process.env.CATCHUP_LIMIT || 20);      // ตอบได้สูงสุดกี่ห้องต่อรอบ
const CATCHUP_DAYS = Number(process.env.CATCHUP_DAYS || 3);         // ย้อนหลังไม่เกินกี่วัน
const CATCHUP_EVERY_MIN = Number(process.env.CATCHUP_EVERY_MIN || 15); // วนซ้ำทุกกี่นาที (0=ครั้งเดียว)

// แท็กเคสใบกำกับภาษี — ติดต่อเมื่อลูกค้า "ขอ" ใบกำกับเท่านั้น แล้วแยกตามยอดสั่งซื้อ
const TAG_INVOICE_NAME = process.env.AUTO_TAG_INVOICE_NAME || 'green';            // ยอดถึงเกณฑ์
const TAG_SLIP_NAME = process.env.AUTO_TAG_SLIP_NAME || 'ขอสลิปออนไลน์';          // ยอดไม่ถึง
// ห้องเดิมส่ง "คำตอบเบื้องต้น" ซ้ำได้เร็วสุดกี่นาที (ลูกค้ามักพิมพ์รัวหลายข้อความติดกัน)
const CARD_COOLDOWN_MS = Number(process.env.AI_CARD_COOLDOWN_MIN || 60) * 60_000;
const HOLDING_COOLDOWN_MS = Number(process.env.AI_HOLDING_COOLDOWN_MIN || 30) * 60_000;
const LOG_FILE = process.env.LOG_FILE ? path.join(__dirname, process.env.LOG_FILE) : null;
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
  const line = JSON.stringify({ time: ts(), ...obj });
  console.log(line);
  if (LOG_FILE) fs.appendFile(LOG_FILE, `${line}\n`, () => {});
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
    buyer: buyerNames.get(cid) ?? cid,
    conversationId: cid,
    ...obj,
  });
}

function log(line, plain = null) {
  console.log(line);
  if (LOG_FILE) fs.appendFile(LOG_FILE, `${plain ?? stripAnsi(line)}\n`, () => {});
}

/** เขียนลงไฟล์ log อย่างเดียว ไม่ขึ้นจอ (ใช้กับ JSON ดิบที่ยาวมาก) */
function logFile(text) {
  if (LOG_FILE) fs.appendFile(LOG_FILE, `${text}\n`, () => {});
}

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
const answeredMsgId = new Map();    // conversationId → messageId ล่าสุดของลูกค้าที่ตอบไปแล้ว (กันตอบซ้ำ)
const sentCards = new Map();        // conversationId → Map(itemId → เวลาที่ส่ง) กันส่งการ์ดสินค้าซ้ำ
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

async function authenticate({ force = false } = {}) {
  const s = await getSession({ force, email: EMAIL, password: PASSWORD });
  const how = { cache: 'ใช้ token ที่แคชไว้', env: 'ใช้ DUOKE_TOKEN จาก .env', login: 'ล็อกอินใหม่' }[s.source];
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
async function sendHolding(e) {
  if (!ai.autoSend()) return false;
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
    const res = await api.getOrderList({ shopId: e.shopId, buyerId, platform: e.platform, pageSize: 5 });
    const list = res?.list ?? [];
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
      const res = await api.getOrderList({ shopId: e.shopId, buyerId, platform: e.platform, pageSize: 5 });
      orders = res?.list ?? [];
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
const QUEUE_DELAY_MS = Number(process.env.AI_QUEUE_DELAY_MS || 4000);
const QUEUE_MAX = Number(process.env.AI_QUEUE_MAX || 200);      // คิวยาวเกินนี้ทิ้งงานใหม่
const RETRY_429_MAX = Number(process.env.AI_RETRY_429 || 2);    // โดนจำกัดโควตาแล้วลองใหม่กี่ครั้ง

const aiQueue = [];
let queueBusy = false;
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

/** เอาห้องเข้าคิวให้ AI จัดการ (ไม่ต้อง await — คิวจะทยอยทำเอง) */
function enqueueRoom(e, info, note) {
  const cid = e.conversationId;
  if (seenInQueue.has(cid)) return;                 // อยู่ในคิวอยู่แล้ว
  if (aiQueue.length >= QUEUE_MAX) {
    out({ event: 'warn', what: 'คิว AI', error: `คิวเต็ม ${QUEUE_MAX} งาน — ข้ามห้อง ${cid}` });
    return;
  }
  seenInQueue.add(cid);
  aiQueue.push({ e, info, note });
  runQueue();
}

async function runQueue() {
  if (queueBusy) return;
  queueBusy = true;
  while (aiQueue.length) {
    const { e, info, note } = aiQueue.shift();
    seenInQueue.delete(e.conversationId);
    if (note) outRoom(e, info, { ...note, queued: aiQueue.length });

    for (let attempt = 0; attempt <= RETRY_429_MAX; attempt++) {
      try {
        const outcome = await aiRespond(e, info);
        await applyOutcomeTag(e, info, outcome);
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
    if (aiQueue.length) await sleep(QUEUE_DELAY_MS);
  }
  queueBusy = false;
}

/** ติดแท็กตามผลที่ AI จัดการห้องนั้น (ใช้ร่วมกันทั้งแชทเด้งและตอนตามเก็บห้องค้าง) */
async function applyOutcomeTag(e, info, outcome) {
  if (!AUTO_TAG) return;
  // ไม่ต้องตอบ (ร้านตอบไปแล้ว / ลูกค้าพิมพ์แค่ "ครับ" / สติกเกอร์) → ไม่ยุ่งกับแท็กเลย
  // ปล่อยแท็กเดิมของห้องไว้อย่างที่เจ้าหน้าที่ตั้งไว้ ห้ามติด "รอเจ้าหน้าที่" ทับเคสที่จบแล้ว
  // แท็กเฉพาะเคสที่ต้องให้คนตามต่อจริง ๆ นอกนั้นปล่อยห้องไว้เฉย ๆ ไม่แตะแท็กเลย:
  //   'skipped'          = มีคนตอบไปแล้ว / ลูกค้าพิมพ์แค่คำรับ
  //   'sent'/'suggested' = AI ตอบจบเองได้ (รวมเคสส่งการ์ดสินค้าแล้วตอบรายละเอียดไป)
  if (outcome === 'skipped' || outcome === 'sent' || outcome === 'suggested') return;

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
async function catchUpUnread() {
  if (!CATCHUP) return;
  let rooms = [];
  try {
    const res = await api.queryConversationList({
      shopIdList: shops.map(s => s.id ?? s.shopId), size: 200, offset: 0,
    });
    rooms = (res?.list ?? []).filter(c => Number(c.unReadCount) > 0);
  } catch (err) {
    if (isAuthError(err)) relogin();
    out({ event: 'warn', what: 'ดึงห้องค้าง', error: err.message });
    return;
  }

  // เอาเฉพาะที่ยังใหม่พอ — ห้องค้างข้ามเดือนไม่ควรเด้งไปตอบตอนนี้
  const cutoff = Date.now() - CATCHUP_DAYS * 86400_000;
  const todo = rooms
    .filter(c => !c.lastMessageTimestamp || c.lastMessageTimestamp >= cutoff)
    .sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0))
    .slice(0, CATCHUP_LIMIT);

  if (!todo.length) return;
  out({ event: 'catchup_start', rooms: todo.length, unreadTotal: rooms.length });

  for (const c of todo) {
    const e = { shopId: c.shopId, conversationId: c.conversationId, platform: c.platform };
    try {
      const info = await getConvInfo(e);
      // เข้าคิวแทนการเรียก AI ตรง ๆ — คิวจะทยอยทำทีละห้อง ไม่ยิงรวดเดียวจนโดนจำกัดโควตา
      enqueueRoom(e, { ...info, buyerNick: c.buyerNick ?? info.buyerNick },
        { event: 'catchup_room', unread: c.unReadCount });
    } catch (err) {
      if (isAuthError(err)) { relogin(); return; }
      out({ event: 'warn', what: 'ตามเก็บห้อง', error: err.message });
    }
  }
}

/** ส่งการ์ดสินค้าตามหลังข้อความ (AI สั่งมาด้วย [[SEND_ITEM:...]] — รหัสผ่านการตรวจแล้ว) */
async function sendProductCard(e, itemId) {
  if (!itemId) return;

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
async function aiRespond(e, info) {
  if (!ai.isEnabled()) return 'disabled';
  try {
    // ดึงประวัติล่าสุดเป็นบริบท (เก่า → ใหม่)
    const hist = await api.getMessageList({ ...e, pageNo: 1, pageSize: 30 });
    const messages = (hist?.list ?? []).slice().reverse();

    // กันตอบซ้ำ: ทั้ง "ตามเก็บห้องค้าง" และ "แชทเด้ง" อาจเข้าห้องเดียวกันห่างกันไม่กี่วินาที
    // ถ้าข้อความล่าสุดของลูกค้ายังเป็นตัวเดิมที่ตอบไปแล้ว = ไม่มีอะไรใหม่ ไม่ต้องตอบอีก
    const lastBuyerMsg = [...messages].reverse().find(m => m.fromAccountType === 1);
    const lastId = lastBuyerMsg?.messageId ?? lastBuyerMsg?.id;
    if (lastId && answeredMsgId.get(e.conversationId) === lastId) {
      outRoom(e, info, { event: 'ai_skip', reason: 'ตอบข้อความนี้ไปแล้ว' });
      return 'skipped';
    }
    if (lastId) {
      answeredMsgId.set(e.conversationId, lastId);
      if (answeredMsgId.size > 2000) answeredMsgId.clear();
    }

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

      outRoom(e, info, { event: 'usage', in: u.in, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, out: u.out, webSearches: u.searches || 0 });
    }

    // ร้านตอบคำถามนี้ครบไปแล้ว (หรือลูกค้าพิมพ์แค่คำรับ) → เงียบไว้ทั้งข้อความและแท็ก
    // คืน 'skipped' ไม่ใช่ 'declined' เพราะ 'declined' จะไปติดแท็ก "รอเจ้าหน้าที่" ทับเคสที่จบไปแล้ว
    if (r.skip) {
      outRoom(e, info, { event: 'ai_skip', reason: r.reason ?? 'ร้านตอบไปแล้ว' });
      return 'skipped';
    }

    // ไม่มีร่างคำตอบเลย → อย่างน้อยต้องตอบเบื้องต้นให้ลูกค้า แล้วให้เจ้าหน้าที่ตามต่อ
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
      outRoom(e, info, { event: 'ai_reply', status: 'sent_staff', reason: r.reason, text: oneLine(r.reply) });
      return 'staff';
    }

    // เคสพื้น ๆ ตอบได้เอง
    if (ai.autoSend()) {
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
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
    out({ event: 'error', what: 'AI ร่างคำตอบ', error: shortError(err) });
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
      for (const m of list) {
        if (seenMessageIds.has(m.messageId)) continue;
        seenMessageIds.add(m.messageId);
        if (seenMessageIds.size > 5000) seenMessageIds.clear();

        const fromBuyer = m.fromAccountType === 1;
        if (fromBuyer) sawBuyerMsg = true;
        if (ONLY_BUYER && !fromBuyer) continue;



        outRoom(e, info, {
          event: 'message',
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
      if (sawBuyerMsg) enqueueRoom(e, info);
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
    rt?.disconnect();
    clearCache();
    const s = await authenticate({ force: true });
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

// ปิด socket ให้เรียบร้อยเวลา nodemon รีสตาร์ต (SIGUSR2) หรือกด Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, () => {
    stopping = true;
    rt?.disconnect();
    process.kill(process.pid, sig);
  });
}
