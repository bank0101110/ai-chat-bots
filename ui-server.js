/**
 * ui-server.js — หลังบ้านของหน้าเว็บ (Duoke Desk)
 *
 *   npm run ui        → build หน้าเว็บ แล้วเปิด http://localhost:5174
 *   npm run ui:dev    → โหมดพัฒนา (Vite hot reload ที่ http://localhost:5173)
 *
 * รันแยกจาก watch.js ได้ — ใช้ token ชุดเดียวกัน (.token.json) ไม่ล็อกอินซ้ำ
 *   - อ่านห้องแชท/ข้อความ/ออร์เดอร์/สินค้า สด ๆ จาก Duoke
 *   - ตอบลูกค้า / ส่งการ์ดสินค้า / ติดแท็ก ผ่าน socket เดียวกับหน้าเว็บ Duoke
 *   - ประวัติที่ AI ตอบ, คำตอบสำเร็จรูป, โน้ต, ปิด AI รายห้อง → เก็บใน Supabase (Prisma)
 *
 * .env:
 *   UI_PORT=5174
 *   UI_HOST=127.0.0.1        ← ค่าเริ่มต้นเปิดให้เครื่องนี้เท่านั้น (0.0.0.0 = ให้เครื่องอื่นในวงแลนเข้าได้)
 *   UI_PASSWORD=             ← ตั้งไว้ = ต้องใส่รหัสก่อนใช้งาน (แนะนำถ้าเปิด 0.0.0.0)
 *   DATABASE_URL / DIRECT_URL ← Supabase (ดู prisma/schema.prisma)
 */
import './env.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DuokeApi, parseMessageContent } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';
import { getSession, refreshSession, watchSharedSession } from './duoke-session.js';
import { getDb, dbEnabled } from './db.js';
import * as ai from './ai-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// BigInt (id ของ EventLog) → JSON
BigInt.prototype.toJSON ??= function () { return this.toString(); };
const PORT = Number(process.env.UI_PORT || 5174);
const HOST = process.env.UI_HOST || '127.0.0.1';
const PASSWORD = process.env.UI_PASSWORD || '';
const DIST = path.join(__dirname, 'web', 'dist');
const KNOWLEDGE_DIR = process.env.AI_KNOWLEDGE_DIR
  ? path.resolve(process.env.AI_KNOWLEDGE_DIR)
  : path.join(__dirname, 'knowledge');

// ------------------------------------------------------------ Duoke session

const duoke = {
  api: null, rt: null, puid: null, uid: null, user: null,
  shops: [], tags: [], state: 'starting', error: null,
};
let reauthing = null;

const isAuthError = err => err?.code === 401 || err?.code === 403 || /\b(401|403)\b/.test(err?.message ?? '');

async function connectDuoke(token) {
  duoke.rt?.disconnect();
  const api = new DuokeApi({ token, language: 'th' });
  const rt = new DuokeRealtime({ api });
  rt.on('state', s => { duoke.state = s.state; broadcast('duoke_state', { state: s.state }); });
  rt.on('newMessage', e => broadcast('message', {
    conversationId: e.conversationId, shopId: e.shopId, platform: e.platform,
  }));
  // ข้อความถูกแก้สถานะ (เช่น แพลตฟอร์มตีกลับว่าส่งไม่สำเร็จ) → ให้หน้าเว็บโหลดห้องนั้นใหม่
  const onModified = raw => {
    const cid = findConversationId(raw);
    broadcast('message_modified', { conversationId: cid });
  };
  rt.on('messageModified', onModified);
  rt.on('other', e => { if (/fail|error|modif|status|recall|revoke/i.test(String(e.type ?? ''))) onModified(e); });
  rt.on('conversations', e => broadcast('conversations', {
    ids: (e.conversations ?? []).map(c => c.conversationId),
  }));
  rt.on('kicked', () => { duoke.state = 'kicked'; broadcast('duoke_state', { state: 'kicked' }); });
  rt.on('error', err => console.error('⚠️  socket:', err.message));

  const user = await api.getUser();
  duoke.api = api;
  duoke.rt = rt;
  duoke.user = user.user ?? user;
  duoke.puid = duoke.user.puid ?? user.puid;
  duoke.uid = duoke.user.id ?? user.uid ?? user.id;
  duoke.shops = await api.getShops();
  try {
    const t = await api.getTagList();
    duoke.tags = Array.isArray(t) ? t : (t?.list ?? []);
  } catch { duoke.tags = []; }
  await rt.connect();
  duoke.state = 'connected';
  duoke.error = null;
}

async function startDuoke() {
  try {
    const s = await getSession();
    await connectDuoke(s.token);
    console.log(`✅ ต่อ Duoke แล้ว — ${duoke.shops.length} ร้าน`);
  } catch (err) {
    duoke.state = 'error';
    duoke.error = err.message;
    console.error('❌ ต่อ Duoke ไม่ได้:', err.message);
  }
}

/** token โดน 401 → ขอ token ที่ใช้ได้แบบแชร์ (ถ้าโปรเซสอื่นล็อกอินแล้ว ใช้ของเขาเลย) */
function reauth() {
  if (!reauthing) {
    const stale = duoke.api?.token;
    reauthing = refreshSession(stale)
      .then(s => connectDuoke(s.token))
      .finally(() => { reauthing = null; });
  }
  return reauthing;
}

/** เรียก Duoke API — โดน 401 จะขอ token ใหม่แล้วลองอีกครั้ง */
async function withDuoke(fn) {
  if (!duoke.api) throw httpError(503, duoke.error || 'ยังต่อ Duoke ไม่สำเร็จ');
  try {
    return await fn(duoke.api, duoke.rt);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    await reauth();
    return fn(duoke.api, duoke.rt);
  }
}

// watch.js ล็อกอินได้ token ใหม่ → สลับมาใช้ตัวเดียวกัน
watchSharedSession(s => {
  if (s.token === duoke.api?.token || reauthing) return;
  console.log('🔁 ใช้ token ใหม่จาก .token.json');
  connectDuoke(s.token).catch(err => console.error('สลับ token ไม่สำเร็จ:', err.message));
});

// ------------------------------------------------------------------- helpers

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const toMs = t => {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};
/**
 * หา URL รูปจากอ็อบเจ็กต์ของ Duoke โดยดูจากชื่อฟิลด์ (แต่ละแพลตฟอร์มตั้งชื่อไม่เหมือนกัน
 * เช่น buyerAvatar / buyerPortrait / headImg / avatarUrl) — ดูชั้นแรกและชั้นย่อย 1 ชั้น
 */
function findImage(obj, re, depth = 1) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && re.test(k) && /^(https?:)?\/\//.test(v.trim())) return v.trim().replace(/^\/\//, 'https://');
    if (Array.isArray(v) && re.test(k) && typeof v[0] === 'string' && /^(https?:)?\/\//.test(v[0].trim())) return v[0].trim().replace(/^\/\//, 'https://');
  }
  if (depth > 0) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const hit = findImage(v, re, depth - 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}
const BUYER_IMG = /avatar|portrait|head_?img|head_?url|headpic|photo|buyer.*(img|image|pic|icon)|profile.*(img|pic)/i;
const SHOP_IMG = /logo|avatar|portrait|shop.*(img|image|icon|pic)|icon/i;
const shopById = id => duoke.shops.find(s => String(s.id ?? s.shopId) === String(id));
const shapeShop = s => ({
  id: String(s.id ?? s.shopId), name: s.shopName, platform: s.platform,
  logo: findImage(s, SHOP_IMG),
});

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };

