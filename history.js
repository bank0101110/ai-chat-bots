/**
 * history.js — อ่านแชท Duoke ออกมาเป็นบทสนทนาทั้งหมด
 *
 *   npm run history                 → ลิสต์ห้องแชททั้งหมด (มีเลขลำดับ + conversationId)
 *   npm run history <n>             → ดึงบทสนทนาทั้งห้องของลำดับที่ n จากลิสต์
 *   npm run history <conversationId>→ ดึงบทสนทนาทั้งห้องตาม conversationId
 *   npm run history --all           → ดึงทุกห้องแบบเต็ม
 *
 * ตัวเลือก:
 *   --out <file>   เขียนผลลงไฟล์ด้วย (เช่น --out chat-history.txt)
 *   --json         พิมพ์เป็น JSON แทนข้อความอ่านง่าย
 *   --limit <n>    จำกัดจำนวนห้องตอนลิสต์/--all (default 200)
 *   --unread       เอาเฉพาะห้องที่มียังไม่อ่าน
 *
 * ล็อกอินด้วยระบบเดียวกับ watch.js (ดู .env / duoke-session.js)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi, parseMessageContent } from './duoke-api.js';
import { getSession } from './duoke-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- .env
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
loadEnv(path.join(__dirname, '.env'));

// ------------------------------------------------------------------ args
const rawArgs = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--all' || a === '--json' || a === '--unread') flags.add(a);
  else if (a === '--out') opts.out = rawArgs[++i];
  else if (a === '--limit') opts.limit = Number(rawArgs[++i]);
  else positional.push(a);
}
const LIMIT = opts.limit || 200;
const target = positional[0];      // เลขลำดับ หรือ conversationId

// ------------------------------------------------------------------ helpers
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', gray: '\x1b[90m', yellow: '\x1b[33m' };
const useColor = process.stdout.isTTY && !opts.out;
const col = (c, s) => (useColor ? c + s + C.reset : s);

const outChunks = [];
function emit(line = '') {
  console.log(line);
  if (opts.out) outChunks.push(line.replace(/\x1b\[[0-9;]*m/g, ''));   // ตัดสี ANSI ตอนลงไฟล์
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d)) return '';
  return d.toLocaleString('th-TH', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** แกะเนื้อความ 1 ข้อความเป็นข้อความอ่านง่าย (ไม่มีสี) */
function renderContent(msg) {
  const c = parseMessageContent(msg) || {};
  switch (msg.messageType) {
    case 'text':
    case 'attachment_text': return c.text ?? '';
    case 'image': return `[รูปภาพ] ${c.imageUrl ?? ''}`.trim();
    case 'video': return `[วิดีโอ] ${c.videoUrl ?? ''}`.trim();
    case 'sticker': return '[สติกเกอร์]';
    case 'product': return `[การ์ดสินค้า] itemId=${c.itemId ?? '-'}`;
    case 'order': return `[การ์ดออร์เดอร์] orderId=${c.orderId ?? '-'}`;
    case 'voucher': return `[คูปอง] ${c.promotionId ?? ''}`.trim();
    case 'file': return `[ไฟล์] ${c.fileName ?? ''}`.trim();
    default: return `[${msg.messageType}] ${c.text ?? JSON.stringify(c)}`;
  }
}

const who = (m) => (m.fromAccountType === 1 ? 'ลูกค้า' : 'ร้าน  ');

// ------------------------------------------------------- ดึงข้อมูลแบบครบทุกหน้า

/** ห้องแชททั้งหมดของทุกร้าน */
async function fetchAllConversations(api, shopIdList) {
  const all = [];
  const size = 50;
  for (let offset = 0; offset < 5000; offset += size) {
    const res = await api.queryConversationList({ shopIdList, size, offset });
    const list = res?.list ?? (Array.isArray(res) ? res : []);
    all.push(...list);
    if (list.length < size) break;
    if (all.length >= LIMIT * 3) break;      // กันดึงเยอะเกิน
  }
  return all;
}

/** ข้อความทั้งหมดของห้องเดียว เรียงเก่า → ใหม่ */
async function fetchAllMessages(api, { shopId, conversationId, platform }) {
  const all = [];
  const pageSize = 50;
  for (let pageNo = 1; pageNo <= 200; pageNo++) {
    const res = await api.getMessageList({ shopId, conversationId, platform, pageNo, pageSize });
    const list = res?.list ?? (Array.isArray(res) ? res : []);
    all.push(...list);
    if (list.length < pageSize) break;
  }
  // getMessageList คืนใหม่→เก่า ต่อหน้า — เรียงรวมด้วย createTime กันสลับหน้า
  all.sort((a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0));
  return all;
}

