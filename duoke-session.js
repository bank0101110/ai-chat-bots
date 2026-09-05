/**
 * duoke-session.js — จัดการ token ให้อัตโนมัติ
 *
 * ใช้ email/password จาก .env → ล็อกอิน → เก็บ token ไว้ใน .token.json → ใช้ซ้ำจนกว่าจะหมดอายุ
 *
 *   import { getToken } from './duoke-session.js';
 *   const token = await getToken();          // ล็อกอินให้เองถ้าจำเป็น
 *
 * ⚠️ ขั้นตอนล็อกอินของ Duoke มี "แคปช่ารูปภาพ" ที่ต้องมีคนอ่าน
 *    สคริปต์จะเปิดรูปให้แล้วรอพิมพ์ในเทอร์มินัล — เฉพาะตอนที่ token เดิมใช้ไม่ได้แล้วเท่านั้น
 *    (token อยู่ได้หลายวัน จึงไม่ได้ถามบ่อย และ nodemon รีสตาร์ตก็ใช้ token เดิมต่อ ไม่ถามซ้ำ)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin, stdout, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getVerifyCode, login, verifyTotp, CAPTCHA_ERROR_CODES } from './duoke-auth.js';
import { loginViaBrowser } from './duoke-browser-login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_FILE = path.join(__dirname, '.token.json');
const CAPTCHA_FILE = path.join(__dirname, 'captcha.jpg');

// ------------------------------------------------------------------- cache

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c && c.token ? c : null;
  } catch { return null; }
}

function writeCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  try { fs.chmodSync(CACHE_FILE, 0o600); } catch {}
}

export function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

/** อ่าน exp จาก JWT (วินาที epoch) — ไม่ verify signature แค่ดูวันหมดอายุ */
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch { return null; }
}