function lastTextOf(c) {
  // ชื่อฟิลด์ข้อความล่าสุดต่างกันตามแพลตฟอร์ม/เวอร์ชัน (lastMessageContent / latestMessageContent / lastMessage ...)
  let raw = c.lastMessageContent;
  if (raw == null || raw === '') {
    const key = Object.keys(c).find(k => /^(last|latest)/i.test(k) && /(content|text|msg|message)/i.test(k)
      && !/time|type|id|source|status/i.test(k) && c[k] != null && c[k] !== '');
    raw = key ? c[key] : null;
  }
  if (raw == null || raw === '') return '';
  let j = raw;
  if (typeof raw === 'string') {
    try { j = JSON.parse(raw); } catch { return raw; }
    if (typeof j !== 'object' || j === null) return String(j);
  }
  const t = j.text ?? j.content ?? j.msg ?? j.message ?? j.translateTxt;
  if (typeof t === 'string' && t.trim()) return t;
  if (t && typeof t === 'object' && t.text) return String(t.text);
  if (j.title || j.productName) return `[สินค้า] ${j.title ?? j.productName}`;
  if (j.orderId || j.orderSn) return `[คำสั่งซื้อ] ${j.orderId ?? j.orderSn}`;
  if (j.imageUrl || j.url || j.fileUrl) return '[รูปภาพ]';
  if (j.videoUrl) return '[วิดีโอ]';
  const type = c.lastMessageType ?? c.latestMessageType;
  return type ? `[${type}]` : '';
}

function awaitingReply(c) {
  return Boolean(c.noReplyBuyerMessageTime)
    || Number(c.latestSellerMessageSourceType) === 1
    || Number(c.unReadCount) > 0;
}

function shapeConversation(c, ctl) {
  return {
    id: String(c.conversationId),
    shopId: c.shopId != null ? String(c.shopId) : null,
    shopName: c.shopName ?? null,
    platform: c.platform ?? null,
    buyerName: c.buyerNick ?? c.buyerName ?? null,
    buyerId: c.buyerId != null ? String(c.buyerId) : null,
    avatar: findImage(c, BUYER_IMG),
    shopLogo: (() => { const sh = shopById(c.shopId); return sh ? findImage(sh, SHOP_IMG) : null; })(),
    lastText: lastTextOf(c),
    lastAt: toMs(c.lastMessageTimestamp),
    unread: Number(c.unReadCount) || 0,
    awaiting: (Number(c.unReadCount) || 0) > 0,     // รอตอบ = มีข้อความลูกค้าค้าง (ตัวเลขขึ้น)
    tagIds: (c.tagIdList ?? []).map(String),
    groupId: c.groupId ?? null,
    aiPaused: Boolean(ctl?.aiPaused),
    note: ctl?.note ?? null,
  };
}

// ---- รูปการ์ดสินค้า
// ลำดับการหา: รูปในข้อความเอง → hash รูปของ Shopee → ไฟล์ความรู้ในเครื่อง → ถาม Duoke (แคชไว้)
const IMG_KEY = /img|image|pic|cover|thumb|photo/i;
const SHOPEE_CDN = process.env.SHOPEE_IMG_CDN || 'https://down-th.img.susercontent.com/file/';
const isHash = v => typeof v === 'string' && /^[a-z0-9]{2,}(-[a-z0-9]+)*$/i.test(v) && v.length >= 20 && !/^\d+$/.test(v);

function cardImageOf(c, platform) {
  const url = findImage(c, IMG_KEY, 3);
  if (url) return url;
  // Shopee ส่งมาเป็น hash เช่น "th-11134207-7r98o-lxyz..." ต้องต่อ CDN เอง
  const scan = (o, d) => {
    if (!o || typeof o !== 'object' || d < 0) return null;
    for (const [k, v] of Object.entries(o)) {
      if (IMG_KEY.test(k)) {
        if (isHash(v)) return v;
        if (Array.isArray(v) && isHash(v[0])) return v[0];
      }
      if (v && typeof v === 'object') { const h = scan(v, d - 1); if (h) return h; }
    }
    return null;
  };
  const hash = scan(c, 3);
  if (hash && (!platform || String(platform).toLowerCase() === 'shopee')) return SHOPEE_CDN + hash;
  return null;
}

function shopeeUnknownCard(c) {
  try {
    const outer = typeof c.unknownData === 'string' ? JSON.parse(c.unknownData) : c.unknownData;
    const inner = typeof outer?.message === 'string' ? JSON.parse(outer.message) : outer?.message ?? outer;
    const card = inner?.item_card_v2 ?? inner?.item_card ?? {};
    const itemId = inner?.product_id ?? inner?.item_id ?? card.item_id;
    const title = card.name ?? card.title ?? inner?.name;
    if (!itemId && !title) return null;
    // ราคาใน display_price เป็นหน่วยย่อย (x100000) เหมือนที่ ai-bot.js หารกลับ
    const dp = card.display_price?.discount_price ?? card.display_price?.price;
    const price = dp != null ? Number(dp) / 100000 : card.price;
    return {
      title: title ?? '', itemId: itemId != null ? String(itemId) : null,
      price: price != null ? Number(price) : null,
      currency: card.currency ?? 'THB', option: card.model_name ?? card.sku_name ?? null,
      image: cardImageOf(inner, 'shopee'), url: null,
    };
  } catch { return null; }
}

// รูป/ลิงก์จากไฟล์ knowledge/products/รายละเอียด/<itemId>.md (มีบรรทัด "- รูป:" และ "- ลิงก์:")
function localProductInfo(itemId) {
  if (!/^\d{1,20}$/.test(String(itemId ?? ''))) return null;
  try {
    const body = fs.readFileSync(path.join(KNOWLEDGE_DIR, 'products', 'รายละเอียด', `${itemId}.md`), 'utf8');
    return {
      image: /^-\s*รูป:\s*(\S+)/m.exec(body)?.[1] ?? null,
      url: /^-\s*ลิงก์:\s*(\S+)/m.exec(body)?.[1] ?? null,
      title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null,
    };
  } catch { return null; }
}

// ถาม Duoke ว่าสินค้า itemId นี้รูปอะไร — แคชไว้ 6 ชม. (รวมกรณีหาไม่เจอ จะได้ไม่ยิงซ้ำ)
const productInfoCache = new Map();
async function remoteProductInfo(itemId, shopId, platform) {
  const key = `${shopId}:${itemId}`;
  const hit = productInfoCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.info;
  let info = null;
  try {
    const res = await withDuoke(api => api.getProductList({
      shopId, platform, searchField: 'platform_product_id', searchValue: String(itemId), pageSize: 1,
    }));
    const p = res?.list?.[0];
    if (p) info = { image: p.productImage ?? findImage(p, IMG_KEY), url: p.productUrl ?? null, title: p.productName ?? null };
  } catch { /* ไม่ได้ก็ไม่เป็นไร */ }
  productInfoCache.set(key, { at: Date.now(), info });
  if (productInfoCache.size > 3000) productInfoCache.clear();
  return info;
}

/** เติมรูป/ลิงก์/ชื่อ ให้การ์ดสินค้าที่ยังขาด */
// รูปของการ์ดคำสั่งซื้อ = รูปสินค้าชิ้นแรกในออร์เดอร์ (แคชต่อเลขออร์เดอร์)
const orderImageCache = new Map();
async function orderImageOf(orderId, shopId, platform) {
  const key = `${shopId}:${orderId}`;
  const hit = orderImageCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.info;
  let info = null;
  const fromOrder = async o => {
    const items = o?.productList ?? o?.itemList ?? o?.items ?? o?.orderItemList ?? [];
    for (const p of items) {
      let image = findImage(p, IMG_KEY) ?? cardImageOf(p, platform);
      const itemId = pick(p, 'itemId', 'productId', 'platformProductId', 'platformItemId') ?? null;
      if (!image && itemId) {
        const pi = localProductInfo(itemId)?.image ? localProductInfo(itemId) : await remoteProductInfo(itemId, shopId, platform);
        image = pi?.image ?? null;
      }
      if (image) return { image, itemId, url: productUrlOf(itemId, platform, shopId, pick(p, 'productUrl', 'itemUrl') ?? null) };
    }
    return null;
  };
  try {
    const d = await withDuoke(api => api.getOrderDetail({ shopId, platform, orderNumber: orderId }));
    info = await fromOrder(d?.order ?? d);
  } catch { /* ลองอีกทาง */ }
  if (!info) {
    try {
      const d = await withDuoke(api => api.getConversationOrder({ orderId, platform }));
      info = await fromOrder(d?.order ?? d);
    } catch { /* ไม่ได้ก็ใช้ไอคอน */ }
  }
  orderImageCache.set(key, { at: Date.now(), info });
  if (orderImageCache.size > 3000) orderImageCache.clear();
  return info;
}

