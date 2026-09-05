/**
 * outbox.js — ตัวส่งคำตอบอัตโนมัติ (สะพานให้ Claude ตอบลูกค้าจากระยะไกล)
 *
 *   node outbox.js            → รันค้างไว้ คอยเฝ้าโฟลเดอร์ outbox/
 *
 * วิธีทำงาน:
 *   1. watch.js รับแชทเข้ามา → เขียนคำถาม+บริบทลง inbox/<conversationId>.json
 *   2. Claude อ่าน inbox/ แล้ววางไฟล์คำตอบลง outbox/<conversationId>.json
 *        { "conversationId": "...", "shopId": "...", "platform": "...", "text": "คำตอบ" }
 *      (หรือไฟล์ .txt ที่มีแต่ข้อความ — ตัวสคริปต์จะไปหา shopId/platform จาก inbox/ เอง)
 *   3. สคริปต์นี้ส่งข้อความให้ลูกค้า แล้วย้ายไฟล์ไป outbox/sent/ + ลบออกจาก inbox/
 *
 * ตั้งค่าเพิ่มใน .env ได้:
 *   OUTBOX_POLL_MS=2000      ← ความถี่ในการสแกนโฟลเดอร์ (ms)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';
import { getSession, clearCache } from './duoke-session.js';
import { readInbox, removeInbox } from './inbox-store.js';

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
      const h = v.search(/[ \t]#/);          // ตัดคอมเมนต์ท้ายบรรทัด
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m' };

const OUTBOX_DIR = process.env.OUTBOX_DIR ? path.resolve(process.env.OUTBOX_DIR) : path.join(__dirname, 'outbox');
const SENT_DIR = path.join(OUTBOX_DIR, 'sent');
const FAILED_DIR = path.join(OUTBOX_DIR, 'failed');
const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000);
const LOG_FILE = process.env.LOG_FILE ? path.join(__dirname, process.env.LOG_FILE) : null;

for (const d of [OUTBOX_DIR, SENT_DIR, FAILED_DIR]) fs.mkdirSync(d, { recursive: true });

function ts() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', hour12: false,
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
function log(line) {
  console.log(line);
  if (LOG_FILE) fs.appendFile(LOG_FILE, `${stripAnsi(line)}\n`, () => {});
}

const isAuthError = err => err?.code === 401 || err?.code === 403 || /401|403/.test(err?.message ?? '');

// --------------------------------------------------------------------- state
let api = null;
let rt = null;
let puid = null;
let convIndex = new Map();       // conversationId -> { shopId, platform, buyerNick }
let stopping = false;

async function authenticate({ force = false } = {}) {
  if (force) clearCache();
  const s = await getSession({ force, email: process.env.DUOKE_EMAIL, password: process.env.DUOKE_PASSWORD });
  api = new DuokeApi({ token: s.token, language: 'th' });
  const user = await api.getUser();
  puid = (user.user ?? user).puid ?? user.puid ?? s.puid;
  rt?.disconnect();
  rt = new DuokeRealtime({ api });
  rt.on('state', st => log(`${C.gray}${ts()}${C.reset} ${st.state === 'connected' ? '🟢' : st.state === 'reconnecting' ? '🟡' : '🔴'} socket ${st.state}`));
  rt.on('error', e => log(`${C.yellow}⚠️  ${e.message}${C.reset}`));
  await rt.connect();
  await refreshConvIndex();
  return s;
}

/** ดึงรายการห้องแชทมาเก็บไว้ เผื่อไฟล์คำตอบไม่ได้บอก shopId/platform มา */
async function refreshConvIndex() {
  try {
    const shops = await api.getShops();
    const shopIdList = shops.map(x => x.id ?? x.shopId);
    const res = await api.queryConversationList({ shopIdList, size: 100, offset: 0 });
    const convs = res?.list ?? (Array.isArray(res) ? res : []);
    convIndex = new Map(convs.map(c => [String(c.conversationId), {
      shopId: c.shopId, platform: c.platform, buyerNick: c.buyerNick,
    }]));
  } catch (err) {
    if (isAuthError(err)) throw err;
    log(`${C.yellow}⚠️  ดึงรายการห้องแชทไม่สำเร็จ: ${err.message}${C.reset}`);
  }
}

