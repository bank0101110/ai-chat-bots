/**
 * ai-bot.js — จุดต่อ AI (แชทบอท) ของโปรเจกต์นี้
 * ============================================================================
 *  ★★★  นี่คือ "จุดต่อ AI" — แก้ prompt / โมเดล / ตรรกะการตอบทั้งหมดที่ไฟล์นี้  ★★★
 * ============================================================================
 *
 * หน้าที่: รับประวัติแชทของห้องหนึ่ง → ให้ Claude ตัดสินใจว่าจะตอบไหม + ตอบว่าอะไร
 * watch.js เป็นคนเรียก generateReply() แล้วเอาข้อความไปส่งกลับผ่าน socket
 *
 * ต่อ API:
 *   1. ใส่ ANTHROPIC_API_KEY ใน .env  (คีย์จาก https://console.anthropic.com)
 *   2. ตั้ง AI_ENABLED=true            เปิดใช้งาน
 *   3. (ถ้าอยากให้ "ส่งจริง") ตั้ง AI_AUTO_SEND=true — ไม่งั้นจะแค่ "แนะนำคำตอบ" ใน log
 *
 * ข้อมูลที่ AI ได้เห็นในแต่ละครั้ง:
 *   - ข้อความ + การ์ดสินค้า/การ์ดคำสั่งซื้อ (กางเป็นรายละเอียดให้ ดู renderForAI)
 *   - รูปที่ลูกค้าส่งมาจริง ๆ แนบเป็น image block (AI_READ_IMAGES / AI_MAX_IMAGES)
 *   - คำสั่งซื้อจริงของลูกค้าคนนั้นจาก Duoke — watch.js ส่งมาทาง orderContext
 *     (ดู formatOrders + needsOrderInfo · ตั้งค่าโหมดที่ AI_ORDER_CONTEXT)
 *
 * รองรับ 3 เจ้า เลือกด้วย AI_PROVIDER ใน .env:
 *   anthropic (ค่าเริ่มต้น) → Claude   · ใช้ ANTHROPIC_API_KEY · โมเดลเริ่มต้น claude-haiku-4-5
 *   openai                  → GPT      · ใช้ OPENAI_API_KEY    · โมเดลเริ่มต้น gpt-4o-mini
 *   gemini                  → Gemini   · ใช้ GEMINI_API_KEY    · โมเดลเริ่มต้น gemini-3.5-flash
 * เปลี่ยนโมเดลเองได้ด้วย AI_MODEL (เช่น claude-sonnet-5, gpt-4o)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { parseMessageContent } from './duoke-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ธงบรรทัดแรกที่ให้ AI ระบุว่าเคสนี้จัดการยังไง (AI จะ "ร่างคำตอบให้เสมอ")
//   [[AUTO]]  = คำถามพื้น ๆ ตอบได้เองมั่นใจ (ตอบจบในตัว / ติดแท็ก "AI ตอบ")
//   [[STAFF]] = เคสละเอียดอ่อน/ไม่มั่นใจ — ส่งร่างเป็น "คำตอบเบื้องต้น" ให้ลูกค้าก่อน
//               แล้วติดแท็ก "รอเจ้าหน้าที่" ให้คนตามไปตอบต่อ (ลูกค้าไม่ถูกปล่อยเงียบ)
//   [[SKIP]]  = ร้านตอบคำถามนั้นครบไปแล้ว ไม่ต้องตอบซ้ำ
const MARK_RE = /\[\[\s*(AUTO|STAFF|SKIP)\s*\]\]/i;

// AI สั่งให้ส่ง "การ์ดสินค้า" ตามหลังข้อความได้ ด้วย [[SEND_ITEM:<รหัสสินค้า>]]
// รหัสต้องมีอยู่จริงในคลังสินค้าเท่านั้น ไม่งั้นทิ้ง (กัน AI แต่งรหัสขึ้นมาเอง)
const SEND_ITEM_RE = /\[\[\s*SEND_ITEM\s*:\s*(\d{5,20})\s*\]\]/i;

// ข้อความ "ตอบเบื้องต้น" สำเร็จรูป — ใช้เมื่อไม่มีร่างที่ส่งให้ลูกค้าได้จริง
// (ร่างมีตัวเลขที่ยืนยันไม่ได้ / AI ร่างไม่ได้-พลาด / โหมดคิวรอคนตอบ) เพื่อไม่ให้ลูกค้าเงียบ
// ตั้ง AI_HOLDING_MESSAGE ใน .env เพื่อเปลี่ยนข้อความ · ใส่ค่าว่างเพื่อปิด
const HOLDING_MESSAGE = 'สวัสดีครับ ทางร้านได้รับข้อความแล้วนะครับ ' +
  'เรื่องนี้ขอตรวจสอบข้อมูลให้ละเอียดก่อนสักครู่ เดี๋ยวเจ้าหน้าที่จะรีบติดต่อกลับมาตอบให้ครับ';

/** ข้อความตอบเบื้องต้นที่จะส่งให้ลูกค้าระหว่างรอเจ้าหน้าที่ ('' = ปิด ไม่ส่ง) */
export function holdingMessage() {
  return (process.env.AI_HOLDING_MESSAGE ?? HOLDING_MESSAGE).trim();
}

// ลูกค้าเปิดแชทมาแต่ไม่ได้ส่งอะไรที่ตอบได้ (ข้อความว่าง / ชนิดที่อ่านไม่ออก)
// → ชวนให้พิมพ์คำถามมา ดีกว่าปล่อยเงียบหรือส่งข้อความ "ขอตรวจสอบก่อน" ที่ไม่ตรงเรื่อง
// ตั้ง AI_ASK_MESSAGE ใน .env เพื่อเปลี่ยนข้อความ · ใส่ค่าว่างเพื่อปิด
const ASK_MESSAGE = 'สวัสดีครับ ลูกค้าต้องการสอบถามด้านใด สามารถถามมาได้เลยครับ';

/** ข้อความชวนถาม เมื่อลูกค้าไม่ได้ส่งอะไรที่ตอบได้ ('' = ปิด ไม่ส่ง) */
export function askMessage() {
  return (process.env.AI_ASK_MESSAGE ?? ASK_MESSAGE).trim();
}

/** คืนผลลัพธ์แบบ "ชวนให้ลูกค้าถามมา" (ถ้าปิดข้อความไว้ ก็ไม่ตอบเหมือนเดิม) */
function askBack(reason) {
  const msg = askMessage();
  return msg
    ? { reply: msg, needsStaff: false, reason }
    : { needsStaff: true, reason };
}

// เลือกเจ้าของ AI: 'anthropic' (Claude, ค่าเริ่มต้น) หรือ 'openai' (GPT)
const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 1024);

/** โมเดลตัวเล็ก/ถูกของแต่ละเจ้า ใช้เมื่อไม่ได้ตั้ง AI_MODEL */
function defaultModel() {
  if (PROVIDER === 'openai') return 'gpt-4o-mini';
  if (PROVIDER === 'gemini') return 'gemini-3.5-flash';
  return 'claude-haiku-4-5';
}

// ชื่อโมเดลของแต่ละเจ้า — ใช้ตรวจว่า AI_MODEL ที่ตั้งไว้เข้ากับ AI_PROVIDER ที่เลือกไหม
const MODEL_PATTERN = {
  anthropic: /^claude-/i,
  openai: /^(gpt-|o\d)/i,
  gemini: /^(gemini-|models\/gemini-)/i,
};
let _modelWarning = null;

/** ถ้า AI_MODEL ไม่เข้ากับ provider ที่เลือก ให้ใช้ค่าเริ่มต้นของ provider นั้นแทน */
function resolveModel() {
  const want = (process.env.AI_MODEL || '').trim();
  const fallback = defaultModel();
  if (!want) return fallback;
  const re = MODEL_PATTERN[PROVIDER];
  if (re && !re.test(want)) {
    _modelWarning = `AI_MODEL="${want}" ไม่ใช่โมเดลของ ${PROVIDER} — ใช้ ${fallback} แทน (ลบ AI_MODEL ใน .env หรือเปลี่ยนให้ตรง provider)`;
    return fallback;
  }
  return want;
}
let _model = null;
/** โมเดลที่ใช้จริง (คิดครั้งเดียวแล้วจำไว้) */
function modelName() {
  if (_model === null) _model = resolveModel();
  return _model;
}

// ต้องเห็นบริบทย้อนหลังพอ ไม่งั้นข้อความสั้น ๆ อย่าง "5*8" หรือ "เอาอันนี้" จะตีความไม่ออก
const MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 20);   // กี่ข้อความล่าสุดที่ป้อนให้ AI
// ให้ AI "ดูรูป" ที่ลูกค้าส่งมาจริง ๆ (ต้องใช้โมเดลที่อ่านรูปได้ — claude ทุกตัว / gpt-4o ขึ้นไป)
const READ_IMAGES = (process.env.AI_READ_IMAGES ?? 'true') !== 'false';
const MAX_IMAGES = Number(process.env.AI_MAX_IMAGES || 3);      // แนบกี่รูปล่าสุด (รูปละ ~1-1.6k tokens)
// ข้อความยาวเกินนี้จะตัดท้ายทิ้ง — กันข้อความ auto-reply ยาว ๆ ของร้าน (100-200 tokens/ข้อความ) กินโควตา
const MAX_MSG_CHARS = Number(process.env.AI_MAX_MSG_CHARS || 220);

// prompt caching: แคชบล็อกกติกา+knowledge ไว้ อ่านซ้ำถูกลง 10 เท่า
//   '5m' (ค่าเริ่มต้น) = ค่าเขียน 1.25 เท่า · '1h' = ค่าเขียน 2 เท่า แต่แคชอยู่ได้ 1 ชั่วโมง
//   ⚠ แต่ละโมเดลมีขั้นต่ำที่แคชได้ ถ้า prompt สั้นกว่านั้นจะไม่แคชเงียบ ๆ (ไม่มี error):
//     claude-haiku-4-5 = 4096 tokens · claude-sonnet-5 = 1024 · claude-opus-5 = 512
//   เช็คว่าแคชติดไหมดูที่ lastUsage().cacheRead — ถ้าเป็น 0 ตลอด แปลว่าไม่ติด
//   ค่าเริ่มต้น '1h' เพราะแชทร้านมีช่วงเงียบเกิน 5 นาทีบ่อย ถ้าใช้ 5m แคชจะหมดอายุแล้ว
//   ต้องเขียนใหม่ (~0.28 บาท/ครั้ง) ส่วน 1h เขียนแพงกว่าครั้งเดียวแต่อยู่ยาว คุ้มกว่ามาก
const CACHE_TTL = process.env.AI_CACHE_TTL || '1h';
const CACHE_CONTROL = CACHE_TTL === '1h'
  ? { type: 'ephemeral', ttl: '1h' }
  : { type: 'ephemeral' };

// ---------------------------------------------- ★ knowledge base (โฟลเดอร์ข้อมูล) ★
// อ่านทุกไฟล์ในโฟลเดอร์ knowledge/ มาเป็น "ความรู้" ให้ AI ใช้ตอบลูกค้า
// แก้ไฟล์แล้วระบบอ่านใหม่อัตโนมัติ (เช็คจาก mtime) ไม่ต้องรีสตาร์ต