async function enrichCards(list, shopId, platform) {
  await Promise.all(list.map(async m => {
    if (m.kind === 'order' && m.card && !m.card.image) {
      let info = null;
      if (m.card.itemId) {
        const local = localProductInfo(m.card.itemId);
        info = local?.image ? local : await remoteProductInfo(m.card.itemId, shopId, platform);
      }
      if (!info?.image && m.card.orderId) info = await orderImageOf(String(m.card.orderId), shopId, platform);
      if (info?.image) { m.card.image = info.image; m.card.url ??= info.url ?? null; }
      return;
    }
    if (m.kind !== 'product' || !m.card?.itemId) return;
    if (m.card.image && m.card.title && m.card.url) return;
    const local = localProductInfo(m.card.itemId);
    const info = (local?.image ? local : null) ?? await remoteProductInfo(m.card.itemId, shopId, platform) ?? local;
    if (!info) return;
    m.card.image ??= info.image ?? null;
    m.card.url ??= info.url ?? null;
    m.card.url = productUrlOf(m.card.itemId, platform, shopId, m.card.url);
    if (!m.card.title) m.card.title = info.title ?? '';
  }));
  return list;
}

/** หา conversationId จาก payload ของ socket (บางครั้งซ้อนเป็น JSON string) */
function findConversationId(o, depth = 4) {
  if (o == null || depth < 0) return null;
  if (typeof o === 'string') {
    if (!/conversationId/.test(o)) return null;
    try { return findConversationId(JSON.parse(o), depth - 1); } catch { return /"conversationId"\s*:\s*"?([\w-]+)/.exec(o)?.[1] ?? null; }
  }
  if (typeof o !== 'object') return null;
  if (o.conversationId) return String(o.conversationId);
  for (const v of Object.values(o)) { const hit = findConversationId(v, depth - 1); if (hit) return hit; }
  return null;
}

// ---- สถานะการส่ง: ข้อความของร้านที่แพลตฟอร์มไม่ยอมรับ (Duoke แสดงเป็นไอคอน error)
// ชื่อฟิลด์ไม่แน่นอน จึงดูจากชื่อ: status/state + fail/error/reason
const FAIL_WORD = /fail|error|reject|block|forbid|violat|invalid|ไม่สำเร็จ|ล้มเหลว/i;
function sendStateOf(m, c) {
  const pools = [m, c, (() => { try { return JSON.parse(m.cloudCustomData ?? 'null'); } catch { return null; } })()].filter(Boolean);
  let reason = null, failed = false, status = null;
  for (const o of pools) {
    for (const [k, v] of Object.entries(o)) {
      if (v == null || v === '' || typeof v === 'object') continue;
      if (/translat|audit|review|recall/i.test(k)) continue;     // สถานะแปลภาษา ฯลฯ ไม่ใช่สถานะการส่ง
      if (/(error|errmsg|errcode|err_?code|err_?msg|fail|reason)/i.test(k) && !/count|time/i.test(k)) {
        if (v === 0 || v === '0' || v === false || v === 'false') continue;
        // "Unsupported" = แปลภาษาไม่ได้ (ฟีเจอร์แปลของ Duoke) ไม่ใช่ส่งไม่สำเร็จ
        if (/^(unsupported|none|null|ok|success)$/i.test(String(v))) continue;
        failed = true;
        if (typeof v === 'string' && v.length > 1 && !/^\d+$/.test(v)) reason ??= v;
        else reason ??= `${k}: ${v}`;
      } else if (/status|state/i.test(k) && !/order|read|online|user|conversation|sub/i.test(k)) {
        status ??= `${k}=${v}`;
        if (typeof v === 'string' && FAIL_WORD.test(v)) failed = true;
        // ค่าติดลบ = ผิดพลาด ในระบบ IM ส่วนใหญ่
        if (Number(v) < 0) failed = true;
      }
    }
  }
  return { failed, reason, status };
}

function shapeMessage(m) {
  const c = parseMessageContent(m) || {};
  const type = String(m.messageType ?? '');
  const fromBuyer = Number(m.fromAccountType) === 1;
  const base = {
    id: String(m.messageId ?? m.id),
    from: fromBuyer ? 'customer' : ai.shopSenderKind(m, duoke.uid),
    sender: m.account ?? null,
    avatar: findImage(m, BUYER_IMG, 0),
    type,
    time: toMs(m.createTime),
    text: null, image: null, card: null,
  };
  // แสดง "ส่งไม่สำเร็จ" เฉพาะข้อความที่ฝั่งเราส่ง (แอดมิน/บอท/AI) — ข้อความอัตโนมัติของแพลตฟอร์มไม่เกี่ยว
  if (!fromBuyer && base.from !== 'platform-bot') {
    const st = sendStateOf(m, c);
    if (st.failed) { base.failed = true; base.failReason = st.reason; }
    base.sendStatus = st.status;
  }
  switch (type) {
    case 'text': case 'attachment_text': case '1':
      return { ...base, kind: 'text', text: c.text ?? '', translated: c.translateTxt ?? null };
    case 'image': case 'file_image': case 'attachment_image': case 'sticker':
      return { ...base, kind: 'image', image: c.imageUrl ?? c.url ?? c.fileUrl ?? null };
    case 'video':
      return { ...base, kind: 'video', image: c.coverUrl ?? null, url: c.videoUrl ?? null };
    case 'item': case 'goods_card': case 'product':
      return { ...base, kind: 'product', card: {
        title: c.title ?? c.productName ?? c.name ?? '', price: c.price ?? null, currency: c.currency ?? null,
        image: cardImageOf(c, m.platform),
        itemId: c.itemId ?? c.productId ?? c.item_id ?? null, url: c.actionUrl ?? c.itemUrl ?? null,
        option: c.skuValue ?? c.skuName ?? null,
      } };
    case 'unknown': {
      // Shopee การ์ดสินค้ารุ่นใหม่ — ห่อ JSON ซ้อนไว้ใน unknownData
      const card = shopeeUnknownCard(c);
      if (card) return { ...base, kind: 'product', card: { ...card, image: card.image ?? cardImageOf(c, 'shopee') } };
      return { ...base, kind: 'other', text: c.text ?? null };
    }
    case 'order': case 'order_card': case '10007':
      return { ...base, kind: 'order', card: {
        orderId: c.orderId ?? c.orderSn ?? c.orderNumber ?? null,
        title: c.productName ?? c.title ?? c.itemTitle ?? '',
        total: c.totalAmount ?? c.price ?? null, currency: c.currency ?? null,
        status: c.statusText ?? c.status ?? null,
        image: cardImageOf(c, m.platform),
        itemId: pick(c, 'itemId', 'productId', 'item_id', 'goodsId') ?? null,
      } };
    default:
      return { ...base, kind: 'other', text: c.text ?? null };
  }
}

async function db() {
  const d = await getDb();
  if (!d) throw httpError(503, 'ยังไม่ได้ต่อฐานข้อมูล — ตั้ง DATABASE_URL ใน .env แล้วรัน npm run db:push');
  return d;
}
/** อ่าน DB แบบไม่บังคับ — ไม่มี DB ก็คืน fallback */
async function dbOptional(fn, fallback) {
  try {
    const d = await getDb();
    return d ? await fn(d) : fallback;
  } catch { return fallback; }
}

// ----------------------------------------------------------- SSE (live push)

const clients = new Set();
function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000).unref();

// ดึงอีเวนต์ใหม่ของบอท (watch.js เขียนลง DB) มาส่งให้หน้าเว็บ
let lastEventId = null;
async function pollBotEvents() {
  await dbOptional(async d => {
    if (lastEventId === null) {
      const last = await d.eventLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      lastEventId = last?.id ?? 0n;
      return;
    }
    const rows = await d.eventLog.findMany({
      where: { id: { gt: lastEventId } }, orderBy: { id: 'asc' }, take: 200,
    });
    for (const r of rows) {
      lastEventId = r.id;
      broadcast('bot_event', serializeEvent(r));
    }
  }, null);
}
setInterval(() => { if (clients.size) pollBotEvents(); }, 2500).unref();

