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
 *   LOG_FILE=chat.log               ← เขียน log ลงไฟล์ด้วย (เว้นว่าง = ไม่เขียน)
 *   SHOW_CONVERSATIONS=false        ← log ตอนรายการห้องแชทอัปเดตด้วย
 *   LOG_CONSOLE_MAX=160             ← ย่อข้อความบนจอกี่ตัวอักษร (ในไฟล์ log เก็บเต็มเสมอ)
 *   LOG_RAW=true                    ← แนบ JSON ดิบของข้อความ+ห้องแชทไว้ในไฟล์ log (default: true)
 *
 * เรื่อง log: บนจอย่อให้อ่านง่าย แต่ในไฟล์ LOG_FILE เก็บครบ — ข้อความเต็ม ไม่ตัด …,
 * การ์ดสินค้า/ออร์เดอร์กางเป็นช่อง ๆ (ชื่อ ตัวเลือก ราคา จำนวน itemId ลิงก์) และถ้า
 * LOG_RAW=true จะมีบรรทัด "↳ raw {...}" ต่อท้ายทุกข้อความ = ข้อมูลดิบทั้งหมดที่ดึงมาได้
 *
 * ลำดับการทำงาน:
 *   1. หา token ที่ใช้ได้ — จากแคช .token.json ก่อน ถ้าใช้ไม่ได้ค่อยล็อกอินด้วย email/password
 *      (ขั้นล็อกอินมีแคปช่ารูปภาพ ต้องพิมพ์เอง — เกิดขึ้นเฉพาะตอน token หมดอายุ ไม่ใช่ทุกครั้งที่รัน)
 *   2. เอา token ที่ได้ไปต่อ REST + socket.io
 *   3. ระหว่างทางถ้าเจอ 401 → ล็อกอินใหม่แล้วต่อ socket ใหม่ให้เอง
 */

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
// ห้องเดิมส่ง "คำตอบเบื้องต้น" ซ้ำได้เร็วสุดกี่นาที (ลูกค้ามักพิมพ์รัวหลายข้อความติดกัน)
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
      const h = v.search(/[ 	]#/);           // ตัดคอมเมนต์ท้ายบรรทัด (เว้นวรรค + #)
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

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
const holdingSentAt = new Map();    // conversationId -> เวลาที่ส่ง "คำตอบเบื้องต้น" ล่าสุด (กันส่งซ้ำ)
let api = null;
let rt = null;
let stopping = false;
let autoTagId = null;               // tagId ของ "รอเจ้าหน้าที่" (resolve ตอน start)
let aiTagId = null;                 // tagId ของ "AI ตอบ" (resolve ตอน start ถ้าเปิด AI)
let myPuid = null;                  // puid ของบัญชี — ใช้ตอนส่งข้อความกลับ

// ---------------------------------------------------------------- ขั้นที่ 1: login

async function authenticate({ force = false } = {}) {
  const s = await getSession({ force, email: EMAIL, password: PASSWORD });
  const how = { cache: 'ใช้ token ที่แคชไว้', env: 'ใช้ DUOKE_TOKEN จาก .env', login: 'ล็อกอินใหม่' }[s.source];
  const left = s.expAt ? ` (เหลืออีก ~${Math.floor((s.expAt - Date.now()) / 86400000)} วัน)` : '';
  log(`${C.gray}${ts()}${C.reset} 🔑 ${how}${left}`);
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
async function addConversationTag(e, info, tagId, label) {
  if (!tagId) return;
  const currentTagIds = info.tagIdList ?? info.dkConversationVO?.tagIdList;
  if (Array.isArray(currentTagIds) && currentTagIds.includes(tagId)) return;
  try {
    const newList = await api.addTagToConversation({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
      tagId, currentTagIds,          // undefined = ให้ไปอ่านของเดิมเอง
    });
    info.tagIdList = newList;         // อัปเดต cache
    if (newList.includes(tagId)) {
      log(`${C.gray}          ↳ 🏷  ติดแท็ก “${label}”${C.reset}`);
    }
  } catch (err) {
    if (isAuthError(err)) return relogin();
    log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠️  ติดแท็กไม่สำเร็จ:${C.reset} ${err.message}`);
  }
}

// เอาแท็กออกจากห้องแชท (idempotent — ไม่มีอยู่ก็ข้าม)
async function removeConversationTag(e, info, tagId, label) {
  if (!tagId) return;
  const currentTagIds = info.tagIdList ?? info.dkConversationVO?.tagIdList;
  if (!Array.isArray(currentTagIds) || !currentTagIds.includes(tagId)) return;
  try {
    await api.deleteConversationTag({ shopId: e.shopId, conversationId: e.conversationId, tagId });
    info.tagIdList = currentTagIds.filter(x => x !== tagId);   // อัปเดต cache
    log(`${C.gray}          ↳ 🏷  เอาแท็ก “${label}” ออก${C.reset}`);
  } catch (err) {
    if (isAuthError(err)) return relogin();
    log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠️  เอาแท็กออกไม่สำเร็จ:${C.reset} ${err.message}`);
  }
}

// ส่ง "คำตอบเบื้องต้น" ให้ลูกค้าตอนที่ยังไม่มีคำตอบที่ส่งได้จริง (เคสละเอียดอ่อนที่ร่างยืนยันไม่ได้ /
// AI ร่างไม่ได้ / โหมดคิวรอคนตอบ) — ลูกค้าจะได้ไม่เงียบระหว่างรอเจ้าหน้าที่
// กันสแปม: ห้องหนึ่งส่งได้ครั้งเดียวต่อ HOLDING_COOLDOWN_MS (ลูกค้ามักพิมพ์รัวหลายข้อความติดกัน)
async function sendHolding(e) {
  if (!ai.autoSend()) return false;
  const text = ai.holdingMessage();
  if (!text) return false;

  const last = holdingSentAt.get(e.conversationId) ?? 0;
  if (Date.now() - last < HOLDING_COOLDOWN_MS) {
    log(`${C.gray}          ↳ 💬 ${C.dim}ส่งคำตอบเบื้องต้นไปแล้วเมื่อไม่นานนี้ — ไม่ส่งซ้ำ${C.reset}`);
    return false;
  }
  try {
    await rt.sendText({
      shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
      text, puid: myPuid,
    });
    if (holdingSentAt.size > 1000) holdingSentAt.clear();
    holdingSentAt.set(e.conversationId, Date.now());
    logLong(`${C.gray}          ↳ 💬 ${C.green}ตอบเบื้องต้นให้ลูกค้าแล้ว${C.reset} ${C.dim}(รอเจ้าหน้าที่ตามต่อ)${C.reset}: `, text);
    return true;
  } catch (err) {
    if (isAuthError(err)) relogin();
    else log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠️  ส่งคำตอบเบื้องต้นไม่สำเร็จ:${C.reset} ${err.message}`);
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
    if (text) log(`${C.gray}          ↳ 🧾 แนบข้อมูลออร์เดอร์ให้ AI ${list.length} รายการ${C.reset}`);
    return text;
  } catch (err) {
    if (isAuthError(err)) relogin();
    log(`${C.gray}          ↳ ${C.yellow}⚠️  ดึงออร์เดอร์ของลูกค้าไม่สำเร็จ:${C.reset} ${err.message}`);
    return '';
  }
}

// ให้ AI ร่างคำตอบทุกข้อความ (จุดต่อ AI อยู่ที่ ai-bot.js)
// จะ "log ร่างคำตอบก่อนเสมอ" แล้วค่อยให้ตัวเรียกจัดการแท็ก
// คืนสถานะ: 'sent' | 'suggested' | 'staff' | 'declined' | 'disabled' | 'error'
async function aiRespond(e, info) {
  if (!ai.isEnabled()) return 'disabled';
  try {
    // ดึงประวัติล่าสุดเป็นบริบท (เก่า → ใหม่)
    const hist = await api.getMessageList({ ...e, pageNo: 1, pageSize: 20 });
    const messages = (hist?.list ?? []).slice().reverse();

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
      log(`${C.gray}          ↳ 📥 ${C.yellow}เข้าคิวให้ Claude Code/คนตอบ${C.reset} (npm run inbox)`);
      await sendHolding(e);          // ตอบเบื้องต้นไปก่อน ระหว่างรอคนในคิวตอบจริง
      return 'staff';
    }

    const r = await ai.generateReply({
      messages,
      shopName: info.shopName ?? e.shopId,
      platform: e.platform,
      buyerName: info.buyerNick,
      orderContext: await orderContextFor(e, info, messages),
    });

    // โชว์ token ที่ใช้ไป — cacheR=0 ตลอด แปลว่า prompt caching ไม่ติด (ดู AI_CACHE_TTL ใน .env)
    const u = ai.lastUsage?.();
    if (u) {
      log(`${C.gray}          ↳ 🎫 in=${u.in} cacheW=${u.cacheWrite} cacheR=${u.cacheRead} out=${u.out}${C.reset}`);
    }

    // ร้านตอบคำถามนี้ครบไปแล้ว → เงียบไว้ ห้ามส่งอะไรซ้ำให้ลูกค้ารำคาญ
    if (r.skip) {
      log(`${C.gray}          ↳ 🤖 ${C.dim}AI ข้าม (${r.reason ?? 'ร้านตอบไปแล้ว'})${C.reset}`);
      return 'declined';
    }

    // ไม่มีร่างคำตอบเลย → อย่างน้อยต้องตอบเบื้องต้นให้ลูกค้า แล้วให้เจ้าหน้าที่ตามต่อ
    if (!r.reply) {
      log(`${C.gray}          ↳ 🤖 ${C.dim}AI ร่างคำตอบไม่ได้ (${r.reason ?? 'ไม่มีคำตอบ'})${C.reset}`);
      await sendHolding(e);
      return 'staff';
    }

    // เคสละเอียดอ่อน → ส่งคำตอบเบื้องต้นให้ลูกค้าก่อน แล้วยังติดแท็กให้เจ้าหน้าที่ตามไปตอบต่อเสมอ
    if (r.needsStaff) {
      const why = r.reason ? ` ${C.dim}[${r.reason}]${C.reset}` : '';
      if (!ai.autoSend()) {
        logLong(`${C.gray}          ↳ 🤖 ${C.yellow}ร่างคำตอบ${C.reset} ${C.dim}(ยังไม่ส่ง — ตั้ง AI_AUTO_SEND=true)${C.reset}${why}: `, r.reply);
        return 'staff';
      }
      // ร่างมีข้อมูลที่ยืนยันไม่ได้ (เช่น แต่งตัวเลขเอง) → ห้ามส่งร่าง ส่งข้อความสำเร็จรูปแทน
      if (r.unsafe) {
        logLong(`${C.gray}          ↳ 🤖 ${C.yellow}ไม่ส่งร่างนี้${C.reset}${why} ${C.dim}ร่างที่ทิ้งไว้ให้เจ้าหน้าที่:${C.reset} `, r.reply);
        await sendHolding(e);
        return 'staff';
      }
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
      logLong(`${C.gray}          ↳ 🤖 ${C.green}ตอบเบื้องต้นแล้ว${C.reset} ${C.dim}(รอเจ้าหน้าที่ตามต่อ)${C.reset}${why}: `, r.reply);
      return 'staff';
    }

    // เคสพื้น ๆ ตอบได้เอง
    if (ai.autoSend()) {
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
      logLong(`${C.gray}          ↳ 🤖 ${C.green}AI ตอบแล้ว:${C.reset} `, r.reply);
      return 'sent';
    }
    logLong(`${C.gray}          ↳ 🤖 ${C.yellow}AI แนะนำตอบ${C.reset} (ยังไม่ส่ง — ตั้ง AI_AUTO_SEND=true เพื่อส่งจริง): `, r.reply);
    return 'suggested';
  } catch (err) {
    if (isAuthError(err)) { relogin(); return 'error'; }
    log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠️  AI ร่างคำตอบไม่สำเร็จ:${C.reset} ${err.message}`);
    await sendHolding(e);            // AI ล่ม/โควตาหมด ลูกค้าก็ยังต้องได้คำตอบเบื้องต้น
    return 'error';
  }
}