// ------------------------------------------------------------------ พิมพ์ผล

function printConversationList(convs) {
  emit(col(C.bold, `\n=== ห้องแชททั้งหมด ${convs.length} ห้อง ===`));
  convs.forEach((c, i) => {
    const unread = c.unReadCount ? col(C.yellow, ` ยังไม่อ่าน=${c.unReadCount}`) : '';
    const tags = (c.tagList || []).map(t => t.tagName).join(',');
    const last = c.lastMessageContent ? ` · ${(() => { try { return JSON.parse(c.lastMessageContent).text ?? ''; } catch { return c.lastMessageContent; } })()}` : '';
    emit(`${col(C.dim, String(i + 1).padStart(3))}. ${col(C.cyan, c.buyerNick ?? '(ไม่มีชื่อ)')} ` +
      `${col(C.dim, `[${c.platform}/${c.shopName}]`)}${unread}${tags ? col(C.dim, ` #${tags}`) : ''}` +
      `${col(C.dim, ` (${fmtTime(c.lastMessageTimestamp ?? c.updateTime)})`)}`);
    emit(col(C.gray, `     conversationId=${c.conversationId} shopId=${c.shopId}`) +
      (last ? col(C.dim, `  “${String(last).replace(/\s+/g, ' ').slice(0, 60)}”`) : ''));
  });
  emit(col(C.dim, `\nดูบทสนทนาเต็ม:  npm run history <เลขลำดับ>   หรือ   npm run history <conversationId>`));
}

async function dumpConversation(api, c) {
  const msgs = await fetchAllMessages(api, c);
  emit(col(C.bold, `\n${'═'.repeat(70)}`));
  emit(col(C.bold, `บทสนทนา: ${c.buyerNick ?? '(ไม่มีชื่อ)'}  [${c.platform}/${c.shopName}]`));
  emit(col(C.dim, `conversationId=${c.conversationId}  ·  ${msgs.length} ข้อความ`));
  emit(col(C.bold, '═'.repeat(70)));
  if (!msgs.length) { emit(col(C.dim, '(ไม่มีข้อความ)')); return; }
  for (const m of msgs) {
    const line = renderContent(m).replace(/\n/g, '\n           ');
    emit(`${col(C.gray, fmtTime(m.createTime))} ${col(m.fromAccountType === 1 ? C.cyan : C.dim, who(m))} ${line}`);
  }
}

// ------------------------------------------------------------------ main

const s = await getSession({ email: process.env.DUOKE_EMAIL, password: process.env.DUOKE_PASSWORD });
const api = new DuokeApi({ token: s.token, language: 'th' });

const shops = await api.getShops();
const shopIdList = shops.map(x => x.id ?? x.shopId);

let convs = await fetchAllConversations(api, shopIdList);
if (flags.has('--unread')) convs = convs.filter(c => c.unReadCount > 0);

if (flags.has('--json') && !target && !flags.has('--all')) {
  emit(JSON.stringify(convs, null, 2));
} else if (flags.has('--all')) {
  const picked = convs.slice(0, LIMIT);
  emit(col(C.dim, `กำลังดึง ${picked.length} ห้อง...`));
  for (const c of picked) await dumpConversation(api, c);
} else if (target) {
  // เลือกด้วยเลขลำดับ หรือ conversationId
  let c;
  if (/^\d{1,4}$/.test(target)) c = convs[Number(target) - 1];
  if (!c) c = convs.find(x => String(x.conversationId) === String(target));
  if (!c) {
    emit(col(C.yellow, `หาห้องแชท "${target}" ไม่เจอในลิสต์ (ลอง npm run history เพื่อดูเลขลำดับ)`));
    process.exitCode = 1;
  } else if (flags.has('--json')) {
    emit(JSON.stringify(await fetchAllMessages(api, c), null, 2));
  } else {
    await dumpConversation(api, c);
  }
} else {
  printConversationList(convs.slice(0, LIMIT));
}

if (opts.out) {
  const file = path.isAbsolute(opts.out) ? opts.out : path.join(__dirname, opts.out);
  fs.writeFileSync(file, outChunks.join('\n') + '\n', 'utf8');
  console.log(col(C.dim, `\n📄 เขียนลงไฟล์แล้ว: ${file}`));
}
