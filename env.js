/**
 * env.js — โหลด .env เข้า process.env ทันทีที่ถูก import
 *
 * ⚠ ทำไมต้องแยกเป็นโมดูล: ES module ยก `import` ทั้งหมดขึ้นไปทำงาน "ก่อน" โค้ดในไฟล์
 * ถ้าเรียก loadEnv() ในตัวไฟล์หลัก โมดูลอื่นที่ถูก import (เช่น ai-bot.js) จะอ่าน
 * process.env ไปแล้วตอนที่ .env ยังไม่ถูกโหลด → ค่าที่ตั้งใน .env ไม่มีผล
 *
 * วิธีใช้: ต้อง import ตัวนี้ "เป็นบรรทัดแรก" ก่อน import โมดูลที่อ่าน env
 *
 *   import './env.js';
 *   import * as ai from './ai-bot.js';
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** อ่านไฟล์ .env แบบง่าย ไม่ต้องลง dotenv (ค่าที่ตั้งไว้ใน process.env อยู่แล้วชนะ) */
export function loadEnv(file = path.join(__dirname, '.env')) {
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
      if (v.startsWith('#')) v = '';           // ทั้งท่อนหลัง = เป็นคอมเมนต์ → ถือว่าไม่ได้ตั้งค่า
      const h = v.search(/[ \t]#/);            // ตัดคอมเมนต์ท้ายบรรทัด (เว้นวรรค + #)
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnv();
