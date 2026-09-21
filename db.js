/**
 * db.js — Prisma client (Supabase) แบบ singleton
 *
 * ไม่ได้ตั้ง DATABASE_URL = ระบบยังทำงานได้ตามเดิม แค่ไม่บันทึกลงฐานข้อมูล
 * (บอทต้องไม่ล่มเพราะ DB ล่ม — ทุกจุดที่เขียน DB ครอบ try/catch ไว้หมด)
 */
import './env.js';

let _prisma = null;
let _loading = null;
let _warned = false;

export function dbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

/** คืน PrismaClient หรือ null (ไม่ได้ตั้งค่า / ยังไม่ได้ generate) */
export async function getDb() {
  if (!dbEnabled()) return null;
  if (_prisma) return _prisma;
  if (!_loading) {
    _loading = import('@prisma/client')
      .then(({ PrismaClient }) => {
        _prisma = new PrismaClient({ log: ['error'] });
        return _prisma;
      })
      .catch(err => {
        if (!_warned) {
          _warned = true;
          console.error(`⚠️  ต่อฐานข้อมูลไม่ได้ (${err.message}) — รัน  npm run db:generate  ก่อน`);
        }
        _loading = null;
        return null;
      });
  }
  return _loading;
}

export async function disconnectDb() {
  try { await _prisma?.$disconnect(); } catch {}
}