function wireEvents() {
  rt.on('state', s => {
    const icon = s.state === 'connected' ? '🟢' : s.state === 'reconnecting' ? '🟡' : '🔴';
    log(`${C.gray}${ts()}${C.reset} ${icon} socket ${s.state}${s.reason ? ' — ' + s.reason : ''}`);
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

        const pc = PLATFORM_COLOR[e.platform] ?? C.gray;
        const who = fromBuyer
          ? `${C.bold}${C.cyan}${info.buyerNick ?? e.conversationId}${C.reset}`
          : `${C.dim}ร้าน${C.reset}`;
        const shop = `${pc}${info.shopName ?? e.shopId}·${e.platform}${C.reset}`;

        logLong(`${C.gray}${ts()}${C.reset} ${fromBuyer ? '💬' : '↩️ '} ${shop} ${who}: `, describe(m));

        if (fromBuyer && info.unReadCount) {
          log(`${C.gray}          ↳ ยังไม่อ่าน ${info.unReadCount} · conversationId=${e.conversationId}${C.reset}`);
        }

        // ข้อมูลดิบทั้งก้อนที่ดึงมาได้ตอนลูกค้าทัก — ลงไฟล์ log อย่างเดียว ไม่รกจอ
        if (LOG_RAW) {
          logFile(`          ↳ raw ${JSON.stringify({
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
      if (sawBuyerMsg) {
        const outcome = await aiRespond(e, info);   // ข้างในจะ log คำตอบ/คำแนะนำก่อนคืนค่า
        if (AUTO_TAG) {
          // AI มีคำตอบ (ตอบจริง 'sent' หรือ แนะนำ 'suggested') → AI จัดการได้
          if (outcome === 'sent' || outcome === 'suggested') {
            await addConversationTag(e, info, aiTagId, AUTO_TAG_AI_NAME);
            await removeConversationTag(e, info, autoTagId, AUTO_TAG_NAME);
          } else {
            // AI ข้าม/เคสละเอียดอ่อน/ปิด/พลาด → ให้เจ้าหน้าที่ตอบ
            await addConversationTag(e, info, autoTagId, AUTO_TAG_NAME);
          }
        }
      }
    } catch (err) {
      if (isAuthError(err)) return relogin();
      log(`${C.gray}${ts()}${C.reset} ${C.red}⚠️  ดึงข้อความไม่สำเร็จ:${C.reset} ${err.message}`);
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

  rt.on('error', err => log(`${C.red}⚠️  ${err.message}${C.reset}`));
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
    log(`${C.gray}${ts()}${C.reset} ✅ ${C.green}กลับมาทำงานแล้ว${C.reset}`);
  } catch (err) {
    log(`${C.red}❌ ล็อกอินใหม่ไม่สำเร็จ: ${err.message}${C.reset}`);
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
const shops = await api.getShops();

// resolve tagId ของ "รอเจ้าหน้าที่" (เจอของเดิมก็ใช้เลย ไม่มีก็สร้างให้)
if (AUTO_TAG) {
  try {
    autoTagId = await api.ensureTag({ tagName: AUTO_TAG_NAME });
    if (!autoTagId) console.log(`${C.yellow}⚠️  หา/สร้างแท็ก “${AUTO_TAG_NAME}” ไม่ได้ — ปิดการติดแท็กอัตโนมัติ${C.reset}`);
    if (ai.isEnabled()) {
      aiTagId = await api.ensureTag({ tagName: AUTO_TAG_AI_NAME, tagColor: 'green' });
      if (!aiTagId) console.log(`${C.yellow}⚠️  หา/สร้างแท็ก “${AUTO_TAG_AI_NAME}” ไม่ได้${C.reset}`);
    }
  } catch (err) {
    console.log(`${C.yellow}⚠️  เตรียมแท็กไม่สำเร็จ: ${err.message} — ปิดการติดแท็กอัตโนมัติ${C.reset}`);
  }
}

console.log(`\n${C.bold}Duoke chat watcher${C.reset}`);
console.log(`${C.dim}บัญชี:${C.reset} ${user.email ?? user.account ?? user.uid}`);
console.log(`${C.dim}ร้าน :${C.reset} ${shops.map(s => `${s.shopName}(${s.platform})`).join(', ')}`);
console.log(`${C.dim}กรอง :${C.reset} ${ONLY_BUYER ? 'เฉพาะข้อความจากลูกค้า' : 'ทุกข้อความ'}${LOG_FILE ? ` · เขียนลง ${path.basename(LOG_FILE)}` : ''}`);
console.log(`${C.dim}แท็ก :${C.reset} ${AUTO_TAG && autoTagId ? `AI ตอบ→“${AUTO_TAG_AI_NAME}” · ที่เหลือ→“${AUTO_TAG_NAME}”` : 'ปิด'}`);
if (ai.isEnabled()) {
  const kb = ai.knowledgeInfo();
  const p = ai.providerInfo();
  const mode = ai.autoSend() ? `${C.green}ตอบอัตโนมัติ (ส่งจริง)${C.reset}` : `${C.yellow}แนะนำคำตอบเท่านั้น (ยังไม่ส่ง)${C.reset}`;
  console.log(`${C.dim}AI   :${C.reset} เปิด — ${mode} · ${p.provider}/${p.model} · ข้อมูล ${kb.count} ไฟล์ใน ${path.basename(kb.dir)}/`);
} else {
  console.log(`${C.dim}AI   :${C.reset} ปิด`);
}
console.log(C.dim + '─'.repeat(70) + C.reset);
log(`${C.gray}${ts()}${C.reset} ✅ ${C.green}พร้อมรับแชท${C.reset} — Ctrl+C เพื่อออก`);

// ปิด socket ให้เรียบร้อยเวลา nodemon รีสตาร์ต (SIGUSR2) หรือกด Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, () => {
    stopping = true;
    rt?.disconnect();
    process.kill(process.pid, sig);
  });
}
