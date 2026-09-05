# Duoke (多客) Web API — คู่มือใช้งาน

สรุป API ของ `https://web.duoke.com` เฉพาะ 3 เรื่องที่ถาม:

1. **ตอบแชท** (ส่งข้อความ)
2. **แชทเด้ง** (รับข้อความใหม่แบบ realtime)
3. **ระบบแท็ก** (tag / label)

> ข้อมูลทั้งหมดได้จากการถอดโค้ดหน้าเว็บจริง (`web.duoke.com` + micro-app `dk-web-vue2`)
> และดักดู network/socket ตอนใช้งานจริง — ไม่ใช่ public API ที่ Duoke ประกาศ
> ดังนั้น **อาจเปลี่ยนได้ทุกเมื่อ** เมื่อ Duoke deploy เวอร์ชันใหม่

---

## 0. พื้นฐาน

| หัวข้อ | ค่า |
|---|---|
| Base URL | `https://web.duoke.com` |
| Prefix | `/api/v1/...` |
| Auth | HTTP header **`x-access-token: <JWT>`** (คุกกี้ `token` ก็ใช้ได้ถ้า `credentials: 'include'`) |
| Content-Type | บาง endpoint เป็น `application/json` บางตัวเป็น `application/x-www-form-urlencoded` (ระบุไว้ในตารางว่า `JSON` / `FORM`) |
| Response | `{ "code": 0, "success": true, "requestId": "...", "timestamp": "...", "data": <ผลลัพธ์> }` |
| Error | `code != 0` → ข้อความ error map อยู่ที่ `Common.BackendErrors.<code>` |

### เอา token มายังไง

**ปกติไม่ต้องทำเอง** — ใส่แค่ `DUOKE_EMAIL` / `DUOKE_PASSWORD` ใน `.env` แล้วสคริปต์จัดการให้:

```
.env (email + password)
      ↓
duoke-session.js  →  หา token ที่ใช้ได้
      ├─ .token.json ที่แคชไว้ยัง valid?  →  ใช้เลย  (ไม่ถามอะไร)
      ├─ DUOKE_TOKEN ใน .env ยัง valid?   →  ใช้เลย
      └─ ไม่มี / หมดอายุ  →  ล็อกอินใหม่ (ถามแคปช่า 1 ครั้ง) → เขียน .token.json
      ↓
   token  →  DuokeApi (REST)  +  DuokeRealtime (socket.io)
```

`.token.json` ทำให้ nodemon รีสตาร์ตกี่รอบก็ไม่ถามซ้ำ — จะถามแคปช่าอีกทีก็ตอน token หมดอายุจริง ๆ

อยากใส่ token เองก็ยังได้ (ข้ามการล็อกอินไปเลย): ล็อกอินในเบราว์เซอร์ → DevTools →
**Application → Cookies → `token`** → ใส่ `.env` เป็น `DUOKE_TOKEN=...`

> ⚠️ token เป็น JWT ผูกกับบัญชีคุณ — `.env` และ `.token.json` อยู่ใน `.gitignore` แล้ว อย่า commit อย่าแชร์
> อายุคุกกี้ตั้งไว้ 8 วัน (`exp` ใน JWT ยาวกว่านั้น)

---

## 0.1 API ล็อกอิน

### ขั้นตอนที่หน้าเว็บทำจริง

**ขั้น 1 — ขอแคปช่า**

```
GET /api/v1/user/getVerifyCode
→ data: {
    "verifyKey":  "5354396744ad4072b427307a246f8822",   // 32 hex
    "verifyCode": "/9j/4AAQSkZJRgABAgAAAQAB..."          // รูป JPEG แบบ base64
  }
```

หน้าเว็บเอาไปแสดงเป็น `data:image/jpeg;base64,<verifyCode>`

**ขั้น 2 — ล็อกอิน (เข้ารหัสสองชั้น)**

```
POST /api/v1/user/login          Content-Type: application/x-www-form-urlencoded

body=<AES( JSON.stringify({
   email:     "you@example.com",
   password:  AES("รหัสผ่านจริง"),     // ← เข้ารหัสชั้นใน
   verify:    "gEhX",                  // ตัวอักษรที่อ่านจากรูป
   verifyKey: "5354396744ad...",       // key ที่มาคู่กับรูป
   version:   "web"                    // "web" หรือเวอร์ชันแอป desktop
}) )>
```

ทั้ง field เดียวชื่อ **`body`** — ไม่มี email/password โผล่เป็น plain text เลย

**อัลกอริทึม** (เทียบเท่า `$commFn.getEncryptedString` ในหน้าเว็บ):

| | |
|---|---|
| Cipher | **AES-256-ECB** + PKCS7 padding → เข้ารหัสแล้ว base64 |
| Key | `QcclOsWBMbZjSQhAcETUuonqrzrfmSkq` (32 ไบต์ ASCII) |
| ที่มาของ key | ฝังในโค้ดหน้าเว็บ ประกอบจาก 4 ท่อน: `"QcclOsWB"` + `atob("TWJaalNRaEE=")` + `["c","E","T","U","u","o","n","q"].join("")` + `String.fromCharCode(114,122,114,102,109,83,107,113)` |