const serializeEvent = r => ({
  id: String(r.id), event: r.event, conversationId: r.conversationId,
  shopName: r.shopName, buyer: r.buyer, payload: r.payload, createdAt: r.createdAt,
});

// -------------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: '2mb' }));

// รหัสผ่าน (ถ้าตั้ง UI_PASSWORD)
app.use('/api', (req, res, next) => {
  if (!PASSWORD) return next();
  const key = req.get('x-ui-key') ?? req.query.key;
  if (key === PASSWORD) return next();
  res.status(401).json({ error: 'ต้องใส่รหัสผ่าน UI' });
});

const route = fn => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    const status = err.status ?? (isAuthError(err) ? 401 : 500);
    if (status >= 500 && status !== 503) console.error(`⚠️  ${req.method} ${req.path}:`, err.message);
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
};

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ state: duoke.state })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---- สถานะระบบ
app.get('/api/status', route(async () => {
  let dbOk = false, dbError = null, botReady = null;
  if (dbEnabled()) {
    try {
      const d = await db();
      await d.$queryRaw`SELECT 1`;
      dbOk = true;
      botReady = await d.eventLog.findFirst({
        where: { event: { in: ['ready', 'socket', 'relogin', 'token_shared'] } },
        orderBy: { id: 'desc' },
      });
    } catch (err) { dbError = err.message.split('\n').slice(-1)[0]; }
  }
  const p = ai.providerInfo();
  return {
    duoke: {
      state: duoke.state, error: duoke.error,
      account: duoke.user?.email ?? duoke.user?.account ?? null,
      shops: duoke.shops.map(shapeShop),
    },
    db: { enabled: dbEnabled(), ok: dbOk, error: dbError },
    ai: { enabled: ai.isEnabled(), autoSend: ai.autoSend(), provider: p.provider, model: p.model, knowledgeFiles: ai.knowledgeInfo().count },
    bot: botReady ? serializeEvent(botReady) : null,
    passwordRequired: Boolean(PASSWORD),
    brand: { name: process.env.UI_BRAND_NAME || 'Duoke Desk', logo: process.env.UI_LOGO_URL || (fs.existsSync(path.join(__dirname, 'branding', 'logo.png')) ? '/branding/logo.png' : null) },
  };
}));

app.get('/api/shops', route(async () => duoke.shops.map(shapeShop)));

// ตรวจชื่อฟิลด์ที่ Duoke ส่งมาจริง (ไม่ส่งค่า) — ใช้หาว่ารูปลูกค้า/โลโก้ร้านอยู่ฟิลด์ไหน
app.get('/api/debug/fields', route(async req => {
  const keysOf = (o, pre = '') => Object.entries(o ?? {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? [`${pre}${k}{}`, ...keysOf(v, `${pre}${k}.`)] : [`${pre}${k}`]);
  // ?c=<conversationId> — เจาะห้องที่ต้องการ (ดู conversationId ได้จากแท็บโน้ตของห้องนั้น)
  const res = await withDuoke(api => api.queryConversationList({ shopIdList: duoke.shops.map(s => s.id ?? s.shopId), size: req.query.c ? 100 : 1, offset: 0 }));
  const c = (req.query.c && res?.list?.find(x => String(x.conversationId) === String(req.query.c))) || res?.list?.[0];
  let m = null;
  if (c) {
    const h = await withDuoke(api => api.getMessageList({ shopId: c.shopId, conversationId: c.conversationId, platform: c.platform, pageSize: 5 }));
    m = (h?.list ?? []).find(x => Number(x.fromAccountType) === 1) ?? h?.list?.[0];
  }
  // ค่าฟิลด์สถานะ/ข้อผิดพลาดของข้อความฝั่งร้านล่าสุด (ไม่มีเนื้อหาข้อความ) — ใช้หาว่า "ส่งไม่สำเร็จ" อยู่ฟิลด์ไหน
  let shopMsgStatus = [];
  if (c) {
    const h = await withDuoke(api => api.getMessageList({ shopId: c.shopId, conversationId: c.conversationId, platform: c.platform, pageSize: 30 }));
    shopMsgStatus = (h?.list ?? []).filter(x => Number(x.fromAccountType) !== 1).slice(0, 10).map(x =>
      Object.fromEntries(Object.entries(x).filter(([k, v]) => /status|state|err|fail|reason|source|type/i.test(k) && typeof v !== 'object')));
  }
  // ชื่อฟิลด์ในการ์ดสินค้า/ออร์เดอร์ที่ลูกค้าส่งมา (ไม่มีค่า) — ใช้หาช่องรูป
  let cardSamples = [];
  if (c) {
    const h = await withDuoke(api => api.getMessageList({ shopId: c.shopId, conversationId: c.conversationId, platform: c.platform, pageSize: 50 }));
    cardSamples = (h?.list ?? []).filter(x => /item|goods|product|order|unknown|10007/i.test(String(x.messageType))).slice(0, 5)
      .map(x => ({ type: x.messageType, fields: keysOf(parseMessageContent(x)) }));
  }
  return {
    shopMsgStatus, cardSamples,
    conversation: keysOf(c), shop: keysOf(duoke.shops[0]), user: keysOf(duoke.user), message: keysOf(m),
    found: { buyerAvatar: findImage(c, BUYER_IMG), shopLogo: findImage(duoke.shops[0], SHOP_IMG) },
  };
}));

app.get('/api/tags', route(async () =>
  duoke.tags.map(t => ({ id: String(t.id), name: t.tagName, color: t.tagColor ?? 'blue' }))));

// ---- สรุปกล่องแชท (คอลัมน์ร้าน + แถบสถิติ)
app.get('/api/inbox/summary', route(async () => {
  const shopIds = duoke.shops.map(s => s.id ?? s.shopId);
  const res = await withDuoke(api => api.queryConversationList({ shopIdList: shopIds, size: 100, offset: 0 }));
  const list = res?.list ?? [];
  const byShop = new Map(duoke.shops.map(s => [String(s.id ?? s.shopId), {
    ...shapeShop(s), unread: 0, awaiting: 0,
  }]));
  let unread = 0, awaiting = 0;
  for (const c of list) {
    const row = byShop.get(String(c.shopId));
    const u = Number(c.unReadCount) || 0;
    const w = u > 0 ? 1 : 0;
    unread += u; awaiting += w;
    if (row) { row.unread += u; row.awaiting += w; }
  }
  const aiToday = await dbOptional(d => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return d.aiReply.count({ where: { createdAt: { gte: t } } });
  }, null);
  const staffToday = await dbOptional(d => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return d.staffReply.count({ where: { createdAt: { gte: t } } });
  }, null);
  return { shops: [...byShop.values()], unread, awaiting, total: list.length, aiToday, staffToday };
}));

// ---- ห้องแชท
app.get('/api/conversations', route(async req => {
  const size = Math.min(Number(req.query.size) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  const shopIds = req.query.shopId ? [String(req.query.shopId)] : duoke.shops.map(s => s.id ?? s.shopId);
  const filter = String(req.query.filter || 'all');
  const pending = filter === 'awaiting' || filter === 'unread';
  let res, list;
  if (pending) {
    // รอตอบ = เฉพาะห้องที่มีตัวเลขข้อความลูกค้าค้าง — ไล่หลายหน้าเพราะห้องค้างอาจอยู่ลึก
    list = [];
    for (let page = 0; page < 6; page++) {
      res = await withDuoke(api => api.queryConversationList({ shopIdList: shopIds, size: 100, offset: page * 100 }));
      const rows = res?.list ?? [];
      list.push(...rows.filter(c => Number(c.unReadCount) > 0));
      if (rows.length < 100 || !res?.hasMore) break;
    }
    res = { hasMore: false, list };
  } else {
    res = await withDuoke(api => api.queryConversationList({ shopIdList: shopIds, size, offset }));
    list = res?.list ?? [];
  }
  if (req.query.tagId) list = list.filter(c => (c.tagIdList ?? []).map(String).includes(String(req.query.tagId)));
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) list = list.filter(c => `${c.buyerNick ?? ''} ${lastTextOf(c)}`.toLowerCase().includes(q));

  const ids = list.map(c => String(c.conversationId));
  const ctl = await dbOptional(d => d.conversation.findMany({
    where: { id: { in: ids } }, select: { id: true, aiPaused: true, note: true },
  }), []);
  const byId = new Map(ctl.map(r => [r.id, r]));

  return {
    list: list.map(c => shapeConversation(c, byId.get(String(c.conversationId)))),
    hasMore: !pending && (Boolean(res?.hasMore) || (res?.list?.length ?? 0) >= size),
    nextOffset: offset + size,
  };
}));