const KNOWLEDGE_DIR = process.env.AI_KNOWLEDGE_DIR
  ? path.resolve(process.env.AI_KNOWLEDGE_DIR)
  : path.join(__dirname, 'knowledge');
const KNOWLEDGE_EXT = ['.txt', '.md', '.csv', '.json', '.text'];
const SKIP_FILES = new Set(['readme.md']);   // ไม่เอาไฟล์อธิบายไปปนกับข้อมูลจริง

// ---------------------------------------------- ★ คลังสินค้า (โหลดเฉพาะที่ต้องใช้) ★
// knowledge/products/ มีสินค้า 687 รายการ = หลายแสนโทเคน ยัดเข้า prompt ทุกข้อความไม่ไหว
// จึงโหลดเฉพาะตัวที่เกี่ยวกับคำถามนั้นจริง ๆ:
//   - ลูกค้าส่งการ์ดสินค้า → เปิดไฟล์ รายละเอียด/<itemId>.md ตรง ๆ (ชื่อไฟล์ = itemId)
//   - ลูกค้าพิมพ์ชื่อสินค้า → ค้นจาก catalog.tsv ในเครื่อง (ไม่เสียเงิน ไม่เรียก API)
const PRODUCTS_DIR = path.join(KNOWLEDGE_DIR, 'products');
const DETAIL_DIR = path.join(PRODUCTS_DIR, 'รายละเอียด');
const CATALOG_FILE = path.join(PRODUCTS_DIR, 'catalog.tsv');
const MAX_DETAIL_FILES = Number(process.env.AI_MAX_PRODUCT_FILES || 2);
// ไฟล์รายละเอียดส่วนใหญ่ ~420 ตัวอักษร แต่มีหางยาวถึง 5,500 (คำโฆษณาซ้ำ ๆ ของผู้ขาย)
// ตัดที่ 1,200 ครอบคลุม 90% ของไฟล์แบบไม่เสียเนื้อหา และกันไฟล์ยาวผิดปกติกินโทเคน
const MAX_DETAIL_CHARS = Number(process.env.AI_MAX_PRODUCT_CHARS || 1200);

/** อ่านรายละเอียดสินค้าตาม itemId — คืน '' ถ้าไม่มีไฟล์ */
export function loadProductDetail(itemId) {
  if (!/^\d{1,20}$/.test(String(itemId ?? ''))) return '';   // กัน path traversal
  try {
    const body = fs.readFileSync(path.join(DETAIL_DIR, `${itemId}.md`), 'utf8').trim();
    return body.length > MAX_DETAIL_CHARS ? body.slice(0, MAX_DETAIL_CHARS) + '\n…(ตัดท้าย)' : body;
  } catch { return ''; }
}

// ---- ไฟล์หัวข้อ: knowledge/หัวข้อ/*.md ----
// ข้อมูลก้อนใหญ่ที่ลูกค้าถามเป็นครั้งคราว (ตารางจำนวนบรรจุ, สเปกยี่ห้อ) ถ้ายัดไว้ใน
// system prompt จะจ่ายทุกข้อความทั้งที่ใช้จริงไม่กี่ครั้ง จึงโหลดเฉพาะตอนที่ลูกค้าถามถึง
// บรรทัดแรกของไฟล์ต้องเป็น "keywords: คำ1, คำ2, ..." — เจอคำไหนในข้อความลูกค้าก็โหลดไฟล์นั้น
const TOPIC_DIR = path.join(KNOWLEDGE_DIR, 'หัวข้อ');
let _topics = null;

function loadTopics() {
  if (_topics) return _topics;
  _topics = [];
  try {
    for (const f of fs.readdirSync(TOPIC_DIR)) {
      if (!KNOWLEDGE_EXT.includes(path.extname(f).toLowerCase())) continue;
      const body = fs.readFileSync(path.join(TOPIC_DIR, f), 'utf8');
      const m = /^keywords:\s*(.+)$/im.exec(body);
      if (!m) continue;                       // ไม่มีบรรทัด keywords = ข้าม
      _topics.push({
        file: f,
        keys: m[1].split(',').map(s => norm(s)).filter(s => s.length >= 2),
        text: body.replace(/^keywords:.*$/im, '').trim(),
      });
    }
  } catch { /* ไม่มีโฟลเดอร์ = ไม่มีหัวข้อ */ }
  return _topics;
}

/** หาไฟล์หัวข้อที่ตรงกับคำถามลูกค้า — คืน '' ถ้าไม่ตรงอะไรเลย */
function matchTopics(text) {
  const q = norm(text);
  if (q.length < 2) return '';
  return loadTopics()
    .filter(t => t.keys.some(k => q.includes(k)))
    .map(t => t.text)
    .join('\n\n');
}

let _catalog = null;
/** โหลด catalog.tsv → [{id, name, cat, sub, brand, opts}] (แคชไว้ในหน่วยความจำ) */
function loadCatalog() {
  if (_catalog) return _catalog;
  try {
    _catalog = fs.readFileSync(CATALOG_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(l => l && !l.startsWith('#') && !l.startsWith('id\t'))
      .map(l => {
        const [id, name, cat, sub, brand, opts] = l.split('\t');
        return { id, name: name ?? '', cat: cat ?? '', sub: sub ?? '', brand: brand ?? '', opts: opts ?? '' };
      })
      .filter(r => r.id);
  } catch { _catalog = []; }
  return _catalog;
}

// คำที่เจอในทุกประโยคจนไม่ช่วยแยกสินค้า — ตัดทิ้งก่อนค้น
const STOPWORDS = /(สวัสดี|ครับ|ค่ะ|คะ|ขอ|อยาก|สอบถาม|รบกวน|ไหม|มั้ย|หน่อย|ราคา|เท่าไหร่|เท่าไร|ยังไง|อย่างไร|มีขาย|สินค้า|ตัวนี้|อันนี้|นะ|ๆ|\s)/g;

/**
 * ค้นสินค้าจากชื่อที่ลูกค้าพิมพ์ — ทำในเครื่อง ไม่เสียเงิน
 * ภาษาไทยไม่มีเว้นวรรคระหว่างคำ จึงใช้วิธีตัด n-gram แล้วนับว่าตรงกับชื่อสินค้ากี่ชิ้น
 */
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, '');

export function searchProducts(text, limit = 5) {
  const q = norm(String(text ?? '').replace(STOPWORDS, ' '));
  if (q.length < 3) return [];
  const grams = new Set();
  for (let len = Math.min(q.length, 10); len >= 3; len--) {
    for (let i = 0; i + len <= q.length; i++) grams.add(q.slice(i, i + len));
  }
  const rows = loadCatalog();
  const scored = [];
  for (const r of rows) {
    // ตัดช่องว่างฝั่งชื่อสินค้าด้วย ไม่งั้น "ท่อPVC" จะจับกับ "ท่อ PVC" ไม่ติด
    const hay = norm(`${r.name} ${r.sub} ${r.brand}`);
    let best = 0, score = 0;
    for (const g of grams) {
      if (!hay.includes(g)) continue;
      score += g.length;
      if (g.length > best) best = g.length;
    }
    // ต้องมีท่อนที่ตรงยาวอย่างน้อย 4 ตัวอักษร ไม่งั้นเป็นการบังเอิญตรงสั้น ๆ เช่น "4นิ้ว"
    if (best >= 5) scored.push({ ...r, score, best });
  }
  return scored.sort((a, b) => b.best - a.best || b.score - a.score).slice(0, limit);
}

let _kbCache = { sig: null, text: '' };

/** โหลดความรู้จากโฟลเดอร์ knowledge/ (แคชไว้ อ่านใหม่เมื่อไฟล์เปลี่ยน) */
export function loadKnowledge() {
  let entries;
  try {
    entries = fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true });
  } catch {
    return '';                       // ไม่มีโฟลเดอร์ = ไม่มีความรู้
  }
  const files = entries
    .filter(e => e.isFile() && KNOWLEDGE_EXT.includes(path.extname(e.name).toLowerCase()))
    .filter(e => !SKIP_FILES.has(e.name.toLowerCase()))
    .map(e => path.join(KNOWLEDGE_DIR, e.name))
    .sort();

  // ลายเซ็น = ชื่อไฟล์+เวลาแก้ล่าสุด → เปลี่ยนเมื่อไหร่ค่อยอ่านใหม่
  const sig = files.map(f => { try { return f + ':' + fs.statSync(f).mtimeMs; } catch { return f; } }).join('|');
  if (sig === _kbCache.sig) return _kbCache.text;

  const parts = [];
  for (const f of files) {
    try {
      const body = fs.readFileSync(f, 'utf8').trim();
      if (body) parts.push(`### ไฟล์: ${path.basename(f)}\n${body}`);
    } catch {}
  }
  _kbCache = { sig, text: parts.join('\n\n') };
  return _kbCache.text;
}

/** จำนวนไฟล์ความรู้ที่โหลดได้ (ไว้โชว์สถานะ) */
export function knowledgeInfo() {
  try {
    const n = fs.readdirSync(KNOWLEDGE_DIR)
      .filter(f => KNOWLEDGE_EXT.includes(path.extname(f).toLowerCase()) && !SKIP_FILES.has(f.toLowerCase()))
      .length;
    return { dir: KNOWLEDGE_DIR, count: n };
  } catch {
    return { dir: KNOWLEDGE_DIR, count: 0 };
  }
}

/** เปิดใช้งาน AI ไหม (ตั้งใน .env) */
export function isEnabled() {
  return (process.env.AI_ENABLED ?? 'false') === 'true';
}

/** ส่งจริง หรือแค่แนะนำคำตอบใน log (ตั้งใน .env) */
export function autoSend() {
  return (process.env.AI_AUTO_SEND ?? 'false') === 'true';
}

// ------------------------------------------------------------------ client

let anthropicClient = null;
let openaiClient = null;

/** คีย์ต้องเป็น ASCII ล้วน — ถ้ามีคอมเมนต์ไทยติดมาท้ายบรรทัดใน .env จะพังตอนใส่ HTTP header */
function cleanApiKey(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return '';
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    throw new Error(
      `${name} ใน .env มีอักขระแปลกปน (เช่น ช่องว่างหรือคอมเมนต์ไทยติดท้ายบรรทัด) — ` +
      `ให้บรรทัดนั้นมีแค่ ${name}=<คีย์> เท่านั้น ห้ามมีอะไรต่อท้าย`
    );
  }
  return raw;
}

