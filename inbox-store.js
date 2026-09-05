/**
 * inbox-store.js — ที่เก็บ "คำถามที่รอตอบ" (สะพานให้ Claude Code / คนตอบผ่านไฟล์)
 *
 * watch.js เขียนคำถาม+บริบทลง inbox/<conversationId>.json
 * แล้ว Claude Code (หรือคน) อ่านไฟล์พวกนี้ → ร่างคำตอบ → ส่งด้วย inbox.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INBOX_DIR = process.env.INBOX_DIR
  ? path.resolve(process.env.INBOX_DIR)
  : path.join(__dirname, 'inbox');

function ensureDir() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

const safe = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
const fileOf = id => path.join(INBOX_DIR, safe(id) + '.json');

/** เขียน/อัปเดตคำถามที่รอตอบ 1 ห้อง */
export function writeInbox(item) {
  ensureDir();
  const data = { ...item, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileOf(item.conversationId), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** อ่านคำถามที่รอตอบทั้งหมด (เรียงเก่า → ใหม่) */
export function listInbox() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(INBOX_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf8'))); } catch {}
  }
  out.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  return out;
}

/** อ่านคำถามห้องเดียว */
export function readInbox(conversationId) {
  try { return JSON.parse(fs.readFileSync(fileOf(conversationId), 'utf8')); }
  catch { return null; }
}

/** ลบออกจากคิว (เรียกหลังตอบเสร็จ) */
export function removeInbox(conversationId) {
  try { fs.unlinkSync(fileOf(conversationId)); return true; } catch { return false; }
}

/** จำนวนที่รออยู่ */
export function inboxCount() {
  try { return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}
