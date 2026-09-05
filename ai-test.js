/**
 * ai-test.js — ลองคุยกับ AI ตรง ๆ โดยไม่ต้องต่อ Duoke
 *
 * ใช้ทดสอบว่า ANTHROPIC_API_KEY ใช้ได้จริง + AI ตอบยังไง ก่อนปล่อยให้คุยกับลูกค้า
 *
 * วิธีใช้:
 *   node ai-test.js "เสื้อตัวนี้มีไซส์ L ไหมคะ"
 *   node ai-test.js                       (ไม่ใส่ = ใช้คำถามตัวอย่าง)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      const h = v.search(/[ \t]#/);
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const ai = await import('./ai-bot.js');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m' };

const question = process.argv.slice(2).join(' ').trim() || 'เสื้อตัวนี้มีไซส์ L ไหมคะ ราคาเท่าไหร่';

console.log(`${C.gray}provider = ${process.env.AI_PROVIDER || 'anthropic'} · model = ${process.env.AI_MODEL || '(ค่าเริ่มต้น)'}${C.reset}`);
console.log(`${C.gray}ANTHROPIC_API_KEY = ${process.env.ANTHROPIC_API_KEY ? 'ตั้งแล้ว ✓' : C.red + 'ยังไม่ได้ตั้ง ✗' + C.gray}${C.reset}`);

if (ai.isInboxMode()) {
  console.log(`${C.yellow}ตอนนี้ AI_PROVIDER เป็นโหมดคิวไฟล์ (claude-code) — ไม่ได้เรียก API${C.reset}`);
  console.log(`ถ้าจะทดสอบ Claude API จริง ให้ตั้ง AI_PROVIDER=anthropic ใน .env`);
  process.exit(0);
}

console.log(`\n${C.bold}ลูกค้า:${C.reset} ${question}`);

// จำลองข้อความ 1 อันจากลูกค้า ให้มีรูปร่างเหมือนที่ getMessageList คืนมา
const messages = [{
  messageType: 'text',
  fromAccountType: 1,                                  // 1 = ลูกค้า
  messageContent: JSON.stringify({ text: question }),
  createTime: Date.now(),
}];

try {
  const t0 = Date.now();
  const r = await ai.generateReply({
    messages,
    shopName: 'ร้านทดสอบ',
    platform: 'test',
    buyerName: 'ลูกค้าทดสอบ',
  });
  const ms = Date.now() - t0;

  if (!r.reply) {
    console.log(`${C.yellow}AI ไม่ตอบ${C.reset} (${r.reason ?? '-'})`);
  } else if (r.needsStaff) {
    console.log(`\n${C.yellow}AI (ขอให้เจ้าหน้าที่ตรวจก่อนส่ง):${C.reset}\n${r.reply}`);
  } else {
    console.log(`\n${C.green}AI (ตอบเองได้):${C.reset}\n${r.reply}`);
  }
  console.log(`\n${C.gray}ใช้เวลา ${ms} ms${C.reset}`);
} catch (err) {
  console.log(`\n${C.red}ผิดพลาด:${C.reset} ${err.message}`);
  if (String(err.message).includes('401') || /authentication/i.test(err.message)) {
    console.log(`${C.gray}→ คีย์ผิดหรือหมดอายุ เช็คที่ https://console.anthropic.com${C.reset}`);
  }
  process.exit(1);
}
