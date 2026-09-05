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
 * รองรับ 2 เจ้า เลือกด้วย AI_PROVIDER ใน .env:
 *   anthropic (ค่าเริ่มต้น) → Claude   · ใช้ ANTHROPIC_API_KEY · โมเดลเริ่มต้น claude-haiku-4-5
 *   openai                  → GPT      · ใช้ OPENAI_API_KEY    · โมเดลเริ่มต้น gpt-4o-mini
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
//   [[AUTO]]  = คำถามพื้น ๆ ตอบได้เองมั่นใจ (ตอบจริงได้ / ติดแท็ก "AI ตอบ")
//   [[STAFF]] = เคสละเอียดอ่อน/ไม่มั่นใจ — ร่างไว้ให้ แต่ต้องให้เจ้าหน้าที่ตรวจก่อน (ติดแท็ก "รอเจ้าหน้าที่")
//   [[SKIP]]  = ร้านตอบคำถามนั้นครบไปแล้ว ไม่ต้องตอบซ้ำ
const MARK_RE = /\[\[\s*(AUTO|STAFF|SKIP)\s*\]\]/i;

// เลือกเจ้าของ AI: 'anthropic' (Claude, ค่าเริ่มต้น) หรือ 'openai' (GPT)
const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 1024);

/** โมเดลที่ใช้ — ตั้ง AI_MODEL เองได้ ไม่งั้นใช้ตัวเล็ก/ถูกของแต่ละเจ้า */
function modelName() {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  return PROVIDER === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5';
}
const MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 10);   // กี่ข้อความล่าสุดที่ป้อนให้ AI
// ข้อความยาวเกินนี้จะตัดท้ายทิ้ง — กันข้อความ auto-reply ยาว ๆ ของร้าน (100-200 tokens/ข้อความ) กินโควตา
const MAX_MSG_CHARS = Number(process.env.AI_MAX_MSG_CHARS || 220);

// prompt caching: แคชบล็อกกติกา+knowledge ไว้ อ่านซ้ำถูกลง 10 เท่า
//   '5m' (ค่าเริ่มต้น) = ค่าเขียน 1.25 เท่า · '1h' = ค่าเขียน 2 เท่า แต่แคชอยู่ได้ 1 ชั่วโมง
//   ⚠ แต่ละโมเดลมีขั้นต่ำที่แคชได้ ถ้า prompt สั้นกว่านั้นจะไม่แคชเงียบ ๆ (ไม่มี error):
//     claude-haiku-4-5 = 4096 tokens · claude-sonnet-5 = 1024 · claude-opus-5 = 512
//   เช็คว่าแคชติดไหมดูที่ lastUsage().cacheRead — ถ้าเป็น 0 ตลอด แปลว่าไม่ติด
const CACHE_TTL = process.env.AI_CACHE_TTL || '5m';
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