> เป็นกุญแจตายตัวฝังในหน้าเว็บ (hard-coded) ไม่ใช่ของลับต่อ user — มีไว้กันดักอ่าน plain text เฉย ๆ
> ตรวจสอบแล้วว่าตรงกัน: `node -e` เข้ารหัส `"hello-duoke"` ได้ `wWYofC52hBP661lMIiddFg==` เท่ากับที่หน้าเว็บทำ

**ขั้น 3 — ผลลัพธ์**

```json
{ "code": 0, "data": {
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "uid":  "1691277903316360402",
  "puid": "1691277887125370104",
  "user": { "email": "...", "functionalTest": "...", "rightList": [...],
            "conversationPermissionConfig": {...}, "tencentUserInfo": { "userId", "userSig" } }
}}
```

หน้าเว็บเก็บ `token` ลงคุกกี้ `token` (อายุ 8 วัน) แล้วส่งเป็น header `x-access-token` ทุก request
→ **`data.token` นี่แหละคือค่าที่ใส่ `DUOKE_TOKEN`**

### 2FA (ถ้าเปิดไว้)

`login` จะโยน error `code: 14103` พร้อม `data.sign` → ยืนยันต่อด้วย

```
POST /api/v1/user/totp/verifyPc     (FORM)  { sign, code }
```

### Endpoint อื่นในกลุ่มบัญชี

| Method | Path | Body / Query | ใช้ทำอะไร |
|---|---|---|---|
| `GET` | `/api/v1/user/getVerifyCode` | – | ขอรูปแคปช่า |
| `POST` FORM | `/api/v1/user/login` | `{ body }` | ล็อกอิน |
| `POST` FORM | `/api/v1/user/totp/verifyPc` | `{ sign, code }` | ยืนยัน 2FA |
| `GET` | `/api/v1/user/` | `?version=web` | ข้อมูล user ปัจจุบัน (มี `tencentUserInfo`) |
| `GET` | `/api/v1/user/userInfo` | – | ข้อมูล user แบบย่อ |
| `GET` | `/api/v1/user/session` | – | เช็ค session (401 ถ้าไม่มีสิทธิ์) |
| `GET` | `/api/v1/user/verifyToken` | – | ตรวจ token |
| `POST` JSON | `/api/v1/user/logout` | `{}` | ออกจากระบบ (token เดิมใช้ไม่ได้ต่อ) |
| `POST` FORM | `/api/v1/user/verifyCode` | `{ email, code }` | ตรวจโค้ดที่ส่งทางอีเมล |
| `POST` FORM | `/api/v1/user/resetPassword` / `.../postResetNewPassword` | `{ body }` (เข้ารหัสแบบเดียวกัน) | รีเซ็ตรหัสผ่าน |
| `GET` | `/api/v1/health` | – | เช็คว่า API ยังตอบ |

**Error codes ที่แปลว่า "แคปช่าผิด/หมดอายุ"** → ขอรูปใหม่แล้วลองอีกครั้ง:
`10101–10109`, `10114`, `11901`, `20253`

### ⚠️ ข้อจำกัดสำคัญ — แคปช่า

**แคปช่าเป็นรูปภาพ ต้องมีคนอ่าน** — ไม่มีทางล็อกอินอัตโนมัติ 100% ได้
`duoke-session.js` เลยออกแบบให้ *ถามน้อยที่สุด*: ล็อกอินครั้งเดียว → แคช token → ใช้ยาวหลายวัน

ถ้าจะรันเป็น service / background:

1. `npm run login` ด้วยมือหนึ่งครั้ง (มีเทอร์มินัลให้พิมพ์แคปช่า) → ได้ `.token.json`
2. สั่งรัน `npm start` แบบ background ได้เลย — มันหยิบ token จากแคชไปใช้
3. ถ้า token หมดอายุตอนไม่มีเทอร์มินัล สคริปต์จะบอกให้ไปรัน `npm run login` ใหม่ แทนที่จะค้างรอ input

### ใช้จากโค้ด

**ระดับสูง — ให้จัดการ token ให้เอง** (สิ่งที่ `watch.js` ใช้):

```js
import { getSession, getToken } from './duoke-session.js';
import { DuokeApi } from './duoke-api.js';

const { token, uid, puid, source } = await getSession();   // source: cache | env | login
const api = new DuokeApi({ token });
```

**ระดับล่าง — คุมเองทุกขั้น:**

```js
import { getVerifyCode, login, verifyTotp, encryptDuoke } from './duoke-auth.js';

const { verifyKey, verifyCode } = await getVerifyCode();
// verifyCode = base64 JPEG → เอาไปให้คนดูแล้วพิมพ์
const data = await login({ email, password, verify: 'gEhX', verifyKey });
console.log(data.token);
```

CLI:

```bash
npm run login      # ล็อกอินถ้าจำเป็น (ใช้ token เดิมถ้ายังใช้ได้)
npm run relogin    # บังคับล็อกอินใหม่ ทิ้งแคช
```

### ค่าที่ต้องใช้บ่อย

