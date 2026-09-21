/**
 * db-log.js — สะพานระหว่าง watch.js (บอท) กับฐานข้อมูล
 *
 *   recordEvent(obj)         ← ทุกอีเวนต์ที่ watch.js พิมพ์ออกจอ จะถูกส่งมาที่นี่ด้วย
 *   aiBlockedByUi(cid, t)    ← บอทถามก่อนตอบ: ห้องนี้ถูกปิด AI / แอดมินเพิ่งตอบผ่าน UI ไหม
 *
 * เขียนแบบ fire-and-forget: DB ช้า/ล่ม ต้องไม่ถ่วงหรือทำให้บอทล่ม
 */
import { getDb, dbEnabled } from './db.js';

const lastUsage = new Map();     // conversationId → อีเวนต์ usage ล่าสุด (มาก่อน ai_reply)
let failCount = 0;

const str = v => (v === undefined || v === null || v === '' ? null : String(v));
const clip = (v, n = 4000) => (v == null ? null : String(v).slice(0, n));

async function safe(fn) {
  if (!dbEnabled()) return;
  try {
    const db = await getDb();
    if (!db) return;
    await fn(db);
    failCount = 0;
  } catch (err) {
    // เตือนแค่ครั้งแรก ๆ ไม่ให้ log ท่วมจอ
    if (failCount++ < 3) console.error(`⚠️  บันทึก DB ไม่สำเร็จ: ${String(err.message).split('\n').slice(-1)[0]}`);
  }
}

async function touchConversation(db, o, extra = {}) {
  if (!o.conversationId) return;
  const base = {
    shopId: o.shopId != null ? String(o.shopId) : undefined,
    shopName: str(o.shop), platform: str(o.platform),
    buyerName: o.buyer && o.buyer !== o.conversationId ? String(o.buyer) : undefined,
    ...extra,
  };
  await db.conversation.upsert({
    where: { id: String(o.conversationId) },
    create: { id: String(o.conversationId), ...base },
    update: base,
  });
}

// log อีเวนต์ลบของเก่าอัตโนมัติ (ประวัติ AI ตอบ / ข้อความ ไม่ลบ)
const EVENT_LOG_DAYS = Number(process.env.EVENT_LOG_DAYS || 30);
let lastPrune = 0;
function pruneEvents() {
  if (Date.now() - lastPrune < 12 * 3600_000 || EVENT_LOG_DAYS <= 0) return;
  lastPrune = Date.now();
  safe(db => db.eventLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EVENT_LOG_DAYS * 86400_000) } } }));
}

/** รับอีเวนต์จาก watch.js (รูปแบบเดียวกับที่ out() พิมพ์) */
export function recordEvent(o) {
  if (!dbEnabled() || !o?.event) return;
  pruneEvents();
  // เก็บ usage ไว้แปะกับ ai_reply ที่จะตามมา
  if (o.event === 'usage' && o.conversationId) {
    lastUsage.set(o.conversationId, o);
    if (lastUsage.size > 500) lastUsage.clear();
  }

  safe(async db => {
    const { time, ...payload } = o;
    await db.eventLog.create({
      data: {
        event: String(o.event),
        conversationId: str(o.conversationId),
        shopName: str(o.shop),
        buyer: str(o.buyer),
        payload: JSON.parse(JSON.stringify(payload)),
      },
    });

    if (o.event === 'message' && o.conversationId) {
      await touchConversation(db, o, {
        lastMessageText: clip(o.text, 500),
        lastMessageAt: new Date(),
      });
      if (o.messageId) {
        await db.message.upsert({
          where: { id: String(o.messageId) },
          create: {
            id: String(o.messageId), conversationId: String(o.conversationId),
            fromKind: String(o.from ?? 'customer'), sender: str(o.sender),
            type: str(o.type), text: clip(o.text),
          },
          update: {},
        });
      }
    }

    if (o.event === 'ai_reply' && o.conversationId) {
      const u = lastUsage.get(o.conversationId);
      lastUsage.delete(o.conversationId);
      await touchConversation(db, o);
      await db.aiReply.create({
        data: {
          conversationId: String(o.conversationId),
          shopId: str(o.shopId),
          shopName: str(o.shop),
          platform: str(o.platform),
          buyerName: o.buyer && o.buyer !== o.conversationId ? String(o.buyer) : null,
          questionId: str(o.replyTo?.messageId),
          question: clip(o.replyTo?.text),
          reply: clip(o.text),
          status: String(o.status ?? 'unknown'),
          reason: clip(o.reason, 1000),
          model: str(u?.model),
          tokensIn: Number.isFinite(u?.in) ? u.in : null,
          tokensOut: Number.isFinite(u?.out) ? u.out : null,
        },
      });
    }
  });
}

// ---- ให้บอทถามก่อนตอบ: UI สั่งปิด AI ห้องนี้ / แอดมินเพิ่งตอบผ่าน UI ----
const ctlCache = new Map();          // conversationId → { at, row }
const CTL_TTL = 5_000;

/**
 * @param {string} conversationId
 * @param {number} [buyerMsgTime] เวลา (ms) ของข้อความลูกค้าล่าสุด
 * @returns {Promise<null | 'paused' | 'staff_replied'>}
 */
export async function aiBlockedByUi(conversationId, buyerMsgTime) {
  if (!dbEnabled() || !conversationId) return null;
  try {
    const hit = ctlCache.get(conversationId);
    let row = hit && Date.now() - hit.at < CTL_TTL ? hit.row : undefined;
    if (row === undefined) {
      const db = await getDb();
      if (!db) return null;
      row = await db.conversation.findUnique({
        where: { id: String(conversationId) },
        select: { aiPaused: true, lastStaffReplyAt: true },
      });
      ctlCache.set(conversationId, { at: Date.now(), row });
      if (ctlCache.size > 2000) ctlCache.clear();
    }
    if (row?.aiPaused) return 'paused';
    const t = Number(buyerMsgTime);
    if (row?.lastStaffReplyAt && Number.isFinite(t) && t > 0) {
      // เวลาของ Duoke บางแพลตฟอร์มเป็นวินาที
      const ms = t < 1e12 ? t * 1000 : t;
      if (row.lastStaffReplyAt.getTime() >= ms) return 'staff_replied';
    }
    return null;
  } catch {
    return null;      // DB ล่ม → ไม่ขวางบอท
  }
}