function getAnthropic() {
  if (!anthropicClient) {
    const apiKey = cleanApiKey('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ยังไม่ได้ตั้ง ANTHROPIC_API_KEY ใน .env (คีย์จาก console.anthropic.com)');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// Gemini มี endpoint ที่เข้ากันได้กับ OpenAI จึงใช้ไลบรารี openai ตัวเดิมได้เลย
// ไม่ต้องลง SDK เพิ่ม — แค่เปลี่ยน baseURL กับคีย์
// ⚠ ทางนี้ไม่มี prompt caching แบบสั่งเองและไม่มีเครื่องมือค้นเว็บ (Gemini แคชให้เองอัตโนมัติ)
const GEMINI_BASE_URL = process.env.AI_GEMINI_BASE_URL
  || 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** ใช้ร่วมกันทั้ง openai และ gemini เพราะรูปแบบ API เหมือนกัน */
function getOpenAICompatible() {
  if (openaiClient) return openaiClient;
  if (PROVIDER === 'gemini') {
    const apiKey = cleanApiKey('GEMINI_API_KEY') || cleanApiKey('GOOGLE_API_KEY');
    if (!apiKey) {
      throw new Error('ยังไม่ได้ตั้ง GEMINI_API_KEY ใน .env (คีย์จาก aistudio.google.com/apikey)');
    }
    openaiClient = new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL });
  } else {
    const apiKey = cleanApiKey('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('ยังไม่ได้ตั้ง OPENAI_API_KEY ใน .env (คีย์จาก platform.openai.com)');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

// token ที่ใช้ไปครั้งล่าสุด (ไว้ดูว่าเปลืองตรงไหน — watch.js เอาไปโชว์ได้)
let _lastUsage = null;
export function lastUsage() { return _lastUsage; }

// เนื้อผลค้นเว็บครั้งล่าสุด — ใช้เป็น "แหล่งอ้างอิง" ให้การ์ดกันแต่งตัวเลข
let _lastSources = '';

// ค้นเว็บ: เปิดให้ AI หาข้อมูลสินค้าทั่วไปจากอินเทอร์เน็ตเมื่อไม่มีในโฟลเดอร์ knowledge
// ⚠ คิดเงินแยกต่างหากจาก token (ราว 0.33 บาท/การค้น 1 ครั้ง) — จำกัดด้วย AI_WEB_SEARCH_MAX
// ปิดไว้เป็นค่าเริ่มต้น — คลังสินค้าในเครื่อง (knowledge/products/) ตอบได้เกือบหมดแล้ว
// และถูกกว่าค้นเว็บราว 10 เท่า เปิดเมื่อต้องการความรู้นอกเหนือจากของร้านจริง ๆ
const WEB_SEARCH = (process.env.AI_WEB_SEARCH ?? 'false') === 'true';
const WEB_SEARCH_MAX = Number(process.env.AI_WEB_SEARCH_MAX || 1);

/** รุ่นใหม่ใช้ web_search ตัวที่กรองผลได้ ส่วน haiku/รุ่นเก่ารองรับแค่ตัวพื้นฐาน */
function webSearchType() {
  return /opus-(5|4-[678])|sonnet-(5|4-6)/.test(modelName())
    ? 'web_search_20260209'
    : 'web_search_20250305';
}

/** เรียก LLM ตาม provider ที่เลือก → คืนข้อความล้วน */
async function callLLM({ systemBlocks, messages, maxTokens }) {
  if (PROVIDER === 'openai' || PROVIDER === 'gemini') {
    // ทั้งสองเจ้าใช้รูปแบบ OpenAI: system เป็นข้อความเดียว (แคชให้เองฝั่งผู้ให้บริการ)
    // และบล็อกรูปคนละรูปแบบกับ Anthropic → แปลง image → image_url ก่อนส่ง
    const systemText = systemBlocks.map(b => b.text).join('\n\n');
    const msgs = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(b => (b.type === 'image'
          ? { type: 'image_url', image_url: { url: b.source.url } }
          : { type: 'text', text: b.text }))
        : m.content,
    }));
    const res = await getOpenAICompatible().chat.completions.create({
      model: modelName(),
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemText }, ...msgs],
    });
    // ทางนี้ไม่แยกโทเคนที่แคชไว้ให้ดู มีแต่ยอดรวม → ใส่ใน in/out ตรง ๆ
    const u = res.usage ?? {};
    _lastUsage = {
      in: u.prompt_tokens ?? 0,
      cacheWrite: 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      out: u.completion_tokens ?? 0,
      searches: 0,
    };
    _lastSources = '';
    return (res.choices?.[0]?.message?.content ?? '').trim();
  }
  // Anthropic (Claude): system เป็น array บล็อก (มี cache_control สำหรับ prompt caching)
  const client = getAnthropic();
  const req = { model: modelName(), max_tokens: maxTokens, system: systemBlocks, messages: [...messages] };
  if (WEB_SEARCH) req.tools = [{ type: webSearchType(), name: 'web_search', max_uses: WEB_SEARCH_MAX }];

  const total = { in: 0, cacheWrite: 0, cacheRead: 0, out: 0, searches: 0 };
  const texts = [];
  _lastSources = '';

  // ค้นเว็บทำงานฝั่ง Anthropic แต่ถ้าใช้เวลานานจะหยุดกลางคันด้วย stop_reason: 'pause_turn'
  // ต้องส่งเทิร์นนั้นกลับไปให้ทำต่อ ไม่งั้นได้คำตอบที่ถูกตัดกลางคันแบบเงียบ ๆ
  for (let round = 0; round < 4; round++) {
    const res = await client.messages.create(req);
    const u = res.usage ?? {};
    total.in += u.input_tokens ?? 0;
    total.cacheWrite += u.cache_creation_input_tokens ?? 0;
    total.cacheRead += u.cache_read_input_tokens ?? 0;
    total.out += u.output_tokens ?? 0;
    total.searches += u.server_tool_use?.web_search_requests ?? 0;

    for (const b of res.content ?? []) {
      if (b.type === 'text') texts.push(b.text);
      // โมเดลชอบพิมพ์เกริ่นก่อนค้นเว็บ เช่น "ให้ค้นหาเพื่อตอบชัดเจน" ซึ่งไม่ควรหลุดถึงลูกค้า
      // → เจอการเรียกเครื่องมือเมื่อไหร่ ทิ้งข้อความก่อนหน้าทั้งหมด เอาเฉพาะคำตอบสุดท้าย
      else if (b.type === 'server_tool_use') texts.length = 0;
      // เก็บที่มาของผลค้นหาไว้ให้การ์ดกันแต่งตัวเลขตรวจ
      else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        texts.length = 0;
        for (const r of b.content) _lastSources += ` ${r.title ?? ''} ${r.url ?? ''} ${r.page_age ?? ''}`;
      }
    }

    if (res.stop_reason !== 'pause_turn') break;
    req.messages.push({ role: 'assistant', content: res.content });
  }

  _lastUsage = total;
  return texts.join('').trim();
}

/** โหมด "ให้ Claude Code / คน ตอบผ่านคิวไฟล์" (ไม่เรียก API เสียเงิน) */
export function isInboxMode() {
  return PROVIDER === 'claude-code' || PROVIDER === 'inbox';
}

/** ข้อมูล provider/model ไว้โชว์สถานะ */
export function providerInfo() {
  const model = isInboxMode() ? '(คิวไฟล์ inbox/)' : modelName();
  // _modelWarning ตั้งค่าตอน resolveModel() จึงต้องเรียก modelName() ก่อนอ่าน
  return { provider: PROVIDER, model, warning: _modelWarning ?? undefined };
}

// --------------------------------------------------------- ★ system prompt ★
// แก้บทบาท/กติกาการตอบของบอทได้ที่นี่ (หรือ override ด้วย AI_SYSTEM_PROMPT ใน .env)
//
// คืนเป็น 2 บล็อก เพื่อทำ prompt caching:
//   บล็อก 1 = คงที่ (กติกา + ข้อมูล knowledge) → ใส่ cache_control ให้แคชได้
//   บล็อก 2 = แปรผัน (ชื่อร้าน/ลูกค้า) → ไม่แคช เพราะเปลี่ยนทุกห้อง
// (ส่วนที่คงที่ต้องเป๊ะเหมือนเดิมทุกครั้ง cache ถึงจะโดน — แก้ไฟล์ knowledge เมื่อไหร่ cache รีเซ็ตเอง)