| ฟิลด์ | ความหมาย | ได้จาก |
|---|---|---|
| `shopId` | ร้านค้า | `GET /api/v1/shop/` |
| `conversationId` | ห้องแชท | `queryConversationList` |
| `platform` | `tiktok` / `shopee` / `lazada` / `daraz` / `tokopedia` / `mercado` / `facebook` / `whatsapp` / `shopify` | จาก conversation |
| `groupId` | group ของ IM (ใช้ตอนส่งข้อความ) | `claimConversation/v2` หรือ conversation object |
| `puid` | parent user id ของบัญชี | JWT payload / `GET /api/v1/user/?version=web` |

---

## 1. อ่านรายการแชท + ข้อความ

| Method | Path | Body / Query |
|---|---|---|
| `GET` | `/api/v1/shop/` | – |
| `POST` JSON | `/api/v1/im/conversation/queryConversationList` | `{ shopIdList, filterGroups, size, offset, sortModel }` |
| `POST` JSON | `/api/v1/im/conversation/queryTotalUnreadCount` | `{ shopIds }` |
| `GET` | `/api/v1/im/conversation/queryTotalUnHandlerCount` | – |
| `GET` | `/api/v1/im/conversation/getPinnedConversationsList` | – |
| `GET` | `/api/v1/im/conversation/view/v2` | `?shopId&conversationId&platform` |
| `GET` | `/api/v1/im/message/list` | `?pageNo&pageSize&shopId&conversationId&language&platform` |
| `GET` | `/api/v1/chat/getLatestMessageList` | `?conversationId&shopId&latestMessageId&language` |

ตัวอย่าง 1 record ของ `im/message/list`:

```json
{
  "id": "209429812450905",
  "dkMessageType": "text",
  "messageType": "text",
  "messageContent": "{\"translateTxt\":\"\",\"text\":\"ขอบคุณที่ติดต่อมา...\"}",
  "conversationId": "7681354854766002449",
  "messageId": "7681885484171429909",
  "createdTimestamp": 1788578342000,
  "shopId": "1691277887617590104",
  "platform": "tiktok",
  "fromAccountType": 2,
  "tagIdList": null,
  "messageSource": 1
}
```

- `messageContent` เป็น **JSON string** ต้อง `JSON.parse` อีกชั้น
- `fromAccountType`: `1` = ผู้ซื้อ, `2` = ร้าน (สังเกตจากข้อมูลจริง — ควรเช็คซ้ำกับข้อมูลของคุณเอง)

### 1.1 `messageType` ที่เจอจริง

`messageContent` มีหน้าตาไม่เหมือนกันตาม `messageType` — ตัวที่เจอแล้วในข้อมูลจริง:

| `messageType` | `messageContent` (หลัง parse) |
|---|---|
| `text`, `attachment_text` | `{ text, translateTxt }` |
| `image` | `{ imageUrl }` |
| `video` | `{ videoUrl }` |
| `sticker` | – |
| **`item`** | **การ์ดสินค้า — ดูด้านล่าง** |
| `order` | `{ orderId, ... }` |
| `voucher` | `{ promotionId, ... }` |
| `file` | `{ fileName, ... }` |

### 1.2 การ์ดสินค้า (`messageType: "item"`) — สำคัญกับบอท

ลูกค้ากดปุ่ม "ส่งสินค้านี้ในแชท" จากหน้าร้าน จะได้ข้อความชนิด `item` มา
**ส่วนใหญ่ลูกค้าส่งการ์ดมาเฉย ๆ ไม่พิมพ์อะไรต่อ** — การ์ดใบนี้คือคำถามของเขา

```json
{
  "itemId": "27715539310",
  "price": "145.00000",
  "currency": "THB",
  "skuValue": "อวนไก่โปลี-2.5 เมตร",
  "title": "ตาข่ายล้อมไก่ อวนล้อมไก่ อวนไก่ ตาข่ายปลูกผัก ดักสัตว์ โปลี กรงนก กันงู กันนก กันแมว",
  "actionUrl": "https://shopee.co.th/product/54723061/27715539310",
  "iconUrl": "https://cf.shopee.co.th/file/th-11134207-81ztn-mfz7hylfhxqh25",
  "isPreOrder": 0
}
```

- `skuValue` = ตัวเลือกที่ลูกค้าเลือกไว้จริง (ไซส์/สี/ขนาด) — ตัวสำคัญที่สุด เพราะบอกว่าสนใจรุ่นไหน
- `price` เป็น string ทศนิยม 5 ตำแหน่ง (`"145.00000"`) และเป็น**ราคาที่ลูกค้าเห็นบนหน้าร้านตอนนั้น** ใช้ทวนยืนยันกับลูกค้าได้
- `title` คือชื่อประกาศเต็ม ๆ ซึ่งมักยัด keyword ไว้เยอะ (ไม่ใช่ชื่อสินค้าสั้น ๆ)
- `itemId` เดียวกันได้หลาย `skuValue` — ลูกค้าส่งหลายใบติดกัน = กำลังเทียบตัวเลือกอยู่

`ai-bot.js` กาง field พวกนี้เป็นข้อความให้ AI อ่านที่ `renderItemCard()`
ถ้าไม่กาง AI จะเห็นข้อความว่าง แล้วข้ามทั้งห้องด้วยเหตุผล "ไม่มีข้อความให้ตอบ"

---