function getOpenAI() {
  if (!openaiClient) {
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

/** เรียก LLM ตาม provider ที่เลือก → คืนข้อความล้วน */
async function callLLM({ systemBlocks, messages, maxTokens }) {
  if (PROVIDER === 'openai') {
    // OpenAI: system เป็นข้อความเดียว (แคชอัตโนมัติฝั่ง OpenAI ไม่ต้องใส่ cache_control)
    const systemText = systemBlocks.map(b => b.text).join('\n\n');
    const res = await getOpenAI().chat.completions.create({
      model: modelName(),
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemText }, ...messages],
    });
    return (res.choices?.[0]?.message?.content ?? '').trim();
  }
  // Anthropic (Claude): system เป็น array บล็อก (มี cache_control สำหรับ prompt caching)
  const res = await getAnthropic().messages.create({
    model: modelName(),
    max_tokens: maxTokens,
    system: systemBlocks,
    messages,
  });
  const u = res.usage ?? {};
  _lastUsage = {
    in: u.input_tokens ?? 0,               // ไม่ได้แคช (คิดราคาเต็ม)
    cacheWrite: u.cache_creation_input_tokens ?? 0,  // เขียนแคช (1.25 เท่า)
    cacheRead: u.cache_read_input_tokens ?? 0,       // อ่านจากแคช (0.1 เท่า)
    out: u.output_tokens ?? 0,
  };
  return (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

/** โหมด "ให้ Claude Code / คน ตอบผ่านคิวไฟล์" (ไม่เรียก API เสียเงิน) */
export function isInboxMode() {
  return PROVIDER === 'claude-code' || PROVIDER === 'inbox';
}

/** ข้อมูล provider/model ไว้โชว์สถานะ */
export function providerInfo() {
  return { provider: PROVIDER, model: isInboxMode() ? '(คิวไฟล์ inbox/)' : modelName() };
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
      'คุณเป็นผู้ช่วยตอบแชทลูกค้าของร้านค้าออนไลน์ ตอบภาษาไทย สุภาพ เป็นกันเอง',
      '',
      'รูปแบบ: บรรทัดแรกใส่ธงเดียว แล้วขึ้นบรรทัดใหม่เขียนร่างคำตอบถึงลูกค้า ไม่เกิน 3 ประโยค',
      '  [[AUTO]]  = มีข้อมูลตอบได้ชัด (ทักทาย วิธีสั่งซื้อ เวลาทำการ ข้อมูลที่มีในข้อมูลร้าน ราคาบนการ์ด)',
      '  [[STAFF]] = ไม่มีข้อมูล หรือเคสละเอียดอ่อน (ต่อรอง เคลม คืนเงิน ปัญหาจัดส่ง สต็อก สเปกที่ไม่มีในข้อมูล)',
      'ต้องร่างคำตอบให้เสมอทั้งสองแบบ ธง STAFF แค่แปลว่าให้เจ้าหน้าที่ตรวจก่อนส่ง',
      '',
      'บรรทัด [ทางร้านตอบไปแล้วว่า: ...] = ข้อความที่ร้านส่งแทรกไปหลังลูกค้าพิมพ์',
      'ถ้าเป็นข้อความอัตโนมัติ (ทักทาย ขอให้รอ นอกเวลาทำการ) ให้ตอบคำถามลูกค้าตามปกติ',
      'ถ้าร้านตอบคำถามนั้นครบถ้วนแล้วจริง ๆ ให้ตอบว่า [[SKIP]] อย่างเดียว ไม่ต้องร่างคำตอบ',
      '',
      'ห้ามแต่งข้อมูล ทุกข้อเท็จจริงต้องมาจากข้อมูลร้านด้านล่าง หรือจากการ์ดสินค้าที่ลูกค้าส่งมาเท่านั้น',
      'ห้ามเดาสเปก วัสดุ ขนาด วิธีใช้ คุณภาพ จากชื่อสินค้า (ห้ามเขียนว่าแข็งแรงทนทาน ถ้าข้อมูลไม่ได้เขียนไว้)',
      'ห้ามระบุตัวเลขที่ไม่มีในข้อมูลร้านเด็ดขาด โดยเฉพาะ ระยะเวลาจัดส่ง ค่าส่ง ราคา สต็อก เวลาทำการ',
      'ระยะเวลารับประกัน (ห้ามเดาว่า "ส่งภายใน 2-3 วัน" ถ้าข้อมูลร้านไม่ได้เขียนไว้)',
      'ไม่มีข้อมูล = ทวนเท่าที่รู้ + ขอเช็คให้สักครู่ + ใส่ธง [[STAFF]]',
      '',
      'การ์ดสินค้า (ข้อความขึ้นต้นว่า [ลูกค้าส่งการ์ดสินค้า]) = ลูกค้าสนใจตัวนั้น แม้ไม่ได้พิมพ์อะไรมา',
      'ห้ามตอบกลาง ๆ ว่าสอบถามด้านใด ให้ทวน ชื่อ+ตัวเลือก+ราคา จากการ์ด แล้วถามต่อว่าต้องการกี่ชิ้น',
      'ราคาบนการ์ดคือราคาจริงบนหน้าร้าน ใช้ยืนยันได้ · หลายใบ = กำลังเทียบ ให้พูดถึงทุกใบ',
      '',
      'ข้อความล้วน ห้าม markdown (**ตัวหนา** #) เพราะแชทแสดงเป็นดอกจันตรง ๆ',
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
  if (c.price)    lines.push(`- ราคาบนการ์ด: ${formatPrice(c.price, c.currency)}`);
  if (c.quantity) lines.push(`- จำนวน: ${c.quantity}`);
  if (Number(c.isPreOrder)) lines.push('- เป็นสินค้าพรีออเดอร์');
  if (c.itemId)   lines.push(`- รหัสสินค้า: ${c.itemId}`);
  return lines.length > 1 ? lines.join('\n') : '[ลูกค้าส่งการ์ดสินค้ามา]';
}

/** แปลง 1 ข้อความ Duoke เป็นข้อความสำหรับป้อน AI (คืน '' ถ้าไม่มีเนื้อความ) */
function renderForAI(msg) {
  const c = parseMessageContent(msg) || {};
  switch (msg.messageType) {
    case 'text':
    case 'attachment_text': return (c.text ?? '').trim();
    case 'image': return '[ลูกค้าส่งรูปภาพมา]';
    case 'video': return '[ส่งวิดีโอมา]';
    case 'sticker': return '[ส่งสติกเกอร์]';
    case 'item':                              // shopee ใช้ 'item'
    case 'product': return renderItemCard(c);  // เผื่อแพลตฟอร์มอื่นใช้ 'product'
    case 'order': return '[ส่งการ์ดออร์เดอร์มา]';
    case 'file': return `[ส่งไฟล์: ${c.fileName ?? ''}]`;
    default: return (c.text ?? '').trim();
  }
}

/** messages (เก่า→ใหม่) → รูปแบบ Anthropic (ลูกค้า=user, ร้าน=assistant) */
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages.slice(-MAX_HISTORY)) {
    let text = renderForAI(m);
    if (!text) continue;
    // ข้อความของร้านที่ยาวเกินไปมักเป็น auto-reply สำเร็จรูป ตัดให้สั้นลง ไม่ต้องป้อนเต็ม ๆ
    if (m.fromAccountType !== 1 && text.length > MAX_MSG_CHARS) {
      text = text.slice(0, MAX_MSG_CHARS) + '…';
    }
    out.push({ role: m.fromAccountType === 1 ? 'user' : 'assistant', content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();   // ต้องเริ่มด้วย user
  return out;
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
 * @returns {Promise<{reply?:string, needsStaff:boolean, reason?:string}>}
 *   reply      = ร่างคำตอบ (มีเสมอถ้าเป็นข้อความจากลูกค้าจริง)
 *   needsStaff = true ถ้าเคสละเอียดอ่อน ต้องให้เจ้าหน้าที่ตรวจก่อนตอบ
 */
export async function generateReply({ messages, shopName, platform, buyerName }) {
  const dialogue = toAnthropicMessages(messages || []);
  if (!dialogue.length) return { needsStaff: true, reason: 'ไม่มีข้อความให้ตอบ' };

  // Shopee/TikTok ยิงข้อความ auto-reply ของร้านทันทีหลังลูกค้าพิมพ์ ทำให้ข้อความท้ายสุด
  // กลายเป็นของร้าน (ทั้งที่ลูกค้าเพิ่งถาม) — เดิมบอทจะข้ามทิ้งทั้งห้อง
  // แก้เป็น: ย้ายข้อความท้ายของร้านมาเป็นบันทึกบริบท ให้บทสนทนาจบด้วยฝั่งลูกค้า
  // (Claude รุ่นใหม่ไม่รับ prefill — ห้ามให้ messages จบด้วย role assistant)
  const trailingShop = [];
  while (dialogue.length && dialogue[dialogue.length - 1].role !== 'user') {
    trailingShop.unshift(dialogue.pop().content);
  }
  if (!dialogue.length) return { needsStaff: true, reason: 'ไม่มีข้อความของลูกค้า' };
  if (trailingShop.length) {
    dialogue.push({ role: 'user', content: `[ทางร้านตอบไปแล้วว่า: ${trailingShop.join(' / ')}]` });
  }

  const text = await callLLM({
    systemBlocks: buildSystemPrompt({ shopName, platform, buyerName }),
    messages: dialogue,
    maxTokens: MAX_TOKENS,
  });

  if (!text) return { needsStaff: true, reason: 'AI ไม่ได้ร่างคำตอบ' };

  // แกะธงบรรทัดแรก แล้วตัดออกจากเนื้อความ (ค่าเริ่มต้น = STAFF เพื่อความปลอดภัย)
  const m = MARK_RE.exec(text);
  const flag = m ? m[1].toUpperCase() : 'STAFF';
  if (flag === 'SKIP') return { needsStaff: false, reason: 'ร้านตอบคำถามนี้ไปแล้ว' };
  const reply = text.replace(MARK_RE, '').trim();
  if (!reply) return { needsStaff: true, reason: 'AI ไม่ได้ร่างคำตอบ' };

  // การ์ดกันแต่งตัวเลข — ทดสอบแล้วทั้ง haiku และ sonnet ยังแต่ง "ส่งภายใน 2-3 วัน" เองได้
  // แม้สั่งห้ามใน prompt แล้ว (ความรู้ทั่วไปของโมเดลแรงกว่าคำสั่ง)
  // กติกา: ตัวเลขทุกตัวในคำตอบต้องปรากฏใน knowledge หรือในบทสนทนา ไม่งั้นบังคับให้เจ้าหน้าที่ตรวจ
  const known = loadKnowledge() + '\n' + dialogue.map(d => d.content).join('\n');
  const invented = [...new Set((reply.match(/\d+/g) ?? []).filter(n => !known.includes(n)))];
  if (invented.length) {
    return { reply, needsStaff: true, reason: `มีตัวเลขที่ไม่มีในข้อมูล: ${invented.join(', ')}` };
  }

  return { reply, needsStaff: flag === 'STAFF' };
}

export default { isEnabled, autoSend, generateReply };