app.get('/api/conversations/:id', route(async req => {
  const ctl = await dbOptional(d => d.conversation.findUnique({ where: { id: req.params.id } }), null);
  // เปิดจากลิงก์ที่ไม่มี shopId/platform (เช่น หน้า Log) → ใช้ค่าที่บอทเคยบันทึกไว้
  const shopId = req.query.shopId || ctl?.shopId;
  const platform = req.query.platform || ctl?.platform;
  if (!shopId || !platform) throw httpError(404, 'ไม่รู้ว่าห้องนี้อยู่ร้านไหน');
  const v = await withDuoke(api => api.viewConversation({ shopId, conversationId: req.params.id, platform }));
  const info = v?.dkConversationVO ?? v ?? {};
  return shapeConversation({ conversationId: req.params.id, shopId, platform, ...info,
    buyerNick: info.buyerNick ?? ctl?.buyerName }, ctl);
}));

app.get('/api/conversations/:id/messages', route(async req => {
  const { shopId, platform, before } = req.query;
  const res = await withDuoke(api => api.getMessageList({
    shopId, conversationId: req.params.id, platform,
    pageNo: 1, pageSize: Math.min(Number(req.query.size) || 40, 100),
    createTimeStampBefore: before || undefined,
  }));
  const pageSize = Math.min(Number(req.query.size) || 40, 100);
  const list = await enrichCards((res?.list ?? []).slice().reverse().map(shapeMessage), shopId, platform);

  // ข้อความที่ส่งจากบัญชีเดียวกับบอท Duoke เห็นเป็น "me" ทั้งหมด — แยกให้ว่าอันไหน AI ตอบ อันไหนแอดมินส่งจาก UI
  const mine = list.filter(m => m.from === 'me' && m.text);
  if (mine.length) {
    const [aiRows, staffRows] = await Promise.all([
      dbOptional(d => d.aiReply.findMany({ where: { conversationId: req.params.id, reply: { not: null } }, select: { id: true, reply: true }, orderBy: { createdAt: 'desc' }, take: 100 }), []),
      dbOptional(d => d.staffReply.findMany({ where: { conversationId: req.params.id, kind: 'text' }, select: { text: true }, orderBy: { createdAt: 'desc' }, take: 100 }), []),
    ]);
    const norm = t => String(t ?? '').replace(/\s+/g, '');
    const aiSet = new Map(aiRows.map(r => [norm(r.reply), r.id]));
    const staffSet = new Set(staffRows.map(r => norm(r.text)));
    for (const m of mine) {
      const k = norm(m.text);
      if (staffSet.has(k)) m.from = 'ui';
      else if (aiSet.has(k)) { m.from = 'ai'; m.aiReplyId = aiSet.get(k); }
    }
  }
  return { list, hasMore: (res?.list?.length ?? 0) >= pageSize };
}));

// ตอบลูกค้า
app.post('/api/conversations/:id/reply', route(async req => {
  const { shopId, platform, text, aiReplyId } = req.body ?? {};
  const body = String(text ?? '').trim();
  if (!body) throw httpError(400, 'ยังไม่ได้พิมพ์ข้อความ');
  if (!shopId || !platform) throw httpError(400, 'ต้องมี shopId และ platform');
  const conversationId = req.params.id;

  // เขียน "แอดมินตอบแล้ว" ก่อนส่ง — กันบอทร่างทับในจังหวะเดียวกัน
  await dbOptional(d => d.conversation.upsert({
    where: { id: conversationId },
    create: { id: conversationId, shopId: String(shopId), platform, lastStaffReplyAt: new Date() },
    update: { lastStaffReplyAt: new Date() },
  }), null);

  let ok = true, error = null;
  try {
    const { text: safe } = ai.sanitizeForPlatform(body, platform);
    await withDuoke((_, rt) => rt.sendText({ shopId, conversationId, platform, text: safe, puid: duoke.puid }));
  } catch (err) { ok = false; error = err.message; }

  await dbOptional(async d => {
    await d.staffReply.create({ data: {
      conversationId, shopId: String(shopId), platform, text: body, ok, error, aiReplyId: aiReplyId ?? null,
    } });
    if (aiReplyId) await d.aiReply.update({ where: { id: aiReplyId }, data: { reviewed: true, reviewedAt: new Date() } }).catch(() => {});
  }, null);

  if (!ok) throw httpError(502, `ส่งไม่สำเร็จ: ${error}`);
  broadcast('message', { conversationId, shopId, platform });
  watchDelivery({ conversationId, shopId, platform, text: body });
  return { ok: true };
}));

/**
 * ส่งผ่าน socket สำเร็จ ≠ ลูกค้าได้รับ — แพลตฟอร์มอาจตีกลับทีหลัง (คำต้องห้าม ลิงก์ ข้อมูลส่วนตัว ฯลฯ)
 * จึงแวะเช็คข้อความล่าสุดอีก 2 รอบ ถ้าพบว่าไม่สำเร็จ → แจ้งหน้าเว็บ + บันทึกใน DB
 */
function watchDelivery({ conversationId, shopId, platform, text, kind = 'text' }) {
  const norm = t => String(t ?? '').replace(/\s+/g, '');
  const want = norm(text);
  for (const delay of [3000, 12000]) {
    setTimeout(async () => {
      try {
        const res = await withDuoke(api => api.getMessageList({ shopId, conversationId, platform, pageNo: 1, pageSize: 15 }));
        const mine = (res?.list ?? []).map(shapeMessage).filter(m => m.from !== 'customer');
        const hit = kind === 'text' ? mine.find(m => norm(m.text) === want || (want && norm(m.text).includes(want.slice(0, 30)))) : mine[0];
        if (!hit?.failed) return;
        broadcast('send_failed', { conversationId, messageId: hit.id, text: String(text ?? '').slice(0, 80), reason: hit.failReason });
        await dbOptional(d => d.staffReply.updateMany({
          where: { conversationId, text, ok: true, createdAt: { gte: new Date(Date.now() - 60_000) } },
          data: { ok: false, error: hit.failReason ?? 'แพลตฟอร์มปฏิเสธข้อความ' },
        }), null);
      } catch { /* เช็คไม่ได้ก็ไม่เป็นไร */ }
    }, delay).unref?.();
  }
}

// ส่งการ์ดสินค้า
app.post('/api/conversations/:id/product', route(async req => {
  const { shopId, platform, itemId } = req.body ?? {};
  if (!itemId) throw httpError(400, 'ต้องมี itemId');
  const conversationId = req.params.id;
  await withDuoke((_, rt) => rt.sendProduct({ shopId, conversationId, platform, itemId: String(itemId), puid: duoke.puid }));
  await dbOptional(d => d.staffReply.create({ data: {
    conversationId, shopId: String(shopId), platform, kind: 'product', itemId: String(itemId),
  } }), null);
  broadcast('message', { conversationId, shopId, platform });
  watchDelivery({ conversationId, shopId, platform, kind: 'product' });
  return { ok: true };
}));