## 2. ตอบแชท (ส่งข้อความ)

### 2.1 เส้นทางที่หน้าเว็บใช้จริง = WebSocket (socket.io) ไม่ใช่ REST

หน้าเว็บ Duoke ส่งข้อความผ่าน IM SDK ของตัวเอง (`window.$dkChat`) ซึ่งวิ่งบน socket.io
REST `/api/v1/chat/send` ยังมีอยู่แต่เป็นของเก่า/สำรอง

**ลำดับ 3 ขั้น:**

**ขั้น 1 — claim ห้องแชทเพื่อเอา `groupId`**

```
POST /api/v1/im/conversation/claimConversation/v2      (JSON)
{ "shopId": "...", "conversationId": "...", "platform": "tiktok" }
→ data: { "groupId": "DK_0CONVERSATION_GROUP_xxx", ... }
```

**ขั้น 2 — สร้าง message object ผ่าน socket**

```js
const msg = await socket.emitWithAck('msg/create', {
  to: groupId,
  conversationType: 'GROUP',
  type: 'TIMCustomElem',
  payload: {
    data: JSON.stringify({ text: 'สวัสดีค่ะ' }), // เนื้อหา
    description: 'text'                          // = contentType
  },
  cloudCustomData: JSON.stringify(meta)          // ดู 2.2
});
// → { code: 200, data: <message> }
```

**ขั้น 3 — ส่ง**

```js
await socket.emitWithAck('msg/send', msg.data);
// → { code: 200, ... }
```

หน้าเว็บส่งพร้อม option (ตัว SDK ใส่ให้เอง ไม่ต้องส่งซ้ำถ้ายิง raw socket):
`{ offlinePushInfo: { disablePush: true }, messageControlInfo: { excludedFromUnreadCount: true } }`

### 2.2 `cloudCustomData` (meta) — สำคัญ

เป็น JSON string ที่บอกฝั่ง Duoke ว่าข้อความนี้คืออะไร:

```js
{
  puid: "1691277887125370104",
  messageType: "text",
  dkMessageType: "text",
  platform: "tiktok",
  text: "สวัสดีค่ะ",       // เฉพาะ text
  translateText: undefined  // ถ้ามีการแปล
}
```

`contentType` / `messageType` ที่รองรับ และฟิลด์ที่ต้องใส่เพิ่มใน meta:

| contentType | `payload.data` (content) | ฟิลด์เพิ่มใน cloudCustomData |
|---|---|---|
| `text` | `{ text }` | `text`, `translateText`, (quote: `quotedMsgId`, `quoteContent`) |
| `image` | `{ imageUrl }` | `imageUrl` |
| `video` | `{ videoUrl, imageUrl, width, height, durationSeconds, videoName, videoHash }` | เหมือน content |
| `sticker` | `{ stickerId, stickerPackageId }` | `sticker` (shopee) / `text` (lazada, daraz) |
| `product` | `{ itemId }` | `productId` |
| `order` | `{ orderId }` | `orderId` |
| `voucher` | `{ promotionId }` | `promotionId` |
| `title_url` | `{ url }` | `url`, `title: "item"`, `messageType: "dkitem"` |
| `file` | `{ url, fileName }` | `attachmentList` (JSON string array) |
| `attachment` / `attachment_text` | `{ attachmentList, text }` | `attachmentList`, `text` |
| `logistics_card` | `{ orderId }` | `orderId` |
| `return_refund_card` | `{ orderId, skuId }` | `orderId`, `skuId` |

### 2.3 REST ที่เกี่ยวข้อง

| Method | Path | Body | ใช้เมื่อ |
|---|---|---|---|
| `POST` JSON | `/api/v1/chat/send` | `{ referenceId, conversationId, contentType, shopId, toId, content(JSON string), sourceContent }` | เส้นทางเก่า/สำรอง |
| `POST` JSON | `/api/v1/im/conversation/openConversationAndSendMessage` | `{ shopId, buyerId, messageType, messageContent, cloudCustomData }` | **เปิดแชทใหม่** กับผู้ซื้อที่ยังไม่เคยคุย |
| `POST` JSON | `/api/v1/v2/im/conversation/sendMessage` | `{ shopId, conversationId, cloudCustomData }` | ส่งข้อความแบบ template |
| `POST` JSON | `/api/v1/im/conversation/claimConversation/v2` | `{ shopId, conversationId, platform }` | รับเรื่อง / เอา groupId |

---

## 3. แชทเด้ง (realtime push)

Duoke ใช้ **socket.io (WebSocket)** ของตัวเอง ที่ `im.duoke.com` — ไม่ใช่ polling
(ในหน้าเว็บ socket ถูกรันอยู่ใน Web Worker)

### 3.1 ต่อ socket

**ขั้น 1 — เอา userSig ของ IM**

```
GET /api/v1/user/?version=web
→ data.tencentUserInfo = { userId, userSig }
```

**ขั้น 2 — แลก token ของ IM**

```
POST https://im.duoke.com/im/auth/login
{
  "appId": 1400575678,
  "userId": "<userId>",
  "userSig": "<userSig>",
  "clientType": 3,
  "clientId": "<uuid ของ client, เก็บใน localStorage: dkImSdkClientId>",
  "version": "1.0.16"
}
→ token (string)
```

