/**
 * reply.js — ตอบแชทลูกค้าผ่านเทอร์มินัลโดยตรง
 *
 *   npm run reply                          → ลิสต์ห้องแชท (เลขลำดับ + conversationId)
 *   npm run reply -- <n> "ข้อความ"          → ตอบห้องลำดับ n จากลิสต์
 *   npm run reply -- <conversationId> "ข้อความ"
 *   npm run reply -- <n>                    → ไม่ใส่ข้อความ = เปิดโหมดพิมพ์ตอบทีละห้อง
 *
 * ล็อกอิน + ต่อ socket ด้วยระบบเดียวกับ watch.js (ดู .env)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DuokeApi, parseMessageContent } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';
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
      if (v.startsWith('#')) v = '';           // ทั้งบรรทัดหลัง = เป็นคอมเมนต์ → ถือว่าไม่ได้ตั้งค่า

      const h = v.search(/[ 	]#/);           // ตัดคอมเมนต์ท้ายบรรทัด (เว้นวรรค + #)
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m' };

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const target = args[0];                       // เลขลำดับ หรือ conversationId
const text = args.slice(1).join(' ').trim();  // ข้อความ (ถ้ามี)

function lastText(c) {
  if (!c.lastMessageContent) return '';
  try { return JSON.parse(c.lastMessageContent).text ?? ''; } catch { return c.lastMessageContent; }
}

// ------------------------------------------------------------------ main
const s = await getSession({ email: process.env.DUOKE_EMAIL, password: process.env.DUOKE_PASSWORD });
const api = new DuokeApi({ token: s.token, language: 'th' });

const user = await api.getUser();
const puid = (user.user ?? user).puid ?? user.puid ?? s.puid;
const shops = await api.getShops();
const shopIdList = shops.map(x => x.id ?? x.shopId);

// ดึงห้องแชทมาให้เลือก
const res = await api.queryConversationList({ shopIdList, size: 50, offset: 0 });
const convs = res?.list ?? (Array.isArray(res) ? res : []);

if (!convs.length) {
  console.log('ไม่มีห้องแชท');
  process.exit(0);
}

// หาห้องเป้าหมาย
function pick(t) {
  if (!t) return null;
  if (/^\d{1,3}$/.test(t)) return convs[Number(t) - 1] ?? null;
  return convs.find(c => String(c.conversationId) === String(t)) ?? null;
}

const rt = new DuokeRealtime({ api });

async function send(conv, msg) {
  await rt.connect();
  try {
    await rt.sendText({
      shopId: conv.shopId, conversationId: conv.conversationId,
      platform: conv.platform, text: msg, puid,
    });
    console.log(`${C.green}✅ ส่งแล้ว${C.reset} → ${conv.buyerNick ?? conv.conversationId}: ${msg}`);
  } finally {
    rt.disconnect();
  }
}

if (!target) {
  // โหมดลิสต์
  console.log(`${C.bold}\nห้องแชท ${convs.length} ห้อง:${C.reset}`);
  convs.forEach((c, i) => {
    const unread = c.unReadCount ? `${C.yellow} ยังไม่อ่าน=${c.unReadCount}${C.reset}` : '';
    console.log(`${C.dim}${String(i + 1).padStart(3)}.${C.reset} ${C.cyan}${c.buyerNick ?? '(ไม่มีชื่อ)'}${C.reset} ` +
      `${C.dim}[${c.platform}/${c.shopName}]${C.reset}${unread}`);
    const lt = lastText(c);
    if (lt) console.log(`     ${C.dim}“${String(lt).replace(/\s+/g, ' ').slice(0, 70)}”${C.reset}`);
    console.log(`     ${C.gray}conversationId=${c.conversationId}${C.reset}`);
  });
  console.log(`${C.dim}\nตอบ:  npm run reply -- <เลขลำดับ> "ข้อความ"${C.reset}`);
  process.exit(0);
}

const conv = pick(target);
if (!conv) {
  console.log(`${C.yellow}หาห้อง "${target}" ไม่เจอ — รัน npm run reply เพื่อดูเลขลำดับ${C.reset}`);
  process.exit(1);
}

if (text) {
  // ส่งครั้งเดียวจบ
  await send(conv, text);
  process.exit(0);
}

// โหมดพิมพ์ตอบ (interactive) — แสดงประวัติล่าสุดแล้วให้พิมพ์
const hist = await api.getMessageList({ shopId: conv.shopId, conversationId: conv.conversationId, platform: conv.platform, pageSize: 10 });
const msgs = (hist?.list ?? []).slice().reverse();
console.log(`${C.bold}\n== ${conv.buyerNick ?? conv.conversationId} [${conv.platform}/${conv.shopName}] ==${C.reset}`);
for (const m of msgs) {
  const who = m.fromAccountType === 1 ? `${C.cyan}ลูกค้า${C.reset}` : `${C.dim}ร้าน  ${C.reset}`;
  console.log(`  ${who} ${parseMessageContent(m).text ?? '(' + m.messageType + ')'}`);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const msg = (await rl.question(`${C.green}พิมพ์คำตอบ:${C.reset} `)).trim();
rl.close();
if (!msg) { console.log('ยกเลิก (ไม่ได้พิมพ์อะไร)'); process.exit(0); }
await send(conv, msg);
process.exit(0);