export function buildSystemPrompt({ shopName, platform, buyerName }) {
  const kb = loadKnowledge();

  // ---- บล็อกคงที่ (แคชได้) ----
  let stable;
  if (process.env.AI_SYSTEM_PROMPT) {
    stable = process.env.AI_SYSTEM_PROMPT;
  } else {
    stable = [
      'คุณคือเจ้าหน้าที่แอดมินของร้านค้าออนไลน์ กำลังตอบแชทลูกค้าเอง ไม่ใช่ผู้ช่วยหรือบอท',
      'เขียนให้เหมือนคนพิมพ์ตอบจริง ๆ ภาษาไทย สุภาพ เป็นกันเอง กระชับ',
      'ห้ามบอกว่าตัวเองเป็น AI ห้ามพูดว่า "ทางเราจะให้เจ้าหน้าที่ติดต่อกลับ" ในเรื่องที่ตอบเองได้',
      'พูดแทนร้านว่า "ทางร้าน" หรือ "เรา" ได้เลย',
      '',
      'อ่านบทสนทนาทั้งหมดตั้งแต่ต้นก่อนตอบ อย่าดูแค่ข้อความสุดท้าย',
      'ลูกค้ามักพิมพ์สั้น ๆ ต่อจากเรื่องที่คุยค้างไว้ ต้องเดาความหมายจากบริบทก่อนหน้า เช่น',
      '  พิมพ์ "5*8" หรือ "3.5x5.5" = ขนาดของสินค้าที่คุยกันอยู่ ไม่ใช่ตัวเลขลอย ๆ',
      '  พิมพ์ "เอาอันนี้" "อันไหนดี" "แล้วสีอื่นล่ะ" = หมายถึงสินค้าในการ์ดหรือที่พูดถึงก่อนหน้า',
      '  พิมพ์ตัวเลขเฉย ๆ = จำนวนที่ต้องการ หรือขนาด แล้วแต่เรื่องที่คุยค้างไว้',
      'ถ้าลูกค้าส่งหลายข้อความรวดเดียว ให้ตอบรวมทุกข้อความในคำตอบเดียว อย่าตอบแค่ข้อความสุดท้าย',
      'ถ้าตีความไม่ออกจริง ๆ ให้ถามกลับสั้น ๆ ว่าหมายถึงอะไร อย่าเดาแล้วตอบผิดเรื่อง',
      '',
      'ห้ามตอบซ้ำของเดิม — ดูข้อความที่ร้านตอบไปแล้วในบทสนทนาก่อนเสมอ:',
      '  ถ้าเคยอธิบายเรื่องนั้นไปแล้วและลูกค้ายังถามเรื่องเดิม แปลว่าคำตอบเดิมยังไม่ตรงใจ',
      '  ห้ามพิมพ์ข้อความเดิมซ้ำ ให้เปลี่ยนวิธี เช่น ถามกลับว่าติดตรงไหน หรือให้ข้อมูลมุมใหม่',
      '  ถ้าลูกค้าถามเรื่องใหม่ต่อจากเดิม ให้ตอบเฉพาะส่วนที่ยังไม่ได้ตอบ ไม่ต้องเท้าความทั้งหมด',
      '  ทักทาย "สวัสดีครับ" ใช้เฉพาะข้อความแรกของบทสนทนา ถ้าคุยกันอยู่แล้วไม่ต้องทักซ้ำ',
      '',
      'ส่งการ์ดสินค้าให้ลูกค้าได้ด้วย: ถ้าลูกค้าถามถึงสินค้าตัวใดตัวหนึ่ง และในบรรทัด',
      '[ข้อมูลสินค้าจากคลังของร้าน] มี "รหัสสินค้า" ของตัวนั้น ให้พิมพ์ [[SEND_ITEM:รหัสสินค้า]]',
      'ต่อท้ายคำตอบ ระบบจะส่งการ์ดสินค้าให้ลูกค้ากดสั่งซื้อได้เลย',
      'ใช้ได้เฉพาะรหัสที่ปรากฏในข้อมูลที่ให้มาเท่านั้น ห้ามแต่งรหัสเอง ห้ามส่งเกิน 1 ใบต่อข้อความ',
      'ถ้าลูกค้าถามกว้าง ๆ ยังไม่เจาะจงสินค้า ไม่ต้องส่ง',
      '',
      'รูปแบบ: บรรทัดแรกใส่ธงเดียว แล้วขึ้นบรรทัดใหม่เขียนร่างคำตอบถึงลูกค้า ไม่เกิน 3 ประโยค',
      '  [[AUTO]]  = ตอบจบได้เองในข้อความเดียว ไม่ต้องมีใครตามต่อ — ใช้เป็นค่าเริ่มต้น',
      '              (ทักทาย ข้อมูลสินค้า วิธีสั่งซื้อ เวลาทำการ เงื่อนไขใบกำกับ สถานะออร์เดอร์',
      '               เลขพัสดุ ค่าส่งที่ให้ลูกค้าดูหน้าชำระเงิน และการบอกตรง ๆ ว่าร้านไม่มีข้อมูลนั้น)',
      '  [[STAFF]] = เฉพาะเรื่องที่ต้องให้คนตัดสินใจหรือลงมือทำจริงเท่านั้น ใช้ให้น้อย:',
      '              เคลม · คืนเงิน · คืนสินค้า · ของหาย · ของไม่ครบ · ส่งผิด · สินค้าชำรุด ·',
      '              ยกเลิกออร์เดอร์ · ขอส่วนลด-ต่อรองราคา · ลูกค้าร้องเรียนหรือไม่พอใจ',
      'ถ้าไม่เข้า 10 เรื่องข้างบน ให้ใช้ [[AUTO]] แม้จะไม่มีข้อมูลก็ตาม —',
      'การตอบว่า "เรื่องนี้ทางร้านไม่ได้ระบุไว้ รบกวนดูที่หน้าสินค้า" ก็ถือเป็นคำตอบที่จบแล้ว',
      'ต้องร่างคำตอบให้เสมอทั้งสองแบบ และร่างจะถูกส่งถึงลูกค้าจริงทันที',
      'จึงต้องเขียนเป็นข้อความที่ส่งได้เลย ห้ามเขียนโน้ตถึงเจ้าหน้าที่หรือเว้นช่องให้เติม',
      'ธง STAFF = ส่งร่างนี้เป็น "คำตอบเบื้องต้น" ก่อน แล้วเจ้าหน้าที่จะตามไปตอบต่อ',
      'ร่างของ STAFF ให้ทวนสิ่งที่ลูกค้าถาม + บอกว่ากำลังตรวจสอบ + เจ้าหน้าที่จะติดต่อกลับ',
      'ห้ามรับปากแทนเจ้าหน้าที่ (ห้ามบอกว่าลดให้ได้ เคลมได้ คืนเงินได้ ของมีสต็อก)',
      '',
      'บรรทัด [ทางร้านตอบไปแล้วว่า: ...] = ข้อความที่ร้านส่งแทรกไปหลังลูกค้าพิมพ์',
      'ถ้าเป็นข้อความอัตโนมัติ (ทักทาย ขอให้รอ นอกเวลาทำการ) ให้ตอบคำถามลูกค้าตามปกติ',
      'ถ้าร้านตอบคำถามนั้นครบถ้วนแล้วจริง ๆ ให้ตอบว่า [[SKIP]] อย่างเดียว ไม่ต้องร่างคำตอบ',
      '',
      'ข้อมูล 2 ประเภท แยกให้ขาด:',
      '',
      '(1) เรื่องที่เป็นคำสัญญาของร้าน — ราคา สต็อก ค่าส่ง ระยะเวลาจัดส่ง เวลาทำการ การรับประกัน',
      'เคลม คืนเงิน เงื่อนไขใบกำกับภาษี ส่วนลด',
      'ต้องมาจากข้อมูลร้านด้านล่าง หรือการ์ดสินค้าที่ลูกค้าส่งมาเท่านั้น ห้ามค้นเว็บ ห้ามเดาเด็ดขาด',
      'ไม่มีในข้อมูลร้าน = บอกว่าขอเช็คให้สักครู่ + ใส่ธง [[STAFF]] ห้ามตอบเป็นตัวเลขเอง',
      '',
      '(2) ความรู้ทั่วไปเกี่ยวกับตัวสินค้า — วัสดุคืออะไร ใช้งานยังไง ต่างกันยังไง ดูแลรักษายังไง',
      'ขนาดมาตรฐานของอุปกรณ์ประเภทนั้น เทียบรุ่น',
      'ดูบรรทัด [ข้อมูลสินค้าจากคลังของร้าน] ในบทสนทนาก่อนเสมอ — เป็นข้อมูลจริงของสินค้าตัวที่ลูกค้าถาม',
      'ถ้ามีคำตอบอยู่ในนั้นแล้ว ให้ตอบจากตรงนั้น ห้ามค้นเว็บซ้ำ',
      'ถ้าไม่มีทั้งในคลังและในข้อมูลร้าน และมีเครื่องมือ web_search ให้ค้นก่อนตอบ อย่าตอบจากความจำ',
      'เพราะความจำอาจคลาดเคลื่อน แล้วค่อยเอาผลค้นหามาเรียบเรียงตอบลูกค้า',
      'ต้องพูดในเชิงข้อมูลทั่วไป เช่น "อวนไนลอนโดยทั่วไปจะ..." ห้ามพูดเหมือนเป็นสเปกที่ร้านรับรอง',
      'ถ้าค้นแล้วยังไม่ชัดเจน อย่าเดา ให้ใส่ธง [[STAFF]]',
      '',
      'ห้ามเดาสเปก วัสดุ ขนาด คุณภาพ จากชื่อสินค้าลอย ๆ โดยไม่มีทั้งข้อมูลร้านและผลค้นหา',
      '',
      'การ์ดสินค้า (ข้อความขึ้นต้นว่า [ลูกค้าส่งการ์ดสินค้า]) = ลูกค้าสนใจตัวนั้น แม้ไม่ได้พิมพ์อะไรมา',
      'ห้ามตอบกลาง ๆ ว่าสอบถามด้านใด ให้ทวน ชื่อ+ตัวเลือก+ราคา จากการ์ด แล้วถามต่อว่าต้องการกี่ชิ้น',
      'ส่งการ์ดมาหลายใบ = กำลังเทียบสินค้า ให้พูดถึงทุกใบ',
      '',
      'ห้ามบอกราคาสินค้าเป็นตัวเลขเด็ดขาด แม้ลูกค้าจะถามตรง ๆ ก็ตาม',
      'เพราะราคาที่ลูกค้าแต่ละคนจ่ายจริงไม่เท่ากัน ขึ้นกับส่วนลดและคูปองที่แต่ละคนถืออยู่',
      'ให้ตอบว่าราคาที่แสดงบนหน้าสินค้า/ในตะกร้าของลูกค้าเองคือราคาจริงที่ต้องจ่าย',
      '(ยอดของคำสั่งซื้อที่ลูกค้าสั่งไปแล้ว บอกได้ เพราะเป็นยอดที่จ่ายจริงไปแล้ว)',
      '',
      'รูปที่ลูกค้าส่งมา: ดูรูปแล้วบอกสิ่งที่เห็นจริง ๆ ห้ามเดาสิ่งที่มองไม่ชัด',
      'รูปสินค้า/หน้าจอสินค้า → ทวนว่าเห็นอะไร แล้วถามให้ชัดว่าต้องการสอบถามเรื่องใด',
      'รูปสลิปโอนเงิน ใบเสร็จ หน้าจอคำสั่งซื้อ → อ่านเลข/ยอดในรูปมาทวนได้ แต่ห้ามยืนยันว่าเงินเข้าแล้ว ใส่ธง [[STAFF]]',
      'รูปของเสียหาย ของผิด ของขาด → ทวนสิ่งที่เห็นในรูป ขอเลขคำสั่งซื้อ แล้วใส่ธง [[STAFF]] เสมอ',
      '',
      'บล็อก [ข้อมูลคำสั่งซื้อของลูกค้าคนนี้ ...] = ออร์เดอร์จริงจากระบบหลังร้าน เชื่อถือได้',
      'ลูกค้าถามถึงออร์เดอร์/พัสดุ/สถานะ → ตอบด้วยข้อมูลในบล็อกนั้นตรง ๆ (เลขคำสั่งซื้อ สถานะ สินค้า เลขพัสดุ)',
      'มีหลายออร์เดอร์และลูกค้าไม่ได้ระบุ → ตอบถึงออร์เดอร์ล่าสุด แล้วบอกเลขออร์เดอร์กำกับไว้ด้วยเสมอ',
      'ไม่มีบล็อกนี้ หรือไม่มีออร์เดอร์ตรงกับที่ลูกค้าถาม → อย่าเดา ให้ขอเลขคำสั่งซื้อ + ใส่ธง [[STAFF]]',
      'ห้ามบอกวันที่ของจะถึงเอง (ข้อมูลไม่มี) บอกได้แค่สถานะกับเลขพัสดุที่มีในบล็อก',
      '',
      'ห้ามรับปากว่าจะส่งไฟล์ เอกสาร PDF อีเมล หรือลิงก์ใด ๆ ให้ลูกค้า ถ้าข้อมูลร้านไม่ได้เขียนไว้ว่าส่งแบบนั้น',
      'เรื่องใบกำกับภาษี/ใบเสร็จ ให้ตอบตามข้อมูลร้านแบบเป๊ะ ๆ ห้ามเปลี่ยนวิธีจัดส่งเอกสารเอง',
      '',
      'ข้อความล้วน ห้าม markdown (**ตัวหนา** #) เพราะแชทแสดงเป็นดอกจันตรง ๆ',
      '',
      'ถ้าแพลตฟอร์มคือ shopee: ห้ามใช้คำว่า "ยกเลิก" เด็ดขาด เพราะ Shopee บล็อกข้อความที่มีคำนี้',
      'ทั้งข้อความจะส่งไม่ออกและลูกค้าจะไม่ได้รับอะไรเลย ให้เลี่ยงไปใช้คำที่สื่อความหมายเดียวกัน เช่น',
      '  "ปิดรายการสั่งซื้อ" · "ไม่ดำเนินการต่อ" · "คืนรายการ" · "ขอปิดออร์เดอร์นี้"',
      'เขียนประโยคให้เข้ารูปกับคำที่เลี่ยงตั้งแต่แรก อย่าเขียน "ยกเลิก" แล้วหวังให้ระบบแก้ให้',
      '',
      'ถ้าแพลตฟอร์มคือ lazada: ห้ามพิมพ์เลขยาว ๆ ลงในข้อความ โดยเฉพาะเลขคำสั่งซื้อและเลขพัสดุ',
      'เพราะ Lazada จะเตือนว่าเป็นการแชร์ข้อมูลส่วนตัวในแชท ให้เรียกว่า "คำสั่งซื้อของลูกค้า"',
      'หรือ "รายการที่ลูกค้าแจ้งมา" แทน ลูกค้ารู้เลขของตัวเองอยู่แล้ว ไม่ต้องทวนให้',
      'ห้ามเขียนเป็นข้อ 1. 2. 3. ให้เขียนเป็นประโยคต่อเนื่อง',
      'คำลงท้ายต้องเป็นเพศเดียวกันทุกประโยคในข้อความเดียว ห้ามสลับ ครับ/ค่ะ ไปมา',
      '(ใช้ตามที่ระบุในข้อมูลร้าน ถ้าไม่ระบุให้ใช้ ครับ ทั้งหมด) · เรียกลูกค้าว่า "ลูกค้า" เท่านั้น ห้ามเรียกน้อง/พี่',
      'ขึ้นต้นด้วยคำทักทายให้ครบคำ (สวัสดีครับ) ห้ามขึ้นต้นด้วยคำลงท้ายลอย ๆ',
      'ไม่ต้องมีคำว่า แอดมิน: นำหน้า และไม่ต้องใส่ธงซ้ำในเนื้อความ',
    ].join('\n');
  }
  stable += kb
    ? '\n\n===== ข้อมูลร้าน/สินค้า (ใช้ตอบลูกค้า) =====\n' + kb
    : '\n\n(ยังไม่มีข้อมูลสินค้าในโฟลเดอร์ knowledge/ — คำถามที่ต้องใช้ข้อมูลเฉพาะให้ใส่ธง [[STAFF]])';

  // ---- บล็อกแปรผัน (ไม่แคช) ----
  const volatile = `บริบทห้องแชทนี้ — ร้าน: "${shopName ?? 'ร้านค้า'}" · แพลตฟอร์ม: ${platform ?? '-'} · ลูกค้า: "${buyerName ?? 'ลูกค้า'}"`;

  return [
    { type: 'text', text: stable, cache_control: CACHE_CONTROL },
    { type: 'text', text: volatile },
  ];
}