**ขั้น 3 — เชื่อม socket.io**

```js
io('https://im.duoke.com', {
  transports: ['websocket'],
  path: '/dkim',
  auth: cb => cb({ token }),
  query: {
    sdkAppId: 1400575678,
    nonce: Math.random().toString(36),
    timestamp: Date.now(),
    clientType: 3,
    version: '1.0.16',
    token
  }
});
```

โดเมนสำรอง (prod): `https://im.duoke.com`, `https://cn-im.duoke.com`, `https://global-im.duoke.com`
เวลา reconnect ตัว SDK จะวนเปลี่ยนโดเมนไปเรื่อย ๆ

### 3.2 Event ที่ server ยิงมา

| Event | ความหมาย |
|---|---|
| `msg/new-msg` | **ข้อความใหม่ / แชทเด้ง** |
| `msg/modified` | ข้อความถูกแก้ |
| `msg/broadcast-msg` | ประกาศระบบ |
| `conversation/updated` | ห้องแชทอัปเดต |
| `user/kicked` | ถูกเตะออก (ล็อกอินที่อื่น) |
| `user/status-updated` | สถานะผู้ใช้เปลี่ยน |

Event ที่ client ยิงไป: `init` (หลัง reconnect), `msg/create`, `msg/send`,
`group/get-attributes`, `conversation/mark-conversation`

### 3.3 หน้าตา payload ของ `msg/new-msg`

เป็น `TIMCustomElem` — ตัวจริงอยู่ใน `payload.data` (JSON string) และดูชนิดจาก `payload.description`

**แบบ A — `system_message_push` = มีข้อความใหม่ในห้องนี้**

```json
{
  "ID": "DK_bvxG9WWvjdfee6oWVD",
  "conversationID": "GROUP_DK_1CONVERSATION_NOTIFY_GROUP_...",
  "conversationType": "GROUP",
  "from": "administrator",
  "type": "TIMCustomElem",
  "sequence": 1239122,
  "time": 1788578692913,
  "payload": {
    "type": "TIMCustomElem",
    "description": "system_message_push",
    "data": "{\"puid\":\"...\",\"shopId\":\"...\",\"platform\":\"shopee\",\"conversationId\":\"223968263774865285\",\"time\":1788578688900}"
  }
}
```

→ ได้ `shopId` + `conversationId` แล้วไปดึงเนื้อหาจริงด้วย
`GET /api/v1/im/message/list?shopId=..&conversationId=..&platform=..&pageNo=1&pageSize=20`

**แบบ B — `system_conversation_push_v2` = รายการแชทอัปเดต**

`data` = `{ puid, shopId, minSeq, maxSeq, payload, time }`
โดย **`payload` เป็น gzip แล้ว base64** → คลายออกได้ JSON array ของ conversation:

```json
[{
  "conversationId": "223968263774865285",
  "shopId": "1691277887617500104",
  "platform": "shopee",
  "buyerId": "52146675",
  "buyerNick": "jongcharoen",
  "groupId": "DK_0CONVERSATION_GROUP_...",
  "unReadCount": 2,
  "status": 0,
  "subStatus": 4,
  "latestMessageType": "text",
  "latestMessageContent": "{\"text\":\"สวัสดีค่ะ...\"}",
  "lastMessageTimestamp": 1788578690000,
  "tagIdList": [],
  "tagList": []
}]
```

วิธีคลายใน Node: `zlib.gunzipSync(Buffer.from(payload, 'base64')).toString('utf8')`

### 3.4 ถ้าไม่อยากต่อ socket — ใช้ polling แทน

- `GET /api/v1/im/conversation/queryTotalUnHandlerCount` (หน้าเว็บยิงเองทุก ~30 วิ)
- `POST /api/v1/im/conversation/queryConversationList` แล้วเทียบ `lastMessageTimestamp` / `unReadCount`

---

## 4. ระบบแท็ก (Tag / Label)

**API ที่ "เพิ่มแท็กให้แชท" คือ `POST /api/v1/user/tag/updateConversationTag`**

⚠️ เป็นแบบ **แทนที่ทั้งลิสต์** ไม่ใช่ append — ต้องส่ง `tagIdList` ที่รวมของเดิม + ตัวใหม่

| Method | Path | Body | ความหมาย |
|---|---|---|---|
| `POST` FORM | `/api/v1/user/tag/getTagList` | – | รายการแท็กทั้งหมดของบัญชี |
| `POST` FORM | `/api/v1/user/tag/addTag` | `{ tagName, tagColor }` | สร้างแท็กใหม่ |
| `POST` JSON | `/api/v1/user/tag/updateTag` | `{ tagId, tagName, tagColor }` | แก้ชื่อ/สีแท็ก |
| `POST` JSON | `/api/v1/user/tag/deleteTag` | `{ tagId }` | ลบแท็กออกจากระบบ |
| `POST` JSON | `/api/v1/user/tag/batchUpdateTag` | `{ tagList }` | แก้หลายอันพร้อมกัน (เรียงลำดับ) |
| **`POST` JSON** | **`/api/v1/user/tag/updateConversationTag`** | **`{ shopId, conversationId, tagIdList }`** | **ติดแท็กให้ห้องแชท** |
| `POST` JSON | `/api/v1/user/tag/deleteConversationTag` | `{ shopId, conversationId, tagId }` | เอาแท็ก 1 ตัวออกจากห้องแชท |
| `POST` FORM | `/api/v1/im/conversation/listConversationsByTag` | `{ platform, tagIds, lastTagId, pageSize, nextStartTime }` | ค้นห้องแชทตามแท็ก |
| `POST` FORM | `/api/v1/user/tag/searchDkConversationByTagV1` | `{ platform, tagId, shopId }` | ค้นห้องแชทตามแท็ก (แบบเก่า) |