/** เช็คว่า token ยังใช้ได้จริงกับเซิร์ฟเวอร์ */
export async function isTokenValid(token, baseUrl = 'https://web.duoke.com') {
  if (!token) return false;
  const exp = jwtExp(token);
  if (exp && exp * 1000 < Date.now() + 60_000) return false;      // หมดอายุ / ใกล้หมด
  try {
    const res = await fetch(`${baseUrl}/api/v1/im/conversation/queryTotalUnHandlerCount`, {
      headers: { Accept: 'application/json', 'x-access-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return false;
    const body = await res.json();
    return body.code === 0;
  } catch {
    return false;                       // เน็ตล่ม — ให้ไปล็อกอินใหม่ดีกว่าเดาว่าใช้ได้
  }
}

// ------------------------------------------------------------------- login

function openImage(file) {
  try {
    const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
      : platform === 'darwin' ? ['open', [file]]
      : ['xdg-open', [file]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

/**
 * ล็อกอินใหม่ (ถามแคปช่าในเทอร์มินัล)
 * @returns {Promise<{token,uid,puid,user}>}
 */
export async function loginInteractive({ email, password, attempts = 3 } = {}) {
  if (!email || !password) {
    throw new Error('ต้องตั้ง DUOKE_EMAIL และ DUOKE_PASSWORD ใน .env ก่อน');
  }
  if (!stdin.isTTY) {
    throw new Error(
      'token หมดอายุแล้วและต้องกรอกแคปช่า แต่ตอนนี้ไม่มีเทอร์มินัลให้พิมพ์\n' +
      '   → รัน  npm run login  ด้วยมือหนึ่งครั้ง แล้วค่อยสั่งรันแบบ background อีกที'
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (let i = 1; i <= attempts; i++) {
      process.stdout.write('🌐 กำลังขอแคปช่าจาก web.duoke.com ...');
      const { verifyKey, verifyCode } = await getVerifyCode();
      process.stdout.write(' ได้แล้ว\n');
      fs.writeFileSync(CAPTCHA_FILE, Buffer.from(verifyCode, 'base64'));
      const opened = openImage(CAPTCHA_FILE);
      console.log(`\n🖼  แคปช่า: ${CAPTCHA_FILE}${opened ? ' (เปิดให้แล้ว)' : ' — เปิดไฟล์นี้ดู'}`);

      const verify = (await rl.question('   ตัวอักษรในรูป: ')).trim();
      try {
        process.stdout.write('   กำลังล็อกอิน ...');
        const data = await login({ email, password, verify, verifyKey });
        process.stdout.write(' สำเร็จ\n');
        return data;
      } catch (err) {
        process.stdout.write('\n');
        if (err.code === 14103) {                       // ต้องยืนยัน 2FA
          const code = (await rl.question('   รหัส 2FA 6 หลัก: ')).trim();
          return await verifyTotp({ sign: err.data.sign, code });
        }
        if (CAPTCHA_ERROR_CODES.includes(err.code) && i < attempts) {
          console.log(`   ⚠️  ไม่ผ่าน (code ${err.code}) — ขอแคปช่าใหม่...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('กรอกแคปช่าไม่ผ่านครบจำนวนครั้งที่กำหนด');
  } finally {
    rl.close();
    try { fs.unlinkSync(CAPTCHA_FILE); } catch {}
  }
}

// --------------------------------------------------------------- getToken

/**
 * คืน token ที่ใช้งานได้ — ลำดับการหา:
 *   1. .token.json ที่แคชไว้ (ถ้ายัง valid)
 *   2. DUOKE_TOKEN ใน env (ถ้ายัง valid)
 *   3. ล็อกอินใหม่ด้วย DUOKE_EMAIL / DUOKE_PASSWORD
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] บังคับล็อกอินใหม่ ไม่สนแคช
 * @returns {Promise<{token:string, uid?:string, puid?:string, user?:object, source:string}>}
 */
export async function getSession({ force = false, email, password } = {}) {
  email ??= process.env.DUOKE_EMAIL;
  password ??= process.env.DUOKE_PASSWORD;

  const method = (process.env.DUOKE_LOGIN || 'browser').toLowerCase();
  // โหมด browser: พิมพ์รหัสผ่านในเบราว์เซอร์เอง จึงไม่บังคับ DUOKE_PASSWORD ใน .env
  const needPassword = method === 'terminal';
  if (!email || (needPassword && !password)) {
    throw new Error(
      needPassword
        ? 'ยังไม่ได้ตั้ง DUOKE_EMAIL / DUOKE_PASSWORD\n' +
          '   → copy .env.example .env   แล้วเปิด .env ใส่อีเมลกับรหัสผ่าน'
        : 'ยังไม่ได้ตั้ง DUOKE_EMAIL\n' +
          '   → copy .env.example .env   แล้วเปิด .env ใส่อีเมล (รหัสผ่านพิมพ์ในเบราว์เซอร์)'
    );
  }

  if (!force) {
    const cached = readCache();
    if (cached && cached.email === email) {
      process.stdout.write('🔎 ตรวจ token ที่แคชไว้ ...');
      if (await isTokenValid(cached.token)) {
        process.stdout.write(' ยังใช้ได้\n');
        return { ...cached, source: 'cache' };
      }
      process.stdout.write(' ใช้ไม่ได้แล้ว\n');
    }
    if (process.env.DUOKE_TOKEN) {
      process.stdout.write('🔎 ตรวจ DUOKE_TOKEN จาก .env ...');
      if (await isTokenValid(process.env.DUOKE_TOKEN)) {
        process.stdout.write(' ยังใช้ได้\n');
        return { token: process.env.DUOKE_TOKEN, source: 'env' };
      }
      process.stdout.write(' ใช้ไม่ได้แล้ว\n');
    }
  }

  const data = method === 'terminal'
    ? await loginInteractive({ email, password })
    : await loginViaBrowser({ email, onStatus: (m) => console.log(m) });
  const session = {
    token: data.token,
    uid: data.uid,
    puid: data.puid,
    email,
    loginAt: Date.now(),
    expAt: (() => { const e = jwtExp(data.token); return e ? e * 1000 : null; })(),
  };
  writeCache(session);
  return { ...session, user: data.user, source: 'login' };
}

/** เอาแค่ token */
export async function getToken(opts) {
  return (await getSession(opts)).token;
}

// ---------------------------------------------------------------------- CLI
// `npm run login` — ล็อกอินล่วงหน้าแล้วเก็บ token ไว้ ให้ watch.js ใช้ต่อโดยไม่ต้องถามอะไรอีก

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Duoke login  ·  node ${process.version}`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`\n❌ ต้องใช้ Node 18 ขึ้นไป (เครื่องนี้ ${process.version}) — โหลดที่ https://nodejs.org`);
    process.exit(1);
  }

  // อ่าน .env เอง (ไฟล์นี้อาจถูกเรียกตรง ๆ โดยไม่ผ่าน watch.js)
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error(`
❌ ไม่พบไฟล์ .env

   Windows:      copy .env.example .env
   macOS/Linux:  cp .env.example .env

   แล้วเปิด .env ใส่
     DUOKE_EMAIL=you@example.com
     DUOKE_PASSWORD=รหัสผ่านของคุณ
`);
    process.exit(1);
  }
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
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

  const force = process.argv.includes('--force');
  try {
    const s = await getSession({ force });
    const days = s.expAt ? Math.floor((s.expAt - Date.now()) / 86400000) : null;
    console.log(`\n✅ ${s.source === 'login' ? 'ล็อกอินสำเร็จ' : 'token เดิมยังใช้ได้'}`);
    if (s.uid) console.log(`   uid  : ${s.uid}`);
    if (s.puid) console.log(`   puid : ${s.puid}`);
    console.log(`   บัญชี: ${s.email ?? s.user?.email ?? '-'}`);
    if (days !== null) console.log(`   อายุ : อีกประมาณ ${days} วัน`);
    console.log(`   เก็บไว้ที่ .token.json แล้ว — รัน  npm run dev  ได้เลย`);
  } catch (err) {
    console.error(`\n❌ ล็อกอินไม่สำเร็จ${err.code ? ` (code ${err.code})` : ''}: ${err.message}`);
    process.exitCode = 1;
  }
}