// แท็ก — เพิ่ม (ไม่ลบของเดิม) / เอาออก
app.post('/api/conversations/:id/tags', route(async req => {
  const { shopId, platform, tagId } = req.body ?? {};
  const tagIdList = await withDuoke(api => api.addTagToConversation({
    shopId, conversationId: req.params.id, platform, tagId: Number(tagId) || tagId,
  }));
  return { tagIds: tagIdList.map(String) };
}));
app.delete('/api/conversations/:id/tags/:tagId', route(async req => {
  const { shopId } = req.query;
  await withDuoke(api => api.deleteConversationTag({
    shopId, conversationId: req.params.id, tagId: Number(req.params.tagId) || req.params.tagId,
  }));
  return { ok: true };
}));

// ปิด/เปิด AI รายห้อง + โน้ตลูกค้า
app.patch('/api/conversations/:id/control', route(async req => {
  const d = await db();
  const { aiPaused, note, shopId, platform, buyerName, shopName } = req.body ?? {};
  const data = {};
  if (typeof aiPaused === 'boolean') data.aiPaused = aiPaused;
  if (note !== undefined) data.note = note ? String(note) : null;
  const meta = {
    shopId: shopId ? String(shopId) : undefined, platform: platform ?? undefined,
    buyerName: buyerName ?? undefined, shopName: shopName ?? undefined,
  };
  const row = await d.conversation.upsert({
    where: { id: req.params.id },
    create: { id: req.params.id, ...meta, ...data },
    update: { ...meta, ...data },
  });
  return { aiPaused: row.aiPaused, note: row.note };
}));

// ออร์เดอร์ของลูกค้า
app.get('/api/conversations/:id/orders', route(async req => {
  const { shopId, platform, buyerId } = req.query;
  if (!buyerId) return { list: [] };
  const res = await withDuoke(api => api.getOrderList({ shopId, buyerId, platform, pageSize: 10 }));
  const list = (res?.list ?? []).map(o => ({
      orderNumber: o.orderNumber, status: o.platformOrderStatus,
      createdAt: toMs(o.platformCreateTime), amount: o.amount, currency: o.currency,
      paidAt: toMs(pick(o, 'platformPayTime', 'payTime', 'paidTime')),
      paymentMethod: pick(o, 'paymentMethod', 'paymentMethodName', 'payMethod') ?? null,
      buyerNote: pick(o, 'buyerMessage', 'buyerNote', 'remark') ?? null,
      products: (o.productList ?? []).map(p => ({
        name: p.productName, option: p.variation ?? null, sku: pick(p, 'variationSku', 'sku', 'productSku') ?? null,
        quantity: p.quantity, price: p.price,
        image: findImage(p, IMG_KEY) ?? cardImageOf(p, platform),
        itemId: pick(p, 'itemId', 'productId', 'platformProductId', 'platformItemId') ?? null,
        url: pick(p, 'productUrl', 'itemUrl', 'link') ?? null,
      })),
      logistics: o.logistics ? {
        name: o.logistics.logisticsServiceName ?? null,
        tracking: [].concat(o.logistics.trackingNumber ?? []).filter(Boolean),
      } : null,
    }));
  // สินค้าในออร์เดอร์ที่ไม่มีรูปมาให้ → หาจากไฟล์ความรู้ / Duoke เหมือนการ์ดสินค้า
  await Promise.all(list.flatMap(o => o.products).map(async p => {
    if (p.image || !p.itemId) return;
    const info = localProductInfo(p.itemId)?.image ? localProductInfo(p.itemId) : await remoteProductInfo(p.itemId, shopId, platform);
    p.image = info?.image ?? null;
    p.url ??= info?.url ?? null;
  }));
  for (const p of list.flatMap(o => o.products)) p.url = productUrlOf(p.itemId, platform, shopId, p.url);
  return { list };
}));

// ---- ลิงก์หน้าสินค้าบนแพลตฟอร์ม
function productUrlOf(itemId, platform, shopId, given) {
  if (given) return given;
  if (!itemId) return null;
  const local = localProductInfo(itemId);
  if (local?.url) return local.url;
  const sh = shopById(shopId);
  const pShop = pick(sh ?? {}, 'platformShopId', 'sellerId', 'platformSellerId', 'outShopId', 'shopeeShopId');
  switch (String(platform ?? '').toLowerCase()) {
    case 'shopee': return pShop ? `https://shopee.co.th/product/${pShop}/${itemId}` : `https://shopee.co.th/search?keyword=${itemId}`;
    case 'lazada': return `https://www.lazada.co.th/products/i${itemId}.html`;
    case 'tiktok': return `https://shop.tiktok.com/view/product/${itemId}`;
    default: return null;
  }
}

// ---- รายละเอียดคำสั่งซื้อแบบเต็ม
// Duoke คืนฟิลด์ต่างกันตามแพลตฟอร์ม → แสดงทุกช่องที่มีค่า แปลชื่อช่องที่รู้จักเป็นไทย
const ORDER_LABEL = {
  orderNumber: 'เลขคำสั่งซื้อ', platformOrderStatus: 'สถานะ', orderStatus: 'สถานะ', platformCreateTime: 'สั่งเมื่อ',
  platformPayTime: 'ชำระเมื่อ', payTime: 'ชำระเมื่อ', platformUpdateTime: 'อัปเดตล่าสุด', shipByDate: 'ต้องส่งภายใน',
  amount: 'ยอดชำระ', totalAmount: 'ยอดรวม', payAmount: 'ยอดชำระ', productAmount: 'ค่าสินค้า', subtotal: 'ค่าสินค้า',
  shippingFee: 'ค่าส่ง', actualShippingFee: 'ค่าส่งจริง', estimatedShippingFee: 'ค่าส่ง (ประมาณ)', buyerShippingFee: 'ค่าส่งที่ลูกค้าจ่าย',
  discount: 'ส่วนลด', voucher: 'คูปอง', voucherAmount: 'คูปอง', sellerDiscount: 'ส่วนลดร้าน', platformDiscount: 'ส่วนลดแพลตฟอร์ม',
  coin: 'Coins', commissionFee: 'ค่าคอมมิชชัน', serviceFee: 'ค่าบริการ', transactionFee: 'ค่าธรรมเนียม', escrowAmount: 'เงินที่ร้านได้รับ',
  currency: 'สกุลเงิน', paymentMethod: 'วิธีชำระเงิน', paymentMethodName: 'วิธีชำระเงิน', cod: 'เก็บเงินปลายทาง',
  buyerMessage: 'หมายเหตุผู้ซื้อ', buyerNote: 'หมายเหตุผู้ซื้อ', sellerNote: 'หมายเหตุผู้ขาย', remark: 'หมายเหตุ', note: 'หมายเหตุ',
  buyerName: 'ผู้ซื้อ', buyerUsername: 'ผู้ซื้อ', receiverName: 'ผู้รับ', name: 'ชื่อ', receiverPhone: 'เบอร์ผู้รับ', phone: 'เบอร์โทร',
  fullAddress: 'ที่อยู่', address: 'ที่อยู่', address1: 'ที่อยู่', district: 'อำเภอ/เขต', city: 'จังหวัด', province: 'จังหวัด',
  state: 'จังหวัด', town: 'ตำบล/แขวง', zipcode: 'รหัสไปรษณีย์', postCode: 'รหัสไปรษณีย์', region: 'ประเทศ',
  logisticsServiceName: 'บริการขนส่ง', shippingCarrier: 'ขนส่ง', trackingNumber: 'เลขพัสดุ', logisticsStatus: 'สถานะขนส่ง',
  cancelReason: 'เหตุผลยกเลิก', cancelBy: 'ยกเลิกโดย', returnReason: 'เหตุผลคืนสินค้า', invoice: 'ใบกำกับภาษี',
};
const ORDER_GROUP = [
  ['คำสั่งซื้อ', /orderNumber|orderSn|orderId|status$/i],
  ['สรุปยอด', /amount|fee|discount|voucher|coin|price|currency|payment|(^|\.)cod$|escrow|subtotal|tax|refund/i],
  ['การจัดส่ง', /logistic|shipping|tracking|carrier|ship|package|delivery|warehouse/i],
  ['ผู้รับ / ที่อยู่', /receiver|recipient|address|phone|district|city|province|town|zip|post|region|country|(^|\.)name$|(^|\.)state$/i],
  ['เวลา', /time|date/i],
  ['หมายเหตุ', /note|message|remark|reason|cancel|return|invoice/i],
];
const SKIP_ORDER_KEY = /^(productList|itemList|items|orderItemList|skuList)$|image|img|icon|token|sign|^id$|shopId|puid|uid$/i;