ทั้ง `updateConversationTag` และ `deleteConversationTag` **คืน `tagList` ชุดใหม่ของห้องนั้นกลับมา**

หน้าตาแท็ก 1 ตัวจาก `getTagList`:

```json
{
  "id": "1691277908871440813",
  "tagName": "สินค้าไม่ถูกจัดส่ง",
  "tagColor": "orange",
  "order": 29,
  "common": 0,
  "createTime": 1786587725000,
  "updateTime": 1786587725000
}
```

> ใช้ฟิลด์ **`id`** เป็น tagId (ฟิลด์ `tagId` ในผลลัพธ์เป็น `null`)
> สีที่เจอ: `blue`, `red`, `orange`, `green` (ค่า default ตอนสร้างคือ `blue`)

**แท็กอื่นที่ไม่ใช่แท็กแชท** (คนละระบบ อย่าสับสน):

| Path | ใช้กับ |
|---|---|
| `/api/v1/util/evaluationManage/setLabel` | ป้ายของรีวิว |
| `/api/v1/dk/unity/review/tiktok/setLabel` | ป้ายรีวิว TikTok |
| `/api/v1/util/orderFollow/batchToTag` | ป้ายของงานติดตามออร์เดอร์ |

---

## 5. แท็บขวา — "คำสั่งซื้อ" และ "สินค้า"

สองแท็บนี้อยู่ในแผงขวาของหน้าแชท (ตามที่วงไว้ในภาพ)

### 5.1 แท็บ "คำสั่งซื้อ" — ออร์เดอร์ของลูกค้าคนนี้

```
POST /api/v1/dk/unity/order/list        (JSON)
{
  "shopId": "1691277887617590104",
  "buyerId": "7494021673177876378",      // ★ ต้องมี ไม่งั้นได้ list ว่าง
  "conversationId": "7681354854766002449",
  "platform": "tiktok",
  "pageNo": 1,
  "pageSize": 10
}
```

> `buyerId` เอามาจาก conversation object (`queryConversationList` / `view/v2`)
> ถ้าส่งแค่ `shopId` + `platform` จะได้ `total: "0"` เสมอ

**Response** — pagination แบบ PageHelper:

```json
{ "code": 0, "data": {
  "total": "1", "pageNum": 1, "pages": 1, "hasNextPage": false,
  "list": [{
    "id": "192016528",
    "orderNumber": "585877322255206298",
    "platform": "tiktok",
    "shopId": "1691277887617590104",
    "country": "TH",
    "dkOrderStatus": "Delivered",          // สถานะฝั่ง Duoke
    "platformOrderStatus": "122",          // โค้ดดิบของแพลตฟอร์ม
    "statuses": ["122"],
    "buyerId": "7494021673177876378",
    "amount": 112.75,
    "currency": "THB",
    "cod": 0,
    "paymentMethod": "Mbanking",
    "paymentTime": 1788454813000,
    "platformCreateTime": 1788454795000,
    "buyerNotes": "", "sellerNotes": [], "sellerNotesDuoke": null,
    "productList": [{
      "productId": "1733400342495790584",
      "skuId": "1733400190862919160",
      "productName": "...", "productSku": "นกแก้วส้ม-3x5 นิ้ว",
      "variation": "3x5 นิ้ว",
      "productImage": "https://...", "productUrl": "https://shop.tiktok.com/...",
      "originalPrice": 60, "price": 25.37, "quantity": 1,
      "trackingCode": null, "skuType": "NORMAL"
    }]
  }]
}}
```

API อื่นที่แท็บนี้ใช้ต่อ:

| Method | Path | Body / Query | ใช้ทำอะไร |
|---|---|---|---|
| `POST` JSON | `/api/v1/dk/unity/order/detail` | `{ shopId, platform, orderNumber }` | รายละเอียดออร์เดอร์ |
| `POST` JSON | `/api/v1/dk/unity/order/synchronous` | `{ shopId, orderNumber, platform }` | ดึงออร์เดอร์จากแพลตฟอร์มใหม่ |
| `POST` FORM | `/api/v1/order/getLogisticsByOrder` | `{ shopId, orders }` — `orders` = `{"<orderNumber>":["<trackingNo>"]}` | สถานะขนส่ง |
| `GET` | `/api/v1/order/getConversationOrder` | `?orderId&platform` | ออร์เดอร์จากการ์ดในแชท |
| `GET` | `/api/v1/dk/note/detail` | `?platformOrderId&shopId&platform` | โน้ตของออร์เดอร์ |
| `POST` JSON | `/api/v1/dk/note/edit` | `{ platformOrderId, shopId, id, platform, content }` | แก้โน้ต |
| `GET` | `/api/v1/shop/order/` | `?shopId&toId&buyerName&pageSize&pageNo` | endpoint เก่า (ก่อน unity) |