// ------------------------------------------------------- แปลงข้อความ → dialogue

const CURRENCY_NAME = { THB: 'บาท', USD: 'ดอลลาร์', SGD: 'ดอลลาร์สิงคโปร์', MYR: 'ริงกิต', VND: 'ดอง', IDR: 'รูเปียห์' };

/** "145.00000" → "145"  ·  "132.50000" → "132.50" */
function formatPrice(price, currency) {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price ?? '').trim();
  const num = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${num} ${CURRENCY_NAME[currency] ?? currency ?? ''}`.trim();
}

/**
 * การ์ดสินค้าที่ลูกค้ากดส่งมาจากหน้าร้าน (Shopee/Lazada/TikTok)
 * ลูกค้ามักส่งการ์ดมาเฉย ๆ ไม่พิมพ์อะไร → ต้องกางรายละเอียดให้ AI เห็น ไม่งั้นตอบไม่ถูกว่าถามสินค้าตัวไหน
 */
function renderItemCard(c) {
  const lines = ['[ลูกค้าส่งการ์ดสินค้ามาในแชท — นี่คือสินค้าที่ลูกค้ากำลังสนใจ]'];
  if (c.title)    lines.push(`- ชื่อสินค้า: ${String(c.title).trim()}`);
  if (c.skuValue) lines.push(`- ตัวเลือกที่ลูกค้าเลือก: ${String(c.skuValue).trim()}`);
  // ไม่ส่งราคาให้ AI เห็นเลย — ราคาที่ลูกค้าแต่ละคนจ่ายจริงต่างกันตามส่วนลด/คูปองที่ถืออยู่
  // ถ้าให้เห็นแล้วสั่งห้ามพูด โมเดลก็มักหลุดพูดอยู่ดี ตัดออกตั้งแต่ต้นทางชัวร์กว่า
  if (c.quantity) lines.push(`- จำนวน: ${c.quantity}`);
  if (Number(c.isPreOrder)) lines.push('- เป็นสินค้าพรีออเดอร์');
  if (c.itemId)   lines.push(`- รหัสสินค้า: ${c.itemId}`);
  return lines.length > 1 ? lines.join('\n') : '[ลูกค้าส่งการ์ดสินค้ามา]';
}

/**
 * การ์ดออร์เดอร์ที่ลูกค้ากดส่งมาจากหน้าคำสั่งซื้อ
 * ข้อมูลบนการ์ดมีน้อย (เลขออร์เดอร์ + ชื่อสินค้า) — รายละเอียดจริงมาจาก orderContext
 * ที่ watch.js ดึงจาก Duoke ให้ (ดู renderOrders)
 */
function renderOrderCard(c) {
  const lines = ['[ลูกค้าส่งการ์ดคำสั่งซื้อมาในแชท — ลูกค้ากำลังถามถึงออร์เดอร์นี้]'];
  const id = c.orderId ?? c.orderSn ?? c.orderNumber;
  if (id) lines.push(`- เลขคำสั่งซื้อ: ${id}`);
  if (c.productName ?? c.title) lines.push(`- สินค้า: ${String(c.productName ?? c.title).trim()}`);
  if (c.skuValue) lines.push(`- ตัวเลือก: ${String(c.skuValue).trim()}`);
  if (c.quantity) lines.push(`- จำนวน: ${c.quantity}`);
  if (c.price) lines.push(`- ราคา: ${formatPrice(c.price, c.currency)}`);
  if (c.status) lines.push(`- สถานะบนการ์ด: ${c.status}`);
  return lines.length > 1 ? lines.join('\n') : '[ลูกค้าส่งการ์ดคำสั่งซื้อมา]';
}

/** URL รูปในข้อความ (ถ้าเป็นข้อความชนิดรูป) — ใช้ส่งให้ AI ดูรูปจริง */
export function imageUrlOf(msg) {
  const c = parseMessageContent(msg) || {};
  const t = msg.messageType;
  if (t === 'image' || t === 'file_image' || t === 'attachment_image') {
    return c.imageUrl ?? c.url ?? c.fileUrl ?? null;
  }
  return null;
}

/**
 * แปลง 1 ข้อความ Duoke เป็นข้อความสำหรับป้อน AI (คืน '' ถ้าไม่มีเนื้อความ)
 *
 * ชนิดข้อความจริงที่เจอในระบบ (ดูได้จาก chat.log บรรทัด "↳ raw"):
 *   shopee : text · item · sticker · file_image · unknown (การ์ดสินค้ารุ่นใหม่ ห่อใน unknownData)
 *   tiktok : text · goods_card · order_card · file_image
 *   lazada : 1 = ข้อความ (มี translateTxt) · 10007 = การ์ดคำสั่งซื้อ
 */
function renderForAI(msg) {
  const c = parseMessageContent(msg) || {};
  switch (String(msg.messageType)) {
    case 'text':
    case 'attachment_text':
    case '1': return (c.text ?? '').trim();           // lazada ส่ง type '1'
    case 'image':
    case 'file_image':
    case 'attachment_image': return '[ลูกค้าส่งรูปภาพมา]';   // รูปจริงแนบเป็น image block ให้ AI ดู
    case 'video': return '[ส่งวิดีโอมา]';
    case 'sticker': return '[ส่งสติกเกอร์]';
    case 'item':                                       // shopee
    case 'goods_card':                                 // tiktok
    case 'product': return renderItemCard(c);
    case 'order':
    case 'order_card':                                 // tiktok
    case '10007': return renderOrderCard(c);           // lazada
    case 'file': return `[ส่งไฟล์: ${c.fileName ?? ''}]`;
    case 'unknown': return renderUnknownCard(c);
    default: return (c.text ?? '').trim();
  }
}

/**
 * shopee ส่งการ์ดสินค้ารุ่นใหม่มาเป็น messageType 'unknown' โดยยัด JSON ซ้อนไว้ใน unknownData
 * แกะออกมาให้ AI เห็นว่าลูกค้าถามสินค้าตัวไหน ไม่งั้นจะกลายเป็นข้อความว่าง
 */
function renderUnknownCard(c) {
  try {
    const outer = typeof c.unknownData === 'string' ? JSON.parse(c.unknownData) : c.unknownData;
    const inner = typeof outer?.message === 'string' ? JSON.parse(outer.message) : outer?.message ?? outer;
    const card = inner?.item_card_v2 ?? inner?.item_card ?? {};
    const itemId = inner?.product_id ?? inner?.item_id;
    const name = card.name ?? card.title ?? inner?.name;
    if (!itemId && !name) return '';
    return renderItemCard({
      itemId,
      title: name,
      skuValue: card.model_name ?? card.sku_name,
      // ราคาในการ์ดรุ่นนี้เป็นหน่วยย่อย (x100000) — หารกลับก่อนค่อยโชว์
      price: card.display_price?.discount_price ? Number(card.display_price.discount_price) / 100000 : undefined,
      currency: card.currency ?? 'THB',
    });
  } catch { return ''; }
}

/** ข้อความล้วนจาก content ที่อาจเป็น string หรือ array บล็อก (มีรูปปน) */
const contentText = c => Array.isArray(c)
  ? c.filter(b => b.type === 'text').map(b => b.text).join(' ')
  : String(c ?? '');

/**
 * messages (เก่า→ใหม่) → รูปแบบ Anthropic (ลูกค้า=user, ร้าน=assistant)
 * รูปที่ลูกค้าส่งมาจะแนบเป็น image block ให้ AI ดูรูปจริง (แนบแค่ AI_MAX_IMAGES รูปล่าสุด
 * เพราะรูปหนึ่งกินราว 1,000-1,600 tokens — ย้อนหลังเยอะ ๆ ค่าใช้จ่ายพุ่ง)
 */
function toAnthropicMessages(messages) {
  const recent = (messages || []).slice(-MAX_HISTORY);

  const withImage = new Set();
  if (READ_IMAGES) {
    for (let i = recent.length - 1; i >= 0 && withImage.size < MAX_IMAGES; i--) {
      const m = recent[i];
      if (m.fromAccountType === 1 && imageUrlOf(m)) withImage.add(m.messageId);
    }
  }

  const out = [];
  for (const m of recent) {
    let text = renderForAI(m);
    const img = withImage.has(m.messageId) ? imageUrlOf(m) : null;
    if (!text && !img) continue;
    // ข้อความของร้านที่ยาวเกินไปมักเป็น auto-reply สำเร็จรูป ตัดให้สั้นลง ไม่ต้องป้อนเต็ม ๆ
    if (m.fromAccountType !== 1 && text.length > MAX_MSG_CHARS) {
      text = text.slice(0, MAX_MSG_CHARS) + '…';
    }
    const role = m.fromAccountType === 1 ? 'user' : 'assistant';
    out.push(img
      ? { role, content: [
          { type: 'image', source: { type: 'url', url: img } },
          { type: 'text', text: text || '[ลูกค้าส่งรูปภาพมา]' },
        ] }
      : { role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();   // ต้องเริ่มด้วย user
  return out;
}

// ------------------------------------------------------- คำสั่งซื้อของลูกค้า

// คำที่แปลว่าลูกค้ากำลังถามถึงออร์เดอร์ของตัวเอง → ค่อยไปดึงข้อมูลออร์เดอร์มาให้ AI
const ORDER_WORDS = /ออเดอร์|ออร์เดอร์|order|คำสั่งซื้อ|เลขพัสดุ|เลขแทรค|แทรคกิ้ง|tracking|พัสดุ|ขนส่ง|จัดส่ง|ส่งของ|ส่งยัง|ยังไม่ได้รับ|ไม่ได้ของ|ของยัง|ถึงไหน|สถานะ|ตีกลับ|คืนของ|คืนเงิน|เคลม|ผิดรุ่น|ผิดสี|ของขาด|ไม่ครบ|ใบกำกับ|ใบเสร็จ|ใบเสด|ยกเลิก/i;

/** ข้อความนี้ต้องใช้ข้อมูลออร์เดอร์ประกอบไหม (ข้อความล้วน หรือการ์ดออร์เดอร์) */
export function needsOrderInfo(msg) {
  const t = String(msg?.messageType ?? '');
  if (t === 'order' || t === 'order_card' || t === '10007') return true;
  const c = parseMessageContent(msg) || {};
  return ORDER_WORDS.test(c.text ?? '');
}

const ORDER_STATUS_TH = {
  UNPAID: 'ยังไม่ชำระเงิน', TO_PAY: 'ยังไม่ชำระเงิน',
  READY_TO_SHIP: 'ชำระแล้ว รอร้านจัดส่ง', PROCESSED: 'ร้านเตรียมพัสดุแล้ว',
  RETRY_SHIP: 'รอจัดส่งใหม่', SHIPPED: 'จัดส่งแล้ว ระหว่างขนส่ง',
  TO_CONFIRM_RECEIVE: 'ถึงลูกค้าแล้ว รอกดรับสินค้า',
  COMPLETED: 'สำเร็จแล้ว (ลูกค้ารับสินค้าแล้ว)', DELIVERED: 'ส่งถึงแล้ว',
  CANCELLED: 'ยกเลิกแล้ว', TO_RETURN: 'อยู่ระหว่างคืนสินค้า', RETURNED: 'คืนสินค้าแล้ว',
  IN_CANCEL: 'กำลังขอยกเลิก', INVALID: 'คำสั่งซื้อไม่สมบูรณ์',
};
const orderDate = t => (t ? new Date(t).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: '2-digit' }) : '');

/**
 * ออร์เดอร์จาก Duoke (api.getOrderList) → ข้อความสั้น ๆ ให้ AI ใช้ตอบ
 * เอาเฉพาะช่องที่ลูกค้าถามจริง: เลขออร์เดอร์ สถานะ วันสั่ง ยอด สินค้า+ตัวเลือก+จำนวน เลขพัสดุ
 */
export function formatOrders(orders, max = 3) {
  const list = (orders || []).slice(0, max);
  if (!list.length) return '';
  const out = [];
  for (const o of list) {
    const status = ORDER_STATUS_TH[o.platformOrderStatus] ?? o.platformOrderStatus ?? '-';
    const head = [
      `คำสั่งซื้อ ${o.orderNumber}`,
      `สถานะ: ${status}`,
      o.platformCreateTime ? `สั่งเมื่อ ${orderDate(o.platformCreateTime)}` : '',
      o.amount != null ? `ยอดรวม ${formatPrice(o.amount, o.currency)}` : '',
    ].filter(Boolean).join(' · ');
    out.push(head);
    for (const p of (o.productList || []).slice(0, 5)) {
      out.push(`  - ${String(p.productName ?? '').trim()}` +
        (p.variation || p.variationSku ? ` | ตัวเลือก: ${String(p.variation || p.variationSku).trim()}` : '') +
        (p.quantity ? ` | ${p.quantity} ชิ้น` : ''));
    }
    const lg = o.logistics || {};
    const track = Array.isArray(lg.trackingNumber) ? lg.trackingNumber.filter(Boolean).join(', ') : lg.trackingNumber;
    if (lg.logisticsServiceName || track) {
      out.push(`  ขนส่ง: ${[lg.logisticsServiceName, track ? `เลขพัสดุ ${track}` : ''].filter(Boolean).join(' · ')}`);
    }
  }
  return out.join('\n');
}

/**
 * ข้อความฝั่งร้านนี้ ใครส่ง — ดูจากฟิลด์ที่ Duoke ให้มา แม่นกว่าเดาจากเนื้อข้อความ
 * (สำรวจจากข้อมูลจริง 194 ข้อความ พบรูปแบบนี้)
 *   messageSource=2 + มี account  → คนกดส่งผ่านบัญชีแอดมิน (คนจริง หรือบอทเราที่ล็อกอินบัญชีนั้น)
 *   messageSource=1 หรือ 3 + account=null → บอทของแพลตฟอร์มยิงอัตโนมัติ
 *
 * @param {object} msg  ข้อความจาก getMessageList
 * @param {string} [myUid]  uid ของบัญชีที่บอทเราใช้ (จาก .token.json) — ถ้าให้มาจะแยก 'me' ออกได้
 * @returns {'platform-bot'|'me'|'staff'}
 */
/** ย่อข้อความเป็นบรรทัดเดียวสั้น ๆ สำหรับใส่ใน log */
function oneLineShort(t, max = 40) {
  return String(t ?? '').replace(/s+/g, ' ').trim().slice(0, max);
}

export function shopSenderKind(msg, myUid) {
  const src = Number(msg?.messageSource);
  const acc = msg?.account;
  // ไม่มีชื่อบัญชีกำกับ = ไม่ใช่คนกดส่ง (แพลตฟอร์มยิงเอง)
  if (!acc && (src === 1 || src === 3)) return 'platform-bot';
  if (!acc) return 'platform-bot';
  if (myUid && String(msg?.uid) === String(myUid)) return 'me';
  return 'staff';
}

// ---------------------------------------- คำที่แพลตฟอร์มบล็อกไม่ให้ส่ง
// Shopee ไม่ยอมให้ส่งข้อความที่มีคำว่า "ยกเลิก" — ถ้าหลุดไปคำเดียว ข้อความทั้งอันส่งไม่ออก
// (ลูกค้าจะเงียบไปเลยโดยที่ระบบไม่แจ้ง error) จึงต้องเปลี่ยนคำก่อนส่งทุกครั้ง
// เพิ่ม/แก้เองได้ด้วย AI_WORD_SWAP_<PLATFORM> ใน .env รูปแบบ "คำเดิม=คำใหม่,คำเดิม2=คำใหม่2"
const DEFAULT_WORD_SWAP = {
  shopee: [
    ['ยกเลิกคำสั่งซื้อ', 'ปิดรายการสั่งซื้อ'],
    ['ยกเลิกออร์เดอร์', 'ปิดรายการสั่งซื้อ'],
    ['ยกเลิกออเดอร์', 'ปิดรายการสั่งซื้อ'],
    ['ยกเลิกรายการ', 'ปิดรายการ'],
    ['การยกเลิก', 'การปิดรายการ'],
    ['ขอยกเลิก', 'ขอปิดรายการ'],
    ['ยกเลิก', 'ปิดรายการ'],          // ต้องอยู่ท้ายสุด เพื่อให้คำที่ยาวกว่าถูกแทนก่อน
  ],
};

let _lastSwapped = [];

/** อ่านรายการเปลี่ยนคำของแพลตฟอร์มนั้น (ค่าใน .env เขียนทับค่าเริ่มต้น) */
function wordSwapFor(platform) {
  const p = String(platform ?? '').toLowerCase();
  if (!p) return [];
  const custom = process.env[`AI_WORD_SWAP_${p.toUpperCase()}`];
  if (custom) {
    return custom.split(',').map(pair => {
      const [from, to] = pair.split('=');
      return [String(from ?? '').trim(), String(to ?? '').trim()];
    }).filter(([f]) => f);
  }
  return DEFAULT_WORD_SWAP[p] ?? [];
}

// แพลตฟอร์มที่เตือนเรื่อง "แชร์ข้อมูลส่วนตัวในแชท" เมื่อเจอตัวเลขยาว ๆ
// (Lazada เตือนเมื่อข้อความมีเลขคำสั่งซื้อ 16 หลัก — ระบบมองว่าอาจเป็นเบอร์โทร/ข้อมูลส่วนตัว)
// ลูกค้ารู้เลขออร์เดอร์ของตัวเองอยู่แล้ว และเจ้าหน้าที่เห็นใน Duoke จึงไม่จำเป็นต้องพิมพ์ซ้ำ
const MASK_LONG_DIGITS = { lazada: true };
// เลขล้วนยาว 10 หลักขึ้นไป และต้องไม่มีตัวอักษรติดหน้า/หลัง
// เพื่อไม่ให้ไปโดนเลขพัสดุที่มีตัวอักษรนำอย่าง TH01234567890 หรือ SPX... ซึ่งลูกค้าต้องใช้จริง
const LONG_DIGITS_RE = /(?<![A-Za-z0-9])\d{10,}(?![A-Za-z0-9])/g;

/** เปลี่ยนคำที่แพลตฟอร์มบล็อก + ปิดเลขยาว → คืน { text, swapped: [...] } */
export function sanitizeForPlatform(text, platform) {
  let outText = String(text ?? '');
  const swapped = [];
  for (const [from, to] of wordSwapFor(platform)) {
    if (!from || !outText.includes(from)) continue;
    outText = outText.split(from).join(to);
    swapped.push(`${from}→${to}`);
  }

  const p = String(platform ?? '').toLowerCase();
  const maskEnv = process.env[`AI_MASK_DIGITS_${p.toUpperCase()}`];
  const shouldMask = maskEnv ? maskEnv === 'true' : Boolean(MASK_LONG_DIGITS[p]);
  if (shouldMask) {
    outText = outText.replace(LONG_DIGITS_RE, m => {
      swapped.push(`ปิดเลขยาว(${m.replace(/\D/g, '').length} หลัก)`);
      return 'ที่แจ้งไว้';
    }).replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
  }

  return { text: outText, swapped };
}

// ข้อความสำเร็จรูปที่แพลตฟอร์ม/ร้านยิงอัตโนมัติ — ไม่นับว่า "มีคนตอบแล้ว"
// ใช้เป็นตัวสำรองเมื่อแพลตฟอร์มไม่ส่งฟิลด์ account/messageSource มาให้
// (ชุดเดียวกับที่ learn-replies.js ใช้กรองตอนดูดตัวอย่างคำตอบ)
const CANNED_REPLY_RE = new RegExp([
  'เรียนคุณลูกค้าที่เคารพ', 'นอกเวลาทำการ', 'ได้รับข้อความของ(คุณ|ท่าน)แล้ว',
  'กรุณารอสักครู่', 'รอสักครู่', 'ทีมงานของเรากำลังยุ่ง', 'ยินดีต้อนรับ',
  'มีอะไรให้ช่วยเหลือ', 'สอบถามด้านใด', 'ถามมาได้เลย', 'แจ้งทางร้านได้เลย',
  'ขอบคุณสำหรับความสนใจ', 'ติดตามคำสั่งซื้อ', 'ลูกค้าติดตามร้าน',
  'วันนี้มีอะไรให้เราช่วย', 'has been assigned', 'chat has been',
].join('|'), 'i');

// เรื่องที่ต้องให้เจ้าหน้าที่ตามต่อเสมอ ไม่ว่า AI จะติดธงว่าอะไร
// (haiku ไม่ทำตามกฎใน prompt ทุกครั้ง — บังคับในโค้ดชัวร์กว่า)
// สั้นและเจาะจง เพื่อไม่ให้ดักคำถามทั่วไปจนเจ้าหน้าที่ท่วม
const MUST_STAFF_RE = new RegExp([
  // ★ ส่งของผิด — เรื่องหลักที่ต้องให้คนดู
  'ส่งผิด', 'ส่งมาผิด', 'ได้ผิด', 'ผิดรุ่น', 'ผิดสี', 'ผิดขนาด', 'ผิดแบบ', 'ผิดตัว', 'ไม่ตรงปก',
  'คนละ(รุ่น|สี|ขนาด|แบบ|อัน|ตัว)', 'ไม่ใช่ที่สั่ง', 'ไม่ตรงที่สั่ง',
  // ของขาด/หาย/พัง — ร้านต้องส่งเพิ่มหรือชดเชย
  'ของหาย', 'ไม่ได้รับของ', 'ของไม่ครบ', 'ได้ไม่ครบ', 'ขาดไป', 'ชำรุด', 'แตกหัก', 'ของเสีย',
  // เรื่องเงิน
  'เคลม', 'คืนเงิน', 'คืนสินค้า', 'รีฟัน', 'refund',
  // ลูกค้าไม่พอใจ
  'ร้องเรียน', 'ไม่พอใจ', 'แย่มาก', 'โกง',
].join('|'), 'i');

// ------------------------------------------------- แท็กใบกำกับภาษี / สลิปออนไลน์

// ลูกค้า "ขอ" ใบกำกับ/ใบเสร็จ — ไม่ใช่แค่พูดถึงลอย ๆ
const INVOICE_ASK_RE = /(ใบกำกับ|ใบเสร็จ|ใบเสด|ใบกำกับภาษี|vat|แวท|ภาษี)/i;
const INVOICE_THRESHOLD = Number(process.env.AI_INVOICE_THRESHOLD || 1000);

/**
 * ลูกค้าขอใบกำกับไหม และยอดถึงเกณฑ์ไหม → บอกว่าควรติดแท็กอะไร
 *
 * ยอดเงินยึด "ออร์เดอร์จริงใน Duoke" เท่านั้น ไม่ใช้ตัวเลขที่ลูกค้าพิมพ์
 * (ลูกค้ามักพิมพ์ราคาสินค้าชิ้นเดียว ไม่ใช่ยอดรวมของออร์เดอร์)
 * ไม่มีออร์เดอร์ = ไม่ติดแท็ก (ติดผิดแล้วเจ้าหน้าที่ทำงานผิดตาม เสียหายกว่าไม่ติด)
 *
 * ถ้าลูกค้าส่งการ์ดออร์เดอร์มาด้วย จะยึดออร์เดอร์ใบนั้น ไม่งั้นใช้ใบล่าสุด
 *
 * @returns {{kind:'invoice'|'slip', amount:number, from:string}|null}
 */
export function invoiceTagFor({ messages, orders }) {
  const msgs = messages || [];
  const asked = msgs
    .filter(m => m.fromAccountType === 1)
    .map(m => renderForAI(m))
    .some(t => t && INVOICE_ASK_RE.test(t));
  if (!asked) return null;

  const list = (orders || []).filter(o => Number.isFinite(Number(o?.amount)) && Number(o.amount) > 0);
  if (!list.length) return null;               // ไม่มียอดจากออร์เดอร์ → ไม่เดา

  // ลูกค้าส่งการ์ดออร์เดอร์มา = ระบุใบที่ต้องการชัดเจน ให้ยึดใบนั้น
  const cardIds = msgs
    .filter(m => m.fromAccountType === 1 && /^(order|order_card|10007)$/.test(String(m.messageType)))
    .map(m => String(parseMessageContent(m)?.orderId ?? ''))
    .filter(Boolean);
  const picked = list.find(o => cardIds.includes(String(o.orderId ?? o.orderNumber ?? ''))) ?? list[0];

  const amount = Number(picked.amount);
  return {
    kind: amount >= INVOICE_THRESHOLD ? 'invoice' : 'slip',
    amount,
    from: `ออร์เดอร์ ${picked.orderNumber ?? picked.orderId ?? ''}`.trim(),
  };
}

// ------------------------------------------------------------------ main

/**
 * ให้ AI ตัดสินใจ + สร้างคำตอบ
 *
 * @param {object} p
 * @param {object[]} p.messages   ประวัติข้อความ เรียงเก่า→ใหม่ (จาก getMessageList)
 * @param {string}   [p.shopName]
 * @param {string}   [p.platform]
 * @param {string}   [p.buyerName]
 * @returns {Promise<{reply?:string, needsStaff:boolean, reason?:string, skip?:boolean, unsafe?:boolean}>}
 *   reply      = ร่างคำตอบ (มีเสมอถ้าเป็นข้อความจากลูกค้าจริง)
 *   needsStaff = true ถ้าเคสละเอียดอ่อน ต้องให้เจ้าหน้าที่ตามไปตอบต่อ
 *   skip       = true ถ้าร้านตอบคำถามนี้ไปแล้ว — ห้ามส่งอะไรซ้ำ
 *   unsafe     = true ถ้าร่างมีข้อมูลที่ยืนยันไม่ได้ — ห้ามส่งร่างนี้ ให้ส่ง holdingMessage() แทน
 */
// ข้อความรับคำ/ขอบคุณ/สติกเกอร์ ที่ไม่ได้ถามอะไร — ไม่ต้องเรียก AI ให้เปลืองเงิน
// เงื่อนไขเข้มไว้ก่อน: ต้องสั้นมาก ไม่มีเครื่องหมายคำถาม ไม่มีตัวเลข และตรงกับรายการนี้เท่านั้น
const SMALLTALK_RE = /^(ครับ|ค่ะ|คะ|จ้า|จ้าา|โอเค|โอเคครับ|โอเคค่ะ|ok|okay|ได้ครับ|ได้ค่ะ|ขอบคุณ|ขอบคุณครับ|ขอบคุณค่ะ|ขอบคุณมากครับ|ขอบคุณมากค่ะ|thanks|thank you|ไม่เป็นไร|ไม่เป็นไรครับ|ไม่เป็นไรค่ะ|รับทราบ|รับทราบครับ|รับทราบค่ะ|\[ส่งสติกเกอร์\])[\s.!ๆๆ๐-๙]*$/i;
const SKIP_SMALLTALK = (process.env.AI_SKIP_SMALLTALK ?? 'true') !== 'false';

/** ข้อความนี้เป็นแค่คำรับ/ขอบคุณ ไม่ต้องให้ AI ร่างคำตอบไหม */
function isSmallTalk(text) {
  const t = String(text ?? '').trim().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  if (!t) return true;                       // ส่งมาแต่อิโมจิ
  if (t.length > 25 || /[?？]/.test(t)) return false;
  return SMALLTALK_RE.test(t);
}

/**
 * เลือกข้อมูลสินค้าที่เกี่ยวกับคำถามนี้จากคลังในเครื่อง
 *   1) ลูกค้าส่งการ์ดสินค้ามา → เปิดไฟล์ตาม itemId ตรง ๆ (แม่นที่สุด ไม่ต้องเดา)
 *   2) ไม่มีการ์ด → ค้นชื่อจาก catalog.tsv ด้วยข้อความล่าสุดของลูกค้า
 * คืน '' ถ้าไม่เจออะไรเลย (ปล่อยให้ค้นเว็บ/ส่งเจ้าหน้าที่ต่อไป)
 */
function buildProductContext(rawMessages, dialogue) {
  const ids = [];
  for (const m of rawMessages) {
    if (m.messageType !== 'item' && m.messageType !== 'product') continue;
    const id = parseMessageContent(m)?.itemId;
    if (id && !ids.includes(String(id))) ids.push(String(id));
  }

  const parts = [];

  // ไฟล์หัวข้อ (ตารางจำนวนบรรจุ ฯลฯ) — ดูจากทุกข้อความของลูกค้าในห้อง ไม่ใช่แค่ข้อความล่าสุด
  // เพราะลูกค้ามักถามชื่อสินค้าก่อน แล้วค่อยถามต่อว่า "ขนาด 6x11 กี่ใบ"
  const askText = dialogue.filter(d => d.role === 'user').map(d => contentText(d.content)).join(' ');
  const topic = matchTopics(askText);
  if (topic) parts.push(topic);

  if (ids.length) {
    for (const id of ids.slice(-MAX_DETAIL_FILES)) {
      const detail = loadProductDetail(id);
      if (detail) parts.push(detail);
    }
    if (parts.length) return parts.join('\n\n---\n\n');
  }

  // ไม่มีการ์ด (หรือการ์ดไม่มีไฟล์) → ค้นจากข้อความล่าสุดของลูกค้า
  const lastAsk = contentText(dialogue[dialogue.length - 1]?.content ?? '');
  const joined = () => parts.join('\n\n');
  if (/^\[/.test(lastAsk)) return joined();      // เป็นบันทึกบริบท ไม่ใช่คำถามลูกค้า
  // เคสร้องเรียน/ปัญหาออร์เดอร์ ไม่ได้ถามหาสินค้า — ค้นไปก็ได้ของไม่เกี่ยว
  // (เช่น "ไม่ได้รับของ" ไปตรงกับ "ตะปู…ได้รับ" เปลืองโทเคนเปล่าและอาจทำให้ตอบหลุดประเด็น)
  if (/ไม่ได้รับ|ยังไม่ได้|ยังไม่ถึง|ของหาย|เคลม|คืนเงิน|คืนสินค้า|ส่งผิด|ชำรุด|แตกหัก|พัสดุ|ยกเลิก|refund/i.test(lastAsk)) return joined();

  const hits = searchProducts(lastAsk, 5);
  if (!hits.length) return joined();

  const detail = loadProductDetail(hits[0].id);
  if (detail) parts.push(detail);
  if (hits.length > 1) {
    parts.push('รายการอื่นในร้านที่ชื่อใกล้เคียง (ยังไม่มีรายละเอียด ถ้าลูกค้าสนใจตัวไหนให้ถามกลับ):\n'
      + hits.slice(1).map(h => `- ${h.name}${h.opts ? ` · ตัวเลือก: ${h.opts}` : ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

export async function generateReply({ messages, shopName, platform, buyerName, orderContext, myUid }) {
  const dialogue = toAnthropicMessages(messages || []);
  if (!dialogue.length) return askBack('ไม่มีข้อความให้ตอบ');

  // Shopee/TikTok ยิงข้อความ auto-reply ของร้านทันทีหลังลูกค้าพิมพ์ ทำให้ข้อความท้ายสุด
  // กลายเป็นของร้าน (ทั้งที่ลูกค้าเพิ่งถาม) — เดิมบอทจะข้ามทิ้งทั้งห้อง
  // แก้เป็น: ย้ายข้อความท้ายของร้านมาเป็นบันทึกบริบท ให้บทสนทนาจบด้วยฝั่งลูกค้า
  // (Claude รุ่นใหม่ไม่รับ prefill — ห้ามให้ messages จบด้วย role assistant)
  const trailingShop = [];
  while (dialogue.length && dialogue[dialogue.length - 1].role !== 'user') {
    trailingShop.unshift(contentText(dialogue.pop().content));
  }
  if (!dialogue.length) return askBack('ไม่มีข้อความของลูกค้า');

  // ข้อความของร้านที่มาหลังคำถามล่าสุดของลูกค้า มี 2 แบบ
  //   1. auto-reply สำเร็จรูปของแพลตฟอร์ม ("รอสักครู่" "นอกเวลาทำการ") → ยังต้องตอบ
  //   2. คำตอบจริงที่คนพิมพ์เอง (หรือบอทตอบไปแล้ว)                    → ห้ามตอบซ้ำ
  // เดิมปล่อยให้ AI ตัดสินด้วยธง [[SKIP]] ซึ่งพลาดบ่อย จึงเช็คในโค้ดแทน
  // เช็คจากฟิลด์ของ Duoke ก่อน (แม่นกว่า) — เอาข้อความฝั่งร้านที่มาหลังคำถามล่าสุดของลูกค้า
  const rawMsgs = messages || [];
  const rawTrailing = [];
  for (let i = rawMsgs.length - 1; i >= 0; i--) {
    if (rawMsgs[i].fromAccountType === 1) break;
    rawTrailing.unshift(rawMsgs[i]);
  }
  const byHuman = rawTrailing.find(m => {
    const kind = shopSenderKind(m, myUid);
    if (kind === 'platform-bot') return false;          // บอทแพลตฟอร์ม → ยังต้องตอบ
    return (renderForAI(m) || '').length >= 5;          // คนหรือบอทเราตอบไปแล้ว → ห้ามตอบซ้ำ
  });
  if (byHuman) {
    const who = shopSenderKind(byHuman, myUid) === 'me' ? 'บอทตอบไปแล้ว' : `${byHuman.account} ตอบไปแล้ว`;
    _lastUsage = { in: 0, cacheWrite: 0, cacheRead: 0, out: 0, searches: 0 };   // ไม่ได้เรียก AI
    return { needsStaff: false, skip: true, reason: `${who}: ${oneLineShort(renderForAI(byHuman))}` };
  }

  // สำรอง: แพลตฟอร์มบางเจ้าไม่ส่ง account/messageSource มา → เดาจากเนื้อข้อความแบบเดิม
  const realReply = rawTrailing.length === 0
    ? null
    : trailingShop.find(t => t && t.length >= 12 && !CANNED_REPLY_RE.test(t)
        && rawTrailing.every(m => m.account === undefined));
  if (realReply) {
    _lastUsage = { in: 0, cacheWrite: 0, cacheRead: 0, out: 0, searches: 0 };
    return { needsStaff: false, skip: true, reason: 'มีคนตอบไปแล้ว: ' + realReply.slice(0, 40) };
  }

  if (trailingShop.length) {
    dialogue.push({ role: 'user', content: `[ทางร้านตอบไปแล้วว่า: ${trailingShop.join(' / ')}]` });
  }

  // ออร์เดอร์จริงของลูกค้าคนนี้ (watch.js ดึงจาก Duoke มาให้ตอนลูกค้าถามเรื่องออร์เดอร์)
  // ใส่เป็นข้อความในบทสนทนา ไม่ใช่ system — เพื่อให้ตัวเลขในนั้น (เลขพัสดุ/ยอด) ผ่านการ์ดกันแต่งตัวเลข
  if (orderContext) {
    dialogue.push({
      role: 'user',
      content: '[ข้อมูลคำสั่งซื้อของลูกค้าคนนี้ จากระบบหลังร้าน — เป็นข้อมูลจริง ใช้ตอบได้เลย ' +
        'ลูกค้าไม่เห็นข้อความนี้ ให้ตอบเป็นภาษาพูดปกติ]\n' + orderContext,
    });
  }

  // ลูกค้าพิมพ์แค่ "ครับ" / "ขอบคุณค่ะ" / สติกเกอร์ → ไม่ต้องเรียก AI (ประหยัดเต็ม 100%)
  if (SKIP_SMALLTALK && !orderContext) {
    const last = contentText(dialogue[dialogue.length - 1]?.content ?? '');
    // ยกเว้นเฉพาะบันทึกบริบทที่โค้ดใส่เอง ส่วน [ส่งสติกเกอร์] ถือเป็นข้อความลูกค้าจริง
    if (!/^\[(ทางร้าน|ข้อมูล)/.test(last) && isSmallTalk(last)) {
      _lastUsage = { in: 0, cacheWrite: 0, cacheRead: 0, out: 0, searches: 0 };
      // skip:true = ห้ามส่งข้อความตอบเบื้องต้น และห้ามติดแท็กรอเจ้าหน้าที่
      return { needsStaff: false, skip: true, reason: 'เป็นคำรับ/ขอบคุณ ไม่ต้องตอบ (ไม่ได้เรียก AI)' };
    }
  }

  // ข้อมูลสินค้าจากคลังในเครื่อง — ถูกกว่าค้นเว็บหลายสิบเท่าและเป็นของร้านจริง
  const productInfo = buildProductContext(messages || [], dialogue);
  if (productInfo) {
    dialogue.push({
      role: 'user',
      content: '[ข้อมูลสินค้าจากคลังของร้าน — เป็นข้อมูลจริง ใช้ตอบได้เลย ' +
        'ลูกค้าไม่เห็นข้อความนี้ ให้ตอบเป็นภาษาพูดปกติ ' +
        'ถ้ารายการที่เจอไม่ตรงกับที่ลูกค้าถาม อย่าเดา ให้บอกว่าขอเช็คให้]\n' + productInfo,
    });
  }

  const systemBlocks = buildSystemPrompt({ shopName, platform, buyerName });
  let text;
  try {
    text = await callLLM({ systemBlocks, messages: dialogue, maxTokens: MAX_TOKENS });
  } catch (err) {
    // รูปที่แนบไปอาจโหลดไม่ได้ (ลิงก์หมดอายุ/ชนิดไฟล์ไม่รองรับ/โมเดลอ่านรูปไม่ได้)
    // → ลองใหม่แบบข้อความล้วน ดีกว่าปล่อยลูกค้าเงียบเพราะรูปเดียว
    if (!dialogue.some(d => Array.isArray(d.content))) throw err;
    const textOnly = dialogue.map(d => ({
      role: d.role,
      content: contentText(d.content) || '[ลูกค้าส่งรูปภาพมา แต่ระบบเปิดรูปไม่ได้]',
    }));
    text = await callLLM({ systemBlocks, messages: textOnly, maxTokens: MAX_TOKENS });
  }

  if (!text) return askBack('AI ไม่ได้ร่างคำตอบ');

  // แกะธงบรรทัดแรก แล้วตัดออกจากเนื้อความ (ค่าเริ่มต้น = STAFF เพื่อความปลอดภัย)
  const m = MARK_RE.exec(text);
  const flag = m ? m[1].toUpperCase() : 'STAFF';
  if (flag === 'SKIP') return { needsStaff: false, skip: true, reason: 'ร้านตอบคำถามนี้ไปแล้ว' };
  // แกะคำสั่งส่งการ์ดสินค้าออกจากเนื้อความ แล้วตรวจว่ารหัสมีอยู่จริงในคลัง
  const sendMatch = SEND_ITEM_RE.exec(text);
  let sendItemId = null;
  if (sendMatch) {
    const id = sendMatch[1];
    if (loadProductDetail(id) || loadCatalog().some(r => r.id === id)) sendItemId = id;
  }

  const drafted = text.replace(MARK_RE, '').replace(SEND_ITEM_RE, '').trim();
  if (!drafted) return askBack('AI ไม่ได้ร่างคำตอบ');

  // เปลี่ยนคำที่แพลตฟอร์มบล็อก (เช่น "ยกเลิก" บน Shopee) ก่อนใช้ต่อทุกทาง
  // ทำที่นี่จุดเดียว เพื่อให้ทั้งที่ log และที่ส่งจริงเป็นข้อความเดียวกัน
  const { text: reply, swapped } = sanitizeForPlatform(drafted, platform);
  _lastSwapped = swapped;

  // การ์ดกันแต่งตัวเลข — ทดสอบแล้วทั้ง haiku และ sonnet ยังแต่ง "ส่งภายใน 2-3 วัน" เองได้
  // แม้สั่งห้ามใน prompt แล้ว (ความรู้ทั่วไปของโมเดลแรงกว่าคำสั่ง)
  // กติกา: ตัวเลขทุกตัวในคำตอบต้องปรากฏใน knowledge หรือในบทสนทนา ไม่งั้นบังคับให้เจ้าหน้าที่ตรวจ
  // ตัวเลขที่มาจากผลค้นเว็บถือว่ามีที่มา ไม่นับเป็นการแต่งขึ้นเอง
  const known = loadKnowledge() + '\n' + _lastSources + '\n'
    + dialogue.map(d => contentText(d.content)).join('\n');
  // เทียบ "ทั้งตัวเลข" ไม่ใช่ substring — ไม่งั้นเลข 1/2/3 จะไปเจอใน "7-14" หรือ "2.5" ได้หมด
  // แล้วคำตอบที่แต่งขึ้น เช่น "ส่ง 1-2 วัน" จะหลุดผ่านทั้งที่ข้อมูลร้านไม่มีเขียนไว้
  // จุดทศนิยมนับรวมในตัวเลข ส่วนคอมมาไม่นับ (ไม่งั้น "1.5,1.7,2.0" จะกลายเป็นก้อนเดียว)
  // ฝั่งข้อมูลเก็บทั้งแบบมีคอมมาและตัดคอมมา เพื่อให้ "3,200" จับคู่กับ "3200" ได้
  const NUM_RE = /\d+(?:\.\d+)?/g;
  const knownNums = new Set([
    ...(known.match(NUM_RE) ?? []),
    ...(known.replace(/,/g, '').match(NUM_RE) ?? []),
  ]);
  // เลขที่ตามด้วยคำนับโครงสร้างประโยค ("2 วิธี", "3 ข้อ") ไม่ใช่ข้อมูลร้าน ไม่ต้องตรวจ
  const cleanReply = reply.replace(/,/g, '')
    .replace(/\d+\s*(วิธี|แบบ|อย่าง|ข้อ|ประการ|ช่องทาง|ทางเลือก|ขั้นตอน)/g, '')
    .replace(/(วิธี|แบบ|อย่าง|ข้อ|ขั้นตอน|ทาง)\s*ที่\s*\d+/g, '');
  const invented = [...new Set(cleanReply.match(NUM_RE) ?? [])]
    .filter(n => !knownNums.has(n));
  if (invented.length) {
    return { reply, needsStaff: true, unsafe: true, reason: `มีตัวเลขที่ไม่มีในข้อมูล: ${invented.join(', ')}` };
  }

  // เรื่องเงิน/ของเสีย/ร้องเรียน ต้องมีคนตามต่อเสมอ แม้ AI จะบอกว่าตอบจบเองได้
  // ดูเฉพาะสิ่งที่ลูกค้าพิมพ์จริง ไม่รวมบริบทที่โค้ดแทรกเข้าไป (ขึ้นต้นด้วย [)
  // ไม่งั้นชื่อสินค้าอย่าง "กาวตราช้าง 1แถม1" จะไปตรงกับคำว่า "แถม" แล้วเด้งหาเจ้าหน้าที่
  const buyerSaid = dialogue
    .filter(d => d.role === 'user')
    .map(d => contentText(d.content))
    .filter(t => !/^\s*\[/.test(t))
    .join(' ');
  if (MUST_STAFF_RE.test(buyerSaid)) {
    return { reply, sendItemId, swapped: _lastSwapped, needsStaff: true, reason: 'เรื่องที่ต้องให้เจ้าหน้าที่ตามต่อ' };
  }

  return { reply, sendItemId, swapped: _lastSwapped, needsStaff: flag === 'STAFF' };
}

export default { isEnabled, autoSend, generateReply };