function flattenOrder(o, prefix = '', out = [], depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_ORDER_KEY.test(k) || v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length && v.every(x => typeof x !== 'object')) out.push({ key: prefix + k, name: k, value: v.join(', ') });
      continue;
    }
    if (typeof v === 'object') { flattenOrder(v, `${prefix}${k}.`, out, depth + 1); continue; }
    let value = v;
    if (/time|date/i.test(k) && toMs(v) && String(v).length >= 10) value = new Date(toMs(v)).toISOString();
    if (typeof value === 'string' && value.length > 400) value = value.slice(0, 400) + '…';
    out.push({ key: prefix + k, name: k, value });
  }
  return out;
}

app.get('/api/orders/:orderNumber', route(async req => {
  const { shopId, platform } = req.query;
  const orderNumber = req.params.orderNumber;
  const [detail, logistic] = await Promise.all([
    withDuoke(api => api.getOrderDetail({ shopId, platform, orderNumber })).catch(err => { throw httpError(502, `ดึงรายละเอียดไม่ได้: ${err.message}`); }),
    Promise.resolve(null),
  ]);
  const o = detail?.order ?? detail ?? {};
  const itemsRaw = o.productList ?? o.itemList ?? o.items ?? o.orderItemList ?? [];
  const items = await Promise.all(itemsRaw.map(async p => {
    const itemId = pick(p, 'itemId', 'productId', 'platformProductId', 'platformItemId', 'item_id') ?? null;
    let image = findImage(p, IMG_KEY) ?? cardImageOf(p, platform);
    let url = pick(p, 'productUrl', 'itemUrl', 'link', 'url') ?? null;
    if ((!image || !url) && itemId) {
      const info = localProductInfo(itemId)?.image ? localProductInfo(itemId) : await remoteProductInfo(itemId, shopId, platform);
      image ??= info?.image ?? null;
      url ??= info?.url ?? null;
    }
    return {
      itemId, name: p.productName ?? p.itemName ?? p.name ?? '',
      option: p.variation ?? p.skuName ?? p.modelName ?? null,
      sku: pick(p, 'variationSku', 'sku', 'productSku', 'sellerSku') ?? null,
      quantity: p.quantity ?? p.qty ?? 1,
      price: p.price ?? p.itemPrice ?? p.salePrice ?? null,
      originalPrice: p.originalPrice ?? null,
      image, url: productUrlOf(itemId, platform, shopId, url),
    };
  }));
  const fields = flattenOrder(o).map(f => ({ ...f, label: ORDER_LABEL[f.name] ?? null }));
  const groups = ORDER_GROUP.map(([title, re]) => ({ title, fields: [] }));
  const other = { title: 'ข้อมูลอื่น ๆ', fields: [] };
  for (const f of fields) {
    const i = ORDER_GROUP.findIndex(([, re]) => re.test(f.key));
    (i >= 0 ? groups[i] : other).fields.push(f);
  }
  return {
    orderNumber, status: o.platformOrderStatus ?? o.orderStatus ?? null,
    currency: o.currency ?? 'THB', items,
    groups: [...groups, other].filter(g => g.fields.length),
    logistic,
  };
}));

// โปรไฟล์ลูกค้า — สรุปจากคำสั่งซื้อ + ประวัติในฐานข้อมูล
app.get('/api/conversations/:id/profile', route(async req => {
  const { shopId, platform, buyerId } = req.query;
  let orders = [];
  if (buyerId) {
    try {
      const res = await withDuoke(api => api.getOrderList({ shopId, buyerId, platform, pageSize: 50 }));
      orders = res?.list ?? [];
    } catch { /* ดึงไม่ได้ก็สรุปเท่าที่มี */ }
  }
  const ok = orders.filter(o => !['CANCELLED', 'IN_CANCEL', 'INVALID', 'UNPAID', 'TO_PAY'].includes(o.platformOrderStatus));
  const times = orders.map(o => toMs(o.platformCreateTime)).filter(Boolean).sort((a, b) => a - b);
  const counts = await dbOptional(async d => {
    const [aiCount, staffCount, row] = await Promise.all([
      d.aiReply.count({ where: { conversationId: req.params.id } }),
      d.staffReply.count({ where: { conversationId: req.params.id } }),
      d.conversation.findUnique({ where: { id: req.params.id }, select: { createdAt: true } }),
    ]);
    return { aiCount, staffCount, firstSeen: row?.createdAt ?? null };
  }, { aiCount: null, staffCount: null, firstSeen: null });
  return {
    orders: orders.length,
    completed: ok.length,
    spent: ok.reduce((a, o) => a + (Number(o.amount) || 0), 0),
    currency: orders[0]?.currency ?? 'THB',
    firstOrderAt: times[0] ?? null,
    lastOrderAt: times[times.length - 1] ?? null,
    cancelled: orders.filter(o => ['CANCELLED', 'IN_CANCEL'].includes(o.platformOrderStatus)).length,
    ...counts,
  };
}));

// ประวัติที่ AI ตอบในห้องนี้
app.get('/api/conversations/:id/ai-replies', route(async req =>
  dbOptional(d => d.aiReply.findMany({
    where: { conversationId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 30,
  }), [])));

// ---- สินค้า
app.get('/api/products', route(async req => {
  const { shopId, platform } = req.query;
  const q = String(req.query.q || '').trim();
  const page = Number(req.query.page) || 1;
  const res = await withDuoke(api => api.getProductList({
    shopId, platform, pageNo: page, pageSize: 20,
    ...(q ? (/^\d{5,}$/.test(q)
      ? { searchField: 'platform_product_id', searchValue: q }
      : { searchField: 'platform_product_name', searchValue: q }) : {}),
  }));
  return {
    total: res?.total ?? 0,
    list: (res?.list ?? []).map(p => ({
      itemId: String(p.productId ?? p.platformProductId),
      name: p.productName,
      image: p.productImage ?? null,
      minPrice: p.productMinPrice, maxPrice: p.productMaxPrice,
      currency: p.productCurrency, stock: p.productStock,
      status: p.platformProductStatus, url: productUrlOf(String(p.productId ?? p.platformProductId), platform, shopId, p.productUrl), sku: p.productSku ?? null,
    })),
  };
}));

// ค้นจากคลังสินค้าในเครื่อง (knowledge/products/catalog.tsv) — ไม่ยิง API
app.get('/api/catalog', route(async req => {
  const q = String(req.query.q || '').trim();
  if (!q) return [];
  return ai.searchProducts(q, 20).map(r => ({
    itemId: r.id, name: r.name, category: r.cat, sub: r.sub, brand: r.brand, options: r.opts,
    detail: ai.loadProductDetail(r.id) || null,
  }));
}));

// ---- AI ตอบ (ประวัติ)
app.get('/api/ai-replies', route(async req => {
  const d = await db();
  const take = Math.min(Number(req.query.size) || 30, 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const where = {};
  if (req.query.status) where.status = { in: String(req.query.status).split(',') };
  if (req.query.reviewed === 'true') where.reviewed = true;
  if (req.query.reviewed === 'false') where.reviewed = false;
  if (req.query.rating) where.rating = req.query.rating === 'none' ? null : String(req.query.rating);
  if (req.query.conversationId) where.conversationId = String(req.query.conversationId);
  if (req.query.from || req.query.to) {
    where.createdAt = {};
    if (req.query.from) where.createdAt.gte = new Date(String(req.query.from));
    if (req.query.to) where.createdAt.lte = new Date(String(req.query.to));
  }
  const q = String(req.query.q || '').trim();
  if (q) where.OR = ['question', 'reply', 'buyerName', 'reason'].map(k => ({ [k]: { contains: q, mode: 'insensitive' } }));

  const [total, list] = await Promise.all([
    d.aiReply.count({ where }),
    d.aiReply.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: (page - 1) * take }),
  ]);
  return { total, page, pages: Math.max(1, Math.ceil(total / take)), list };
}));

