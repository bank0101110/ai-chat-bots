/**
 * duoke-auth.js — ล็อกอิน Duoke แล้วได้ token มาใช้กับ duoke-api.js
 *
 * เป็น "ชั้นล่าง" — แค่ห่อ endpoint ล็อกอินกับตัวเข้ารหัสไว้
 * ถ้าอยากได้ token แบบจัดการแคชให้เอง ใช้ duoke-session.js แทน (npm run login)
 *
 *     import { encryptDuoke, getVerifyCode, login, verifyTotp } from './duoke-auth.js';
 *
 * ⚠️ ล็อกอินต้องผ่าน "แคปช่า" ที่เป็นรูปภาพ — ระบบอัตโนมัติล้วน ๆ ทำไม่ได้
 *    ต้องมีคนอ่านรูปแล้วพิมพ์ ทุกครั้งที่ขอ token ใหม่
 *    token มีอายุยาว (คุกกี้ตั้งไว้ 8 วัน) จึงล็อกอินครั้งเดียวแล้วใช้ต่อได้นาน
 */

import crypto from 'node:crypto';

export const BASE_URL = 'https://web.duoke.com';

/**
 * กุญแจ AES-256-ECB ที่ฝังอยู่ในหน้าเว็บ (ประกอบจาก 4 ท่อนในโค้ด)
 *   "QcclOsWB" + atob("TWJaalNRaEE=") + "cETUuonq" + String.fromCharCode(114,122,...)
 */
export const AES_KEY = 'QcclOsWB' + Buffer.from('TWJaalNRaEE=', 'base64').toString('utf8')
  + ['c', 'E', 'T', 'U', 'u', 'o', 'n', 'q'].join('')
  + String.fromCharCode(114, 122, 114, 102, 109, 83, 107, 113);
// = "QcclOsWBMbZjSQhAcETUuonqrzrfmSkq" (32 ไบต์)

/** เทียบเท่า $commFn.getEncryptedString() ของหน้าเว็บ — AES-256-ECB / PKCS7 / base64 */
export function encryptDuoke(plain) {
  if (!plain) return plain;
  const c = crypto.createCipheriv('aes-256-ecb', Buffer.from(AES_KEY, 'utf8'), null);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(String(plain), 'utf8'), c.final()]).toString('base64');
}

/** ถอดกลับ — ไว้ตรวจสอบว่าเข้ารหัสถูก */
export function decryptDuoke(b64) {
  const d = crypto.createDecipheriv('aes-256-ecb', Buffer.from(AES_KEY, 'utf8'), null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ requests

async function call(method, path_, { form, json } = {}, baseUrl = BASE_URL) {
  const headers = { Accept: 'application/json, text/plain, */*' };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(baseUrl + path_, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`ต่อ ${baseUrl}${path_} ไม่ได้ (${e.name === 'TimeoutError' ? 'หมดเวลา 20 วิ' : e.message}) — เช็คเน็ต/ไฟร์วอลล์/พร็อกซี`);
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`ตอบกลับไม่ใช่ JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (payload.code !== 0) {
    const err = new Error(payload.message || `Duoke error ${payload.code}`);
    err.code = payload.code;
    err.data = payload.data;
    throw err;
  }
  return payload.data;
}

/**
 * ขอแคปช่า
 * @returns {Promise<{verifyKey: string, verifyCode: string}>} verifyCode = รูป JPEG แบบ base64
 */
export function getVerifyCode(baseUrl = BASE_URL) {
  return call('GET', '/api/v1/user/getVerifyCode', {}, baseUrl);
}

/**
 * ล็อกอิน
 *
 * POST /api/v1/user/login   (application/x-www-form-urlencoded)
 *   body = AES( JSON.stringify({ email, password: AES(password), verify, verifyKey, version }) )
 *
 * @returns {Promise<{token:string, uid:string, puid:string, user:object}>}
 *          `token` คือค่าเดียวกับที่ใช้เป็น header `x-access-token` และคุกกี้ `token`
 * @throws  err.code 14103 = ต้องยืนยัน 2FA ต่อ (err.data.sign → verifyTotp)
 */
export function login({ email, password, verify, verifyKey, version = 'web' }, baseUrl = BASE_URL) {
  const inner = {
    email,
    password: encryptDuoke(password),   // เข้ารหัสชั้นใน
    verify,                             // ตัวอักษรในรูปแคปช่า
    verifyKey,                          // key ที่มาคู่กับรูป
    version,                            // "web" | เวอร์ชันแอป desktop
  };
  return call('POST', '/api/v1/user/login', {
    form: { body: encryptDuoke(JSON.stringify(inner)) },   // เข้ารหัสชั้นนอก
  }, baseUrl);
}

/** ยืนยัน 2FA (เรียกเมื่อ login โยน error code 14103) */
export function verifyTotp({ sign, code }, baseUrl = BASE_URL) {
  return call('POST', '/api/v1/user/totp/verifyPc', { form: { sign, code } }, baseUrl);
}

/** ออกจากระบบ (ทำให้ token ปัจจุบันใช้ไม่ได้) */
export async function logout(token, baseUrl = BASE_URL) {
  const res = await fetch(baseUrl + '/api/v1/user/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: '{}',
  });
  return res.json();
}

/** โค้ด error ที่แปลว่า "แคปช่าผิด/หมดอายุ" → ต้องขอรูปใหม่แล้วลองใหม่ */
export const CAPTCHA_ERROR_CODES = [
  10101, 10102, 10103, 10104, 10105, 10106, 10107, 10108, 10109,
  10114, 11901, 20253,
];

