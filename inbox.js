/**
 * inbox.js — คิวคำถามที่รอตอบ (สำหรับให้ Claude Code หรือคน อ่านแล้วตอบ)
 *
 *   npm run inbox                              → ลิสต์คำถามที่รอตอบทั้งหมด
 *   npm run inbox -- show <conversationId>     → ดูบริบท+ประวัติเต็มของห้องนั้น
 *   npm run inbox -- answer <conversationId> "คำตอบ"  → ส่งคำตอบ แล้วลบออกจากคิว
 *   npm run inbox -- drop <conversationId>     → เอาออกจากคิวเฉย ๆ (ไม่ตอบ)
 *
 * โหมด AI: ตั้ง AI_PROVIDER=claude-code ใน .env → watch.js จะโยนคำถามลงคิวนี้แทนการเรียก API
 * (แล้ว Claude Code ที่คุยอยู่จะอ่าน knowledge/ + คิวนี้ ร่างคำตอบ แล้วสั่ง answer ให้)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';
import { getSession } from './duoke-session.js';
import { listInbox, readInbox, removeInbox } from './inbox-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
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

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m' };

const [cmd, id, ...rest] = process.argv.slice(2);
const answerText = rest.join(' ').trim();

// ---------------------------------------------------------- list (ค่าเริ่มต้น)
if (!cmd || cmd === 'list') {
  const items = listInbox();
  if (!items.length) { console.log('คิวว่าง — ไม่มีคำถามรอตอบ'); process.exit(0); }
  console.log(`${C.bold}\nคำถามรอตอบ ${items.length} รายการ:${C.reset}`);
  for (const it of items) {
    console.log(`\n${C.cyan}${it.buyerName ?? '(ไม่มีชื่อ)'}${C.reset} ${C.dim}[${it.platform}/${it.shopName}]${C.reset}`);
    console.log(`  ${C.gray}conversationId=${it.conversationId}${C.reset}`);
    const q = (it.messages ?? []).filter(m => m.from === 'ลูกค้า').slice(-1)[0];
    if (q) console.log(`  ${C.yellow}ถาม:${C.reset} ${q.text}`);
  }
  console.log(`${C.dim}\nดูเต็ม:  npm run inbox -- show <conversationId>`);
  console.log(`ตอบ:     npm run inbox -- answer <conversationId> "คำตอบ"${C.reset}`);
  process.exit(0);
}

// ---------------------------------------------------------- show
if (cmd === 'show') {
  const it = readInbox(id);
  if (!it) { console.log('ไม่พบในคิว'); process.exit(1); }
  console.log(JSON.stringify(it, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------- drop
if (cmd === 'drop') {
  console.log(removeInbox(id) ? 'เอาออกจากคิวแล้ว' : 'ไม่พบในคิว');
  process.exit(0);
}

// ---------------------------------------------------------- answer (ส่งจริง)
if (cmd === 'answer') {
  const it = readInbox(id);
  if (!it) { console.log(`${C.yellow}ไม่พบ conversationId นี้ในคิว${C.reset}`); process.exit(1); }
  if (!answerText) { console.log(`${C.yellow}ใส่ข้อความด้วย: npm run inbox -- answer <id> "คำตอบ"${C.reset}`); process.exit(1); }

  const s = await getSession({ email: process.env.DUOKE_EMAIL, password: process.env.DUOKE_PASSWORD });
  const api = new DuokeApi({ token: s.token, language: 'th' });
  const user = await api.getUser();
  const puid = (user.user ?? user).puid ?? user.puid ?? s.puid;

  const rt = new DuokeRealtime({ api });
  await rt.connect();
  try {
    await rt.sendText({ shopId: it.shopId, conversationId: it.conversationId, platform: it.platform, text: answerText, puid });
    removeInbox(it.conversationId);
    console.log(`${C.green}✅ ตอบแล้ว${C.reset} → ${it.buyerName ?? it.conversationId}: ${answerText}`);
  } finally {
    rt.disconnect();
  }
  process.exit(0);
}

console.log(`${C.yellow}คำสั่งไม่รู้จัก: ${cmd}${C.reset}\nใช้: list | show <id> | answer <id> "คำตอบ" | drop <id>`);
process.exit(1);
