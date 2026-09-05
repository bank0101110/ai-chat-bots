/**
 * example.js — ตัวอย่างใช้งานครบวงจร
 *
 *   export DUOKE_TOKEN="<ค่าคุกกี้ token ของ web.duoke.com>"
 *   node example.js
 *
 * ตัวอย่างนี้ตั้งค่า SEND_REPLY = false ไว้ก่อน เพื่อไม่ให้เผลอส่งข้อความหาลูกค้าจริง
 */

import { DuokeApi, parseMessageContent } from './duoke-api.js';
import { DuokeRealtime } from './duoke-realtime.js';

const SEND_REPLY = false;   // ← เปลี่ยนเป็น true เมื่อพร้อมส่งข้อความจริง
const AUTO_TAG   = false;   // ← เปลี่ยนเป็น true เมื่อพร้อมติดแท็กจริง

const api = new DuokeApi({ token: process.env.DUOKE_TOKEN, language: 'th' });

// ---------------------------------------------------------------- 1. ข้อมูลพื้นฐาน

const user  = await api.getUser();
const puid  = user.puid ?? user.user?.puid;
const shops = await api.getShops();

console.log('ผู้ใช้:', user.email ?? user.account ?? user.uid, '| puid:', puid);
console.log('ร้านค้า:', shops.map(s => `${s.shopName}(${s.platform})`).join(', '));

// ---------------------------------------------------------------- 2. รายการแชท

const shopIdList = shops.map(s => s.id ?? s.shopId);
const convs = await api.queryConversationList({ shopIdList, size: 10, offset: 0 });
const list = convs?.list ?? convs ?? [];

console.log(`\n=== ห้องแชทล่าสุด ${list.length} ห้อง ===`);
for (const c of list.slice(0, 5)) {
  console.log(`- ${c.buyerNick} [${c.platform}/${c.shopName}] ยังไม่อ่าน=${c.unReadCount} tags=${(c.tagList || []).map(t => t.tagName).join(',') || '-'}`);
}

// ---------------------------------------------------------------- 3. อ่านข้อความ

if (list.length) {
  const c = list[0];
  const msgs = await api.getMessageList({
    shopId: c.shopId, conversationId: c.conversationId, platform: c.platform, pageSize: 5,
  });
  console.log(`\n=== 5 ข้อความล่าสุดของ ${c.buyerNick} ===`);
  for (const m of (msgs.list ?? []).reverse()) {
    const who = m.fromAccountType === 1 ? 'ลูกค้า' : 'ร้าน';
    console.log(`  [${who}] ${parseMessageContent(m).text ?? '(' + m.messageType + ')'}`);
  }
}

// ------------------------------------------- 3.5 แท็บขวา: คำสั่งซื้อ + สินค้า

if (list.length) {
  const c = list[0];

  // แท็บ "คำสั่งซื้อ" — ต้องมี buyerId
  const orders = await api.getOrderList({
    shopId: c.shopId, buyerId: c.buyerId, conversationId: c.conversationId,
    platform: c.platform, pageSize: 5,
  });
  console.log(`\n=== คำสั่งซื้อของ ${c.buyerNick} (${orders.total} รายการ) ===`);
  for (const o of orders.list ?? []) {
    console.log(`  #${o.orderNumber} ${o.dkOrderStatus} ${o.amount} ${o.currency} — ${(o.productList || []).length} ชิ้น`);
    for (const p of o.productList ?? []) {
      console.log(`     · ${p.productName.slice(0, 50)} [${p.variation ?? '-'}] x${p.quantity} = ${p.price}`);
    }
  }

  // แท็บ "สินค้า" — สินค้าของร้านเรา
  const products = await api.getProductList({
    shopId: c.shopId, platform: c.platform, pageSize: 5,
    // searchField: 'platform_product_name', searchValue: 'คีมล็อค',
    // sortField: 'platform_product_price', sortBy: 'DESC',
  });
  console.log(`\n=== สินค้าในร้าน ${c.shopName} (${products.total} รายการ) ===`);
  for (const p of products.list ?? []) {
    const price = Number(p.productMinPrice) === Number(p.productMaxPrice)
      ? Number(p.productMinPrice)
      : `${Number(p.productMinPrice)}-${Number(p.productMaxPrice)}`;
    console.log(`  ${p.productName.slice(0, 45)} | ${price} ${p.productCurrency} | สต็อก ${p.productStock} | ${p.platformProductStatus}`);
  }
}

// ---------------------------------------------------------------- 4. แท็ก

const tags = await api.getTagList();
console.log(`\n=== แท็กทั้งหมด ${tags.length} อัน ===`);
console.log(tags.slice(0, 8).map(t => `${t.tagName}(${t.tagColor})`).join(', '));

if (AUTO_TAG && list.length && tags.length) {
  const c = list[0];
  const newList = await api.addTagToConversation({
    shopId: c.shopId,
    conversationId: c.conversationId,
    platform: c.platform,
    tagId: tags[0].id,
    currentTagIds: c.tagIdList || [],
  });
  console.log('ติดแท็กแล้ว →', newList);
}

// ---------------------------------------------------------------- 5. แชทเด้ง realtime

const rt = new DuokeRealtime({ api });

rt.on('state', s => console.log('[socket]', s.state, s.reason ?? s.attempt ?? ''));

rt.on('newMessage', async e => {
  console.log(`\n🔔 แชทเด้ง! shop=${e.shopId} conv=${e.conversationId} (${e.platform})`);

  const msgs = await rt.fetchNewMessages(e);
  const latest = (msgs.list ?? [])[0];
  if (!latest) return;

  const content = parseMessageContent(latest);
  const who = latest.fromAccountType === 1 ? 'ลูกค้า' : 'ร้าน';
  console.log(`   [${who}] ${content.text ?? '(' + latest.messageType + ')'}`);

  // ตอบกลับอัตโนมัติ (เฉพาะข้อความจากลูกค้า)
  if (SEND_REPLY && latest.fromAccountType === 1) {
    const res = await rt.sendText({
      shopId: e.shopId,
      conversationId: e.conversationId,
      platform: e.platform,
      puid,
      text: 'สวัสดีค่ะ รับทราบข้อความแล้ว เดี๋ยวแอดมินติดต่อกลับนะคะ',
    });
    console.log('   ↳ ตอบกลับแล้ว msgSeq =', res.message?.sequence);
  }
});

rt.on('conversations', e => {
  for (const c of e.conversations) {
    console.log(`📋 อัปเดตห้อง ${c.buyerNick} ยังไม่อ่าน=${c.unReadCount} สถานะ=${c.status}/${c.subStatus}`);
  }
});

rt.on('kicked', () => {
  console.error('❌ ถูกเตะออก — มีการล็อกอินบัญชีนี้ที่อื่น');
  process.exit(1);
});

await rt.connect();
console.log('\n✅ เชื่อมต่อ realtime แล้ว — รอข้อความใหม่... (Ctrl+C เพื่อออก)');

process.on('SIGINT', () => { rt.disconnect(); process.exit(0); });