### 5.2 แท็บ "สินค้า" — สินค้าของร้านเรา

```
POST /api/v1/dk/unity/product/list      (JSON)
{
  "shopId": "1691277887617500104",
  "platform": "shopee",
  "messageItemIds": "25270276603",   // itemId ที่ลูกค้าเพิ่งถามถึง (ดันขึ้นบนสุด)
  "pageNo": 1,
  "pageSize": 20,

  // ตัวเลือก — ใส่เฉพาะตอนค้นหา/จัดเรียง
  "searchField": "platform_product_name",
  "searchValue": "คีมล็อค",
  "sortField": "platform_product_price",
  "sortBy": "DESC"
}
```

| พารามิเตอร์ | ค่าที่ใช้ได้ |
|---|---|
| `searchField` | `platform_product_name` (ชื่อ) · `platform_product_id` (ไอดี) · `platform_product_sku` (SKU) — shopify ไม่มี `platform_product_id` |
| `sortField` | `platform_product_price` · `platform_product_update_time` · `platform_product_sales` (เฉพาะ shopee) |
| `sortBy` | `DESC` · `ASC` · ไม่ส่ง = ไม่เรียง |
| `messageItemIds` | itemId จากข้อความล่าสุดของลูกค้า → สินค้านั้นจะได้ `recentlyConsulted: true` |

**Response:**

```json
{ "code": 0, "data": { "total": "687", "pages": 35, "list": [{
  "id": "1000159698310321",
  "productId": "25270276603",
  "productName": "คีมล๊อคของแท้ คีมล็อค Zicko ขนาด 10 นิ้ว ...",
  "productSku": "คีมล๊อค COSA แผงแดงรุ่นเบา",
  "productImage": "https://cf.shopee.co.th/file/...",
  "productUrl": "https://shopee.co.th/product/54723061/25270276603",
  "productMinPrice": "69.00000", "productMaxPrice": "69.00000",
  "productCurrency": "THB",
  "productStock": 967,
  "platformProductStatus": "NORMAL",
  "isValid": 1,
  "shopName": "BTHSP", "site": "TH", "platform": "shopee",
  "recentlyConsulted": true,
  "productDescription": "...",
  "productBrand": "{\"brand_id\":4163234,...}",
  "items": [{ "itemSku": "คีมล๊อค COSA แผงแดงรุ่นเบา", "stock": 967, "extraInfo": { "primary": "Y" } }],
  "platformUpdateTime": 1788509122000
}]}}
```

- `productMinPrice` / `productMaxPrice` เป็น **string** ต้อง `Number()` ก่อนคำนวณ
- `items[]` = ตัวเลือกย่อย (SKU/variation) พร้อมสต็อกแยก
- `productBrand`, `extraInfo.descriptionInfo` เป็น **JSON string** ซ้อนอีกชั้น

API อื่นของแท็บสินค้า:

| Method | Path | Body | ใช้ทำอะไร |
|---|---|---|---|
| `POST` JSON | `/api/v1/dk/unity/product/syncByShop` | `{ shopId, platform, async }` | ซิงก์สินค้าทั้งร้าน (ปุ่มรีเฟรช) |
| `POST` JSON | `/api/v1/dk/unity/product/syncByProductId` | `{ shopId, platform, productId }` | ซิงก์สินค้าตัวเดียว |
| `POST` JSON | `/api/v1/dk/unity/product/itemModule/list` | `{ platform, shopIds, name, skus, stockStatus, sortType, pageNo, pageSize, ... }` | ค้นสินค้าข้ามหลายร้าน (ตัวเลือกใน popup ส่งสินค้า) |
| `GET` | `/api/v1/shop/product/` | `?shopId&productName&productSku&sortBy&sortStr&pageSize&pageNo` | endpoint เก่า (ก่อน unity) |
| `GET` | `/api/v1/voucher/getVoucherInfo` | `?shopId&voucherId` | แท็บ Voucher ข้าง ๆ |

> ส่งการ์ดสินค้า/ออร์เดอร์เข้าแชท → ใช้ `sendMessage` แบบ `contentType: 'product'`
> (`content = { itemId }`) หรือ `'order'` (`content = { orderId }`) ดูตาราง 2.2

---

## 6. ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `duoke-auth.js` | ชั้นล่างของการล็อกอิน — AES + `getVerifyCode` + `login` + `verifyTotp` |
| `duoke-session.js` | **จัดการ token ให้อัตโนมัติ** — แคช / ตรวจอายุ / ล็อกอินใหม่เมื่อจำเป็น |
| `duoke-api.js` | client REST — อ่านแชท, ส่งข้อความ, แท็ก, คำสั่งซื้อ, สินค้า (Node 18+ / เบราว์เซอร์) |
| `duoke-realtime.js` | ต่อ socket.io รับแชทเด้ง + คลาย gzip payload |
| `watch.js` | **ตัวเฝ้าดู — ล็อกอินก่อน แล้ว log ทุกครั้งที่มีคนแชทเข้ามา** (ตัวที่รันกับ nodemon) |
| `example.js` | ตัวอย่างใช้งานครบวงจร |
| `package.json` / `nodemon.json` | สคริปต์ + ค่า nodemon |
| `.env.example` | เทมเพลตตั้งค่า — คัดลอกเป็น `.env` |
| `.token.json` | *(สร้างอัตโนมัติ)* token ที่แคชไว้ — อยู่ใน `.gitignore` |

