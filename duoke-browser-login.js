/**
 * duoke-browser-login.js — ล็อกอิน Duoke ด้วยการ "เปิดเบราว์เซอร์จริงให้ล็อกอินเอง"
 *
 * แทนที่จะถอดรหัส/กรอกแคปช่าในเทอร์มินัล (ดู duoke-auth.js) วิธีนี้เปิด Chrome/Edge
 * ที่ติดตั้งอยู่แล้วไปที่หน้าล็อกอิน web.duoke.com ให้ผู้ใช้กรอกเอง (แคปช่า/2FA จัดการ
 * ในเบราว์เซอร์ได้ตามปกติ) แล้วสคริปต์ค่อยดึงคุกกี้ `token` ออกมาใช้ต่อ
 *
 *     import { loginViaBrowser } from './duoke-browser-login.js';
 *     const { token, uid, puid, user } = await loginViaBrowser({ email });
 *
 * ใช้ puppeteer-core = ไม่โหลด Chromium มาเพิ่ม ใช้เบราว์เซอร์ที่มีอยู่ในเครื่อง
 * โปรไฟล์เบราว์เซอร์เก็บไว้ที่ .chrome-profile/ → ครั้งต่อ ๆ ไปมักไม่ต้องล็อกอินซ้ำ
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_URL = 'https://web.duoke.com';
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;   // รอผู้ใช้ล็อกอินได้นานสุด 5 นาที

// ------------------------------------------------------------- หาเบราว์เซอร์

const CANDIDATES = process.platform === 'win32' ? [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
] : process.platform === 'darwin' ? [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] : [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

/** หา path ของ Chrome/Edge ที่ติดตั้งอยู่ — ตั้ง CHROME_PATH ใน .env เพื่อบังคับเองได้ */
export function findBrowser() {
  for (const p of CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ------------------------------------------------------------- helpers

/** อ่าน exp จาก JWT (ไม่ verify) เพื่อกันคุกกี้ค้างเก่า ๆ ที่หมดอายุแล้ว */
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch { return null; }
}

/** token หน้าตาใช้ได้ไหม — เป็น JWT 3 ท่อน และยังไม่หมดอายุ */
function looksUsable(token) {
  if (!token || token.split('.').length !== 3) return false;
  const exp = jwtExp(token);
  return !exp || exp * 1000 > Date.now() + 60_000;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** ดึง token จากทั้งคุกกี้และ localStorage ของหน้า */
async function grabToken(page) {
  // 1) คุกกี้ (README ระบุว่า token เก็บเป็นคุกกี้ `token`)
  try {
    const cookies = await page.cookies(BASE_URL);
    const c = cookies.find(x => x.name === 'token' && looksUsable(x.value));
    if (c) return decodeURIComponent(c.value);
  } catch {}
  // 2) localStorage (เผื่อบางเวอร์ชันเก็บไว้ที่นี่)
  try {
    const v = await page.evaluate(() => {
      for (const k of ['token', 'x-access-token', 'accessToken']) {
        const val = localStorage.getItem(k);
        if (val) return val;
      }
      return null;
    });
    if (looksUsable(v)) return v;
  } catch {}
  return null;
}

/** ดึงข้อมูลผู้ใช้ด้วย token ที่เพิ่งได้ — ให้ผลรูปเดียวกับ login() ใน duoke-auth.js */
async function fetchUser(token) {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/user/?version=web`, {
      headers: { Accept: 'application/json', 'x-access-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (body.code === 0 && body.data) {
      const d = body.data;
      return { uid: d.uid, puid: d.user?.puid ?? d.puid, user: d.user ?? d };
    }
  } catch {}
  return { uid: undefined, puid: undefined, user: undefined };
}

/** ยืนยันกับเซิร์ฟเวอร์ว่า token ใช้ได้จริง (กัน token เก่าค้างในโปรไฟล์) */
async function validateToken(token) {
  if (!looksUsable(token)) return false;
  try {
    const res = await fetch(`${BASE_URL}/api/v1/im/conversation/queryTotalUnHandlerCount`, {
      headers: { Accept: 'application/json', 'x-access-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body.code === 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- login

/**
 * เปิดเบราว์เซอร์ให้ผู้ใช้ล็อกอิน แล้วคืน token
 *
 * @param {object} [opts]
 * @param {string} [opts.email]           เติมช่องอีเมลให้ล่วงหน้า (ถ้าหน้าเว็บมีช่องนั้น)
 * @param {string} [opts.baseUrl]         default https://web.duoke.com
 * @param {number} [opts.timeoutMs]       รอผู้ใช้ล็อกอินนานสุด (default 5 นาที)
 * @param {string} [opts.executablePath]  path เบราว์เซอร์ (ไม่ใส่ = หาเอง)
 * @param {(msg:string)=>void} [opts.onStatus] callback ไว้พิมพ์สถานะ
 * @returns {Promise<{token:string, uid?:string, puid?:string, user?:object}>}
 */
export async function loginViaBrowser({
  email,
  baseUrl = BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  executablePath,
  onStatus = () => {},
} = {}) {
  const exe = executablePath || findBrowser();
  if (!exe) {
    throw new Error(
      'หา Chrome/Edge ในเครื่องไม่เจอ — ติดตั้ง Google Chrome หรือกำหนด path เองด้วย\n' +
      '   CHROME_PATH=C:\\path\\to\\chrome.exe  ใน .env'
    );
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  onStatus('🌐 กำลังเปิดเบราว์เซอร์...');
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    userDataDir: PROFILE_DIR,
    args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });

  let closedByUser = false;
  browser.on('disconnected', () => { closedByUser = true; });

  // ดักอ่าน token จาก header `x-access-token` ที่หน้าเว็บยิง API จริง ๆ
  // = token ที่แอปใช้แน่นอน เชื่อถือได้กว่าการเดาคุกกี้/localStorage
  let sniffed = null;
  const onRequest = (req) => {
    try {
      const t = req.headers()['x-access-token'];
      if (t && looksUsable(t)) sniffed = t;
    } catch {}
  };
  const attach = (p) => { try { p.on('request', onRequest); } catch {} };

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    attach(page);
    browser.on('targetcreated', async (t) => {
      const p = await t.page().catch(() => null);
      if (p) attach(p);
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // หา token ที่ "ผ่านการตรวจกับเซิร์ฟเวอร์แล้ว" เท่านั้น
    const findValid = async () => {
      for (const cand of [sniffed, await grabToken(page).catch(() => null)]) {
        if (cand && await validateToken(cand)) return cand;
      }
      return null;
    };

    // เผื่อ session เดิมในโปรไฟล์ยัง valid → ได้ token เลยไม่ต้องรอ
    let token = await findValid();
    if (token) {
      onStatus('✅ พบ session เดิมในเบราว์เซอร์ที่ยังใช้ได้ — ใช้ต่อได้เลย');
    } else {
      // เคลียร์ session เก่าที่ใช้ไม่ได้ออกจากโปรไฟล์ ให้ขึ้นหน้า login สะอาด ๆ
      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach().catch(() => {});
      } catch {}
      try { await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }); } catch {}
      sniffed = null;
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

      // เติมอีเมลให้ล่วงหน้า (best-effort — ไม่ error ถ้าหาช่องไม่เจอ)
      if (email) {
        await page.evaluate((em) => {
          const el = document.querySelector(
            'input[type="email"], input[name*="mail" i], input[placeholder*="mail" i], input[placeholder*="อีเมล"]'
          );
          if (el) { el.value = em; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, email).catch(() => {});
      }

      onStatus('👉 ล็อกอินในหน้าต่างเบราว์เซอร์ที่เปิดขึ้นมา (แคปช่า/2FA กรอกในนั้นได้เลย)');
      onStatus(`   ระบบจะดึง token ให้เองหลังล็อกอินเสร็จ — รอได้นานสุด ${Math.round(timeoutMs / 60000)} นาที`);

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (closedByUser) throw new Error('เบราว์เซอร์ถูกปิดก่อนล็อกอินเสร็จ');
        await sleep(POLL_MS);
        token = await findValid();
        if (token) break;
      }
      if (!token) throw new Error(`หมดเวลารอล็อกอิน (${Math.round(timeoutMs / 60000)} นาที)`);
      onStatus('✅ ล็อกอินสำเร็จ — ได้ token แล้ว');
    }

    const info = await fetchUser(token);
    return { token, ...info };
  } finally {
    if (!closedByUser) await browser.close().catch(() => {});
  }
}