/** อ่านไฟล์คำตอบ 1 ไฟล์ → { conversationId, shopId, platform, text } */
function parseJob(file) {
  const full = path.join(OUTBOX_DIR, file);
  const base = path.basename(file, path.extname(file));
  const raw = fs.readFileSync(full, 'utf8');

  let job;
  if (file.toLowerCase().endsWith('.json')) {
    job = JSON.parse(raw);
  } else {
    job = { conversationId: base, text: raw };
  }
  job.conversationId = String(job.conversationId ?? base);
  job.text = String(job.text ?? '').replace(/^﻿/, '').trim();

  // เติม shopId/platform ที่ขาด — จาก inbox/ ก่อน แล้วค่อยจากรายการห้องแชท
  if (!job.shopId || !job.platform) {
    const inb = readInbox(job.conversationId);
    if (inb) { job.shopId ??= inb.shopId; job.platform ??= inb.platform; job.buyerName ??= inb.buyerName; }
  }
  if (!job.shopId || !job.platform) {
    const c = convIndex.get(job.conversationId);
    if (c) { job.shopId ??= c.shopId; job.platform ??= c.platform; job.buyerName ??= c.buyerNick; }
  }
  return job;
}

function moveTo(dir, file, note) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${stamp}__${file}`);
  try {
    fs.renameSync(path.join(OUTBOX_DIR, file), dest);
    if (note) fs.appendFileSync(dest + '.note.txt', note + '\n', 'utf8');
  } catch (err) {
    log(`${C.yellow}⚠️  ย้ายไฟล์ ${file} ไม่สำเร็จ: ${err.message}${C.reset}`);
  }
}

let busy = false;
async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    const files = fs.readdirSync(OUTBOX_DIR)
      .filter(f => /\.(json|txt)$/i.test(f))
      .filter(f => !f.startsWith('.') && !f.endsWith('.part'))
      .sort();

    for (const file of files) {
      let job;
      try {
        job = parseJob(file);
      } catch (err) {
        log(`${C.red}❌ อ่านไฟล์ ${file} ไม่ได้: ${err.message}${C.reset}`);
        moveTo(FAILED_DIR, file, 'parse error: ' + err.message);
        continue;
      }

      if (!job.text) {
        log(`${C.yellow}⚠️  ${file} ไม่มีข้อความ — ข้าม${C.reset}`);
        moveTo(FAILED_DIR, file, 'empty text');
        continue;
      }
      if (!job.shopId || !job.platform) {
        await refreshConvIndex();
        const c = convIndex.get(job.conversationId);
        if (c) { job.shopId ??= c.shopId; job.platform ??= c.platform; }
      }
      if (!job.shopId || !job.platform) {
        log(`${C.red}❌ ${file}: ไม่รู้ shopId/platform ของห้อง ${job.conversationId}${C.reset}`);
        moveTo(FAILED_DIR, file, 'missing shopId/platform');
        continue;
      }

      try {
        await rt.sendText({
          shopId: job.shopId,
          conversationId: job.conversationId,
          platform: job.platform,
          text: job.text,
          puid,
        });
        removeInbox(job.conversationId);
        moveTo(SENT_DIR, file);
        const who = job.buyerName ?? job.conversationId;
        log(`${C.gray}${ts()}${C.reset} ✅ ${C.green}ตอบแล้ว${C.reset} → ${C.cyan}${who}${C.reset} ${C.dim}[${job.platform}]${C.reset}: ${job.text.replace(/\s+/g, ' ').slice(0, 120)}`);
      } catch (err) {
        if (isAuthError(err)) {
          log(`${C.yellow}⚠️  token หมดอายุ — ล็อกอินใหม่${C.reset}`);
          await authenticate({ force: true });
          break;                    // ค่อยวนใหม่รอบหน้า ไฟล์ยังอยู่
        }
        log(`${C.red}❌ ส่งไม่สำเร็จ (${file}): ${err.message}${C.reset}`);
        moveTo(FAILED_DIR, file, 'send error: ' + err.message);
      }
    }
  } catch (err) {
    log(`${C.red}⚠️  outbox tick error: ${err.message}${C.reset}`);
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------- start
await authenticate();

console.log(`\n${C.bold}Duoke outbox sender${C.reset}`);
console.log(`${C.dim}เฝ้าโฟลเดอร์:${C.reset} ${OUTBOX_DIR}`);
console.log(`${C.dim}วิธีใช้     :${C.reset} วางไฟล์ ${C.cyan}<conversationId>.txt${C.reset} (ข้อความล้วน) หรือ ${C.cyan}<conversationId>.json${C.reset} ลงในโฟลเดอร์นั้น`);
console.log(`${C.dim}ส่งแล้วเก็บ :${C.reset} outbox/sent/ · ส่งไม่ได้ → outbox/failed/`);
console.log(C.dim + '─'.repeat(70) + C.reset);
log(`${C.gray}${ts()}${C.reset} ✅ ${C.green}พร้อมส่งคำตอบ${C.reset} — Ctrl+C เพื่อออก`);

const timer = setInterval(tick, POLL_MS);
tick();

for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, () => {
    stopping = true;
    clearInterval(timer);
    rt?.disconnect();
    process.kill(process.pid, sig);
  });
}
