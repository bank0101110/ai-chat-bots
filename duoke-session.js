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
  // เขียนไฟล์ชั่วคราวแล้ว rename — โปรเซสอื่นที่อ่านอยู่จะไม่เจอไฟล์ครึ่ง ๆ กลาง ๆ
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, CACHE_FILE);
}

export function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

/** อ่าน session ที่แชร์กันอยู่ใน .token.json (ทุกโปรเซสใช้ไฟล์เดียวกัน) */
export function readSharedSession() {
  return readCache();
}

/** อ่าน exp จาก JWT (วินาที epoch) — ไม่ verify signature แค่ดูวันหมดอายุ */
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch { return null; }
}

/**
 * ตรวจ token กับเซิร์ฟเวอร์ → 'valid' | 'invalid' | 'unknown'
 * 'unknown' = เน็ตล่ม/เซิร์ฟเวอร์ตอบแปลก ๆ — ไม่ได้แปลว่า token เสีย
 */
export async function checkToken(token, baseUrl = 'https://web.duoke.com') {
  if (!token) return 'invalid';
  const exp = jwtExp(token);
  if (exp && exp * 1000 < Date.now() + 60_000) return 'invalid';   // หมดอายุ / ใกล้หมด
  try {
    const res = await fetch(`${baseUrl}/api/v1/im/conversation/queryTotalUnHandlerCount`, {
      headers: { Accept: 'application/json', 'x-access-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (!res.ok) return 'unknown';
    const body = await res.json().catch(() => null);
    if (body?.code === 0) return 'valid';
    // code 401/403 ในบอดี้ = token เสียจริง · code อื่น = ไม่แน่ใจ อย่าเพิ่งทิ้ง token
    return [401, 403, '401', '403'].includes(body?.code) ? 'invalid' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * เช็คว่า token ยังใช้ได้ไหม
 * ⚠ เดิมคืน false ตอนเน็ตกระตุก → ล็อกอินใหม่ → token ของโปรเซสอื่นโดนเตะทิ้งทั้งหมด
 *   ตอนนี้ถ้าไม่แน่ใจ (เน็ตล่ม) ให้ถือว่ายังใช้ได้ ถ้าเสียจริงเดี๋ยว API จะตอบ 401 เอง
 */
export async function isTokenValid(token, baseUrl) {
  return (await checkToken(token, baseUrl)) !== 'invalid';
}

// ------------------------------------------------------ lock (กันล็อกอินซ้อน)
// หลายโปรเซส (watch.js / ui-server.js / outbox.js / reply.js) ใช้ token ชุดเดียวกัน
// ถ้าต่างคนต่างล็อกอินเอง Duoke จะออก token ใหม่ แล้ว token เก่าของอีกโปรเซสใช้ไม่ได้
// → วนเตะกันไปมาไม่จบ จึงให้ล็อกอินได้ทีละโปรเซส ที่เหลือรอแล้วหยิบ token ใหม่จากไฟล์ไปใช้

const LOCK_FILE = path.join(__dirname, '.token.lock');
const LOCK_STALE_MS = 10 * 60_000;           // ล็อกค้างนานเกินนี้ (โปรเซสตาย) → ยึดต่อได้
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tryLock() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    try {
      const st = fs.statSync(LOCK_FILE);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); return tryLock(); }
    } catch { /* ล็อกเพิ่งถูกปล่อย */ }
    return false;
  }
}
function unlock() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (l.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

/**
 * แจ้งเตือนเมื่อโปรเซสอื่นเขียน token ใหม่ลง .token.json
 * ใช้สลับ token ในโปรเซสที่รันค้างไว้ โดยไม่ต้องล็อกอินเอง
 * @param {(session) => void} onChange
 * @returns {() => void} ฟังก์ชันเลิกฟัง
 */
export function watchSharedSession(onChange, intervalMs = 3000) {
  let last = readCache()?.token ?? null;
  const listener = () => {
    const s = readCache();
    if (s?.token && s.token !== last) {
      last = s.token;
      try { onChange(s); } catch {}
    }
  };
  fs.watchFile(CACHE_FILE, { interval: intervalMs }, listener);
  return () => fs.unwatchFile(CACHE_FILE, listener);
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
 *   1. .token.json ที่แชร์กันทุกโปรเซส (ถ้ายังใช้ได้)
 *   2. DUOKE_TOKEN ใน env (ถ้ายังใช้ได้)
 *   3. ล็อกอินใหม่ — ทีละโปรเซสเท่านั้น (มีไฟล์ล็อก) ที่เหลือรอหยิบ token ใหม่จากไฟล์
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]      บังคับล็อกอินใหม่ (npm run relogin)
 * @param {string}  [opts.staleToken] token ที่เพิ่งโดน 401 — ถ้าในไฟล์ยังเป็นตัวนี้อยู่ค่อยล็อกอินใหม่
 *                                    ถ้าโปรเซสอื่นล็อกอินไปแล้ว (ไฟล์มี token ใหม่) ก็ใช้ตัวใหม่เลย
 * @returns {Promise<{token:string, uid?:string, puid?:string, user?:object, source:string}>}
 */
export async function getSession({ force = false, staleToken, email, password } = {}) {
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

  /** ลองใช้ token ที่มีอยู่แล้ว (ไฟล์ที่แชร์กัน → DUOKE_TOKEN) */
  const reuse = async () => {
    const cached = readCache();
    if (cached && (!cached.email || cached.email === email) && cached.token !== staleToken) {
      process.stdout.write('🔎 ตรวจ token ที่แชร์ไว้ (.token.json) ...');
      if (await isTokenValid(cached.token)) {
        process.stdout.write(' ยังใช้ได้\n');
        return { ...cached, source: 'cache' };
      }
      process.stdout.write(' ใช้ไม่ได้แล้ว\n');
    }
    const envTok = process.env.DUOKE_TOKEN;
    if (envTok && envTok !== staleToken) {
      process.stdout.write('🔎 ตรวจ DUOKE_TOKEN จาก .env ...');
      if (await isTokenValid(envTok)) {
        process.stdout.write(' ยังใช้ได้\n');
        return { token: envTok, source: 'env' };
      }
      process.stdout.write(' ใช้ไม่ได้แล้ว\n');
    }
    return null;
  };

  if (!force) {
    const s = await reuse();
    if (s) return s;
  }

  // ---- ต้องล็อกอินใหม่: ให้ทำทีละโปรเซส ----
  let waited = false;
  while (!tryLock()) {
    if (!waited) { console.log('⏳ มีโปรเซสอื่นกำลังล็อกอินอยู่ — รอใช้ token ชุดเดียวกัน ...'); waited = true; }
    await sleep(2000);
    const cached = readCache();
    if (cached?.token && cached.token !== staleToken && (!cached.email || cached.email === email)
        && await isTokenValid(cached.token)) {
      return { ...cached, source: 'shared' };
    }
  }

  try {
    // ได้ล็อกแล้ว — เช็คซ้ำอีกรอบ เผื่อโปรเซสอื่นเพิ่งล็อกอินเสร็จก่อนหน้าเสี้ยววินาที
    if (!force || waited) {
      const s = await reuse();
      if (s) return s;
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
  } finally {
    unlock();
  }
}

/**
 * token ที่ใช้อยู่โดน 401 → ขอ token ที่ใช้ได้ "โดยไม่ล็อกอินซ้ำถ้าไม่จำเป็น"
 * ถ้าโปรเซสอื่นล็อกอินไปแล้วจะได้ token ตัวใหม่จากไฟล์ทันที
 */
export function refreshSession(staleToken, opts = {}) {
  return getSession({ ...opts, staleToken });
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