app.patch('/api/ai-replies/:id', route(async req => {
  const d = await db();
  const { reviewed, rating, reviewNote } = req.body ?? {};
  const data = {};
  if (typeof reviewed === 'boolean') { data.reviewed = reviewed; data.reviewedAt = reviewed ? new Date() : null; }
  if (rating !== undefined) { data.rating = rating || null; data.reviewed = true; data.reviewedAt = new Date(); }
  if (reviewNote !== undefined) data.reviewNote = reviewNote || null;
  return d.aiReply.update({ where: { id: req.params.id }, data });
}));

app.post('/api/ai-replies/mark-all-reviewed', route(async () => {
  const d = await db();
  const r = await d.aiReply.updateMany({ where: { reviewed: false }, data: { reviewed: true, reviewedAt: new Date() } });
  return { count: r.count };
}));

// เอาคำตอบที่ดีไปเป็นตัวอย่างให้ AI (knowledge/admin-examples.json)
app.post('/api/ai-replies/:id/example', route(async req => {
  const d = await db();
  const row = await d.aiReply.findUnique({ where: { id: req.params.id } });
  if (!row?.question || !row?.reply) throw httpError(400, 'ต้องมีทั้งคำถามและคำตอบ');
  const q = String(req.body?.question ?? row.question).replace(/\s+/g, ' ').trim();
  const a = String(req.body?.answer ?? row.reply).replace(/\s+/g, ' ').trim();
  const file = path.join(KNOWLEDGE_DIR, 'admin-examples.json');
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(rows)) rows = [];
  if (!rows.some(r => r.q === q && r.a === a)) rows.push({ q, a });
  fs.writeFileSync(file + '.tmp', JSON.stringify(rows.slice(-150), null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
  await d.aiReply.update({ where: { id: row.id }, data: { rating: 'good', reviewed: true, reviewedAt: new Date() } });
  return { ok: true, total: rows.length };
}));

// ---- สถิติ
app.get('/api/stats', route(async req => {
  const d = await db();
  const days = Math.min(Number(req.query.days) || 7, 60);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const [daily, byStatus, staffToday, msgToday, unreviewed, bad] = await Promise.all([
    d.$queryRaw`
      SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD') AS day,
             status, count(*)::int AS n
      FROM "AiReply" WHERE "createdAt" >= ${since}
      GROUP BY 1, 2 ORDER BY 1`,
    d.aiReply.groupBy({ by: ['status'], where: { createdAt: { gte: today } }, _count: { _all: true } }),
    d.staffReply.count({ where: { createdAt: { gte: today } } }),
    d.message.count({ where: { createdAt: { gte: today }, fromKind: 'customer' } }),
    d.aiReply.count({ where: { reviewed: false } }),
    d.aiReply.count({ where: { rating: 'bad' } }),
  ]);
  return {
    daily,
    today: Object.fromEntries(byStatus.map(r => [r.status, r._count._all])),
    staffToday, messagesToday: msgToday, unreviewed, bad,
  };
}));

// ---- คำตอบสำเร็จรูป
app.get('/api/quick-replies', route(async () =>
  dbOptional(d => d.quickReply.findMany({ orderBy: [{ sortOrder: 'asc' }, { useCount: 'desc' }, { createdAt: 'asc' }] }), [])));
app.post('/api/quick-replies', route(async req => {
  const d = await db();
  const { title, text, shortcut } = req.body ?? {};
  if (!title || !text) throw httpError(400, 'ต้องมีชื่อและข้อความ');
  return d.quickReply.create({ data: { title, text, shortcut: shortcut || null } });
}));
app.patch('/api/quick-replies/:id', route(async req => {
  const d = await db();
  const { title, text, shortcut, sortOrder } = req.body ?? {};
  return d.quickReply.update({ where: { id: req.params.id }, data: {
    ...(title !== undefined && { title }), ...(text !== undefined && { text }),
    ...(shortcut !== undefined && { shortcut: shortcut || null }),
    ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
  } });
}));
app.post('/api/quick-replies/:id/use', route(async req => {
  const d = await db();
  await d.quickReply.update({ where: { id: req.params.id }, data: { useCount: { increment: 1 } } });
}));
app.delete('/api/quick-replies/:id', route(async req => {
  const d = await db();
  await d.quickReply.delete({ where: { id: req.params.id } });
}));

// ---- log อีเวนต์ของบอท
app.get('/api/events', route(async req => {
  const d = await db();
  const where = {};
  if (req.query.event) where.event = { in: String(req.query.event).split(',') };
  if (req.query.conversationId) where.conversationId = String(req.query.conversationId);
  const rows = await d.eventLog.findMany({
    where, orderBy: { id: 'desc' }, take: Math.min(Number(req.query.size) || 100, 300),
    ...(req.query.before ? { cursor: { id: BigInt(req.query.before) }, skip: 1 } : {}),
  });
  return rows.map(serializeEvent);
}));

// ---- ความรู้ของ AI (knowledge/)
const KNOW_EXT = ['.md', '.txt', '.json', '.csv'];
function safeKnowledgePath(rel) {
  const full = path.resolve(KNOWLEDGE_DIR, String(rel ?? ''));
  if (!full.startsWith(path.resolve(KNOWLEDGE_DIR) + path.sep)) throw httpError(400, 'path ไม่ถูกต้อง');
  if (!KNOW_EXT.includes(path.extname(full).toLowerCase())) throw httpError(400, 'แก้ได้เฉพาะ .md .txt .json .csv');
  return full;
}
app.get('/api/knowledge', route(async () => {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'รายละเอียด') continue;           // รายละเอียดสินค้าหลายร้อยไฟล์ ค้นผ่านหน้า "สินค้า" แทน
        if (depth < 2) walk(path.join(dir, e.name), r, depth + 1);
      } else if (KNOW_EXT.includes(path.extname(e.name).toLowerCase()) && !e.name.endsWith('.tsv')) {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ path: r, folder: rel || '', name: e.name, size: st.size, updatedAt: st.mtimeMs });
      }
    }
  };
  walk(KNOWLEDGE_DIR, '', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path, 'th'));
}));
app.get('/api/knowledge/file', route(async req => {
  const full = safeKnowledgePath(req.query.path);
  return { path: req.query.path, content: fs.readFileSync(full, 'utf8') };
}));
app.put('/api/knowledge/file', route(async req => {
  const { path: rel, content } = req.body ?? {};
  const full = safeKnowledgePath(rel);
  if (typeof content !== 'string') throw httpError(400, 'ไม่มีเนื้อหา');
  if (full.endsWith('.json')) { try { JSON.parse(content); } catch (e) { throw httpError(400, `JSON ไม่ถูกต้อง: ${e.message}`); } }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full + '.tmp', content, 'utf8');
  fs.renameSync(full + '.tmp', full);
  return { ok: true };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));

// โลโก้ร้านของคุณเอง: วางไฟล์ branding/logo.png
app.use('/branding', express.static(path.join(__dirname, 'branding')));

// ---- หน้าเว็บ (หลัง npm run ui:build)
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false }));
  app.get(/.*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send(
    'ยังไม่ได้ build หน้าเว็บ\n\n  npm run ui:build   แล้วรัน npm run ui ใหม่\n  หรือ npm run ui:dev (โหมดพัฒนา เปิด http://localhost:5173)'));
}

// ------------------------------------------------------------------- start
app.listen(PORT, HOST, () => {
  console.log(`\n🖥  Duoke Desk → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!dbEnabled()) console.log('ℹ️  ยังไม่ได้ตั้ง DATABASE_URL — ตอบแชทได้ แต่ประวัติ AI/คำตอบสำเร็จรูปจะยังไม่ทำงาน');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) {
    console.log('⚠️  เปิดให้เครื่องอื่นเข้าได้แต่ยังไม่ได้ตั้ง UI_PASSWORD');
  }
});
startDuoke();

for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, () => {
    duoke.rt?.disconnect();
    process.kill(process.pid, sig);
  });
}
