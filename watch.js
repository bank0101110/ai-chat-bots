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
const LOG_FILE = process.env.LOG_FILE ? path.join(__dirname, process.env.LOG_FILE) : null;

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

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

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

function preview(text, max = 160) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

function describe(msg) {
  const c = parseMessageContent(msg) || {};
  switch (msg.messageType) {
    case 'text':
    case 'attachment_text': return preview(c.text);
    case 'image': return `${C.dim}[รูปภาพ]${C.reset} ${c.imageUrl ?? ''}`;
    case 'video': return `${C.dim}[วิดีโอ]${C.reset} ${c.videoUrl ?? ''}`;
    case 'sticker': return `${C.dim}[สติกเกอร์]${C.reset}`;
    case 'product': return `${C.dim}[การ์ดสินค้า]${C.reset} itemId=${c.itemId ?? '-'}`;
    case 'order': return `${C.dim}[การ์ดออร์เดอร์]${C.reset} orderId=${c.orderId ?? '-'}`;
    case 'voucher': return `${C.dim}[คูปอง]${C.reset} ${c.promotionId ?? ''}`;
    case 'file': return `${C.dim}[ไฟล์]${C.reset} ${c.fileName ?? ''}`;
    default: return `${C.dim}[${msg.messageType}]${C.reset} ${preview(c.text ?? JSON.stringify(c), 100)}`;
  }
}

const isAuthError = err => err?.code === 401 || err?.code === 403 || /401|403/.test(err?.message ?? '');

// --------------------------------------------------------------------- state

const convCache = new Map();        // conversationId -> conversation object
const seenMessageIds = new Set();   // กัน log ซ้ำ
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
      return 'staff';
    }

    const r = await ai.generateReply({
      messages,
      shopName: info.shopName ?? e.shopId,
      platform: e.platform,
      buyerName: info.buyerNick,
    });

    // โชว์ token ที่ใช้ไป — cacheR=0 ตลอด แปลว่า prompt caching ไม่ติด (ดู AI_CACHE_TTL ใน .env)
    const u = ai.lastUsage?.();
    if (u) {
      log(`${C.gray}          ↳ 🎫 in=${u.in} cacheW=${u.cacheWrite} cacheR=${u.cacheRead} out=${u.out}${C.reset}`);
    }

    // ไม่มีร่างคำตอบเลย (ข้อความว่าง/ไม่ใช่คำถาม) → ให้เจ้าหน้าที่
    if (!r.reply) {
      log(`${C.gray}          ↳ 🤖 ${C.dim}AI ข้าม (${r.reason ?? 'ไม่มีคำตอบ'})${C.reset}`);
      return 'declined';
    }

    // เคสละเอียดอ่อน → ร่างไว้ให้เจ้าหน้าที่อ่านก่อนตอบ (ไม่ส่งอัตโนมัติแม้เปิด auto-send)
    if (r.needsStaff) {
      const why = r.reason ? ` ${C.dim}[${r.reason}]${C.reset}` : '';
      log(`${C.gray}          ↳ 🤖 ${C.yellow}ร่างคำตอบ (ให้เจ้าหน้าที่ตรวจก่อน)${C.reset}${why}: ${preview(r.reply)}`);
      return 'staff';
    }

    // เคสพื้น ๆ ตอบได้เอง
    if (ai.autoSend()) {
      await rt.sendText({
        shopId: e.shopId, conversationId: e.conversationId, platform: e.platform,
        text: r.reply, puid: myPuid,
      });
      log(`${C.gray}          ↳ 🤖 ${C.green}AI ตอบแล้ว:${C.reset} ${preview(r.reply)}`);
      return 'sent';
    }
    log(`${C.gray}          ↳ 🤖 ${C.yellow}AI แนะนำตอบ${C.reset} (ยังไม่ส่ง — ตั้ง AI_AUTO_SEND=true เพื่อส่งจริง): ${preview(r.reply)}`);
    return 'suggested';
  } catch (err) {
    if (isAuthError(err)) { relogin(); return 'error'; }
    log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠️  AI ร่างคำตอบไม่สำเร็จ:${C.reset} ${err.message}`);
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

        log(`${C.gray}${ts()}${C.reset} ${fromBuyer ? '💬' : '↩️ '} ${shop} ${who}: ${describe(m)}`);

        if (fromBuyer && info.unReadCount) {
          log(`${C.gray}          ↳ ยังไม่อ่าน ${info.unReadCount} · conversationId=${e.conversationId}${C.reset}`);
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