### รัน watcher (nodemon)

```bash
cd C:\Users\USER\Downloads\project\duoke

npm install                       # ลง socket.io-client + nodemon

copy .env.example .env            # Windows  (macOS/Linux: cp .env.example .env)
#  แล้วเปิด .env ใส่
#     DUOKE_EMAIL=you@example.com
#     DUOKE_PASSWORD=รหัสผ่านของคุณ

npm run dev                       # nodemon — รีสตาร์ตเองเวลาแก้โค้ด
# หรือ
npm start                         # node เฉย ๆ
```

**รอบแรก** จะเด้งรูปแคปช่าขึ้นมาให้ดู (เปิดไฟล์ `captcha.jpg` ให้อัตโนมัติ) แล้วรอพิมพ์ตัวอักษร
พิมพ์ถูกแล้วมันเก็บ token ไว้ใน `.token.json` — **รอบต่อ ๆ ไปและตอน nodemon รีสตาร์ต จะไม่ถามอีก**

ผลลัพธ์ที่จะเห็น:

```
05/09/68 10:35:10 🔑 ใช้ token ที่แคชไว้ (เหลืออีก ~7 วัน)
05/09/68 10:35:12 🟢 socket connected

Duoke chat watcher
บัญชี: you@example.com
ร้าน : BTHSP(shopee), BTHTIK(tiktok)
กรอง : เฉพาะข้อความจากลูกค้า · เขียนลง chat.log
──────────────────────────────────────────────────────────────────────
05/09/68 10:35:12 ✅ พร้อมรับแชท — Ctrl+C เพื่อออก
05/09/68 10:36:04 💬 BTHSP·shopee jongcharoen: สินค้ายังไม่ได้เลยค่ะ
          ↳ ยังไม่อ่าน 2 · conversationId=223968263774865285
05/09/68 10:36:41 💬 BTHTIK·tiktok frog...18: ขอที่อยู่ร้านหน่อยครับ
```

ตั้งค่าเพิ่มใน `.env`:

| ตัวแปร | ค่า | ความหมาย |
|---|---|---|
| `DUOKE_EMAIL` | อีเมล | **จำเป็น** |
| `DUOKE_PASSWORD` | รหัสผ่าน | **จำเป็น** — เก็บอยู่ในเครื่องเท่านั้น ไม่ถูกเขียนลงที่อื่น |
| `DUOKE_TOKEN` | JWT | ไม่บังคับ — ถ้ามีและยังใช้ได้ จะข้ามการล็อกอินไปเลย |
| `ONLY_BUYER` | `true` (default) / `false` | `false` = log ข้อความที่ร้านตอบด้วย |
| `SHOW_CONVERSATIONS` | `false` (default) / `true` | log ตอนรายการห้องแชทอัปเดต (unread เปลี่ยน) |
| `LOG_FILE` | `chat.log` / เว้นว่าง | เขียน log ลงไฟล์ด้วย (ตัดสี ANSI ออกแล้ว) |

คำสั่งอื่น:

```bash
npm run login      # ล็อกอินล่วงหน้า (ถ้า token เดิมยังใช้ได้ก็ไม่ทำอะไร)
npm run relogin    # ทิ้งแคช บังคับล็อกอินใหม่
```

> `watch.js` เป็นแค่ตัวอ่านอย่างเดียว **ไม่ส่งข้อความอะไรออกไป**
> ถ้าจะทำ auto-reply ให้เพิ่ม `rt.sendText({...})` ในตัวจัดการ `newMessage` (ดู `example.js`)

---

## 7. ข้อควรระวัง

- นี่คือ **internal API** ไม่มีสัญญาความเสถียร — path/ฟิลด์เปลี่ยนได้ตอน Duoke deploy
  วิธีเช็คว่าเปลี่ยนไหม: เปิด `web.duoke.com` แล้วรัน `Object.keys(window.__MICRO_APP_PROXY_WINDOW__.$http)`
  ใน DevTools console จะเห็นรายชื่อฟังก์ชัน API ทั้งหมด และ `String(window.__MICRO_APP_PROXY_WINDOW__.$http.<ชื่อ>)`
  จะโชว์ path จริง
- ยิงถี่เกินอาจโดน rate limit / บัญชีโดนล็อก
- token หมดอายุตาม `exp` ใน JWT — `watch.js` จับ `401` แล้วล็อกอินใหม่ให้เอง (ถ้ามีเทอร์มินัลให้กรอกแคปช่า)
- ล็อกอินซ้อนหลายที่ ตัว socket จะยิง `user/kicked` แล้วเตะตัวเก่าออก
- **การส่งข้อความคุยกับลูกค้าจริง** — ทดสอบกับห้องแชทของตัวเองก่อนเสมอ
