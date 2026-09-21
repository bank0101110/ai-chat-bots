# Duoke Desk — หน้าเว็บตอบแชท + ประวัติ AI

หน้าเว็บสำหรับตอบลูกค้าทุกร้านจากที่เดียว (คล้ายแอป Duoke) และเปิดดูย้อนหลังว่า AI ตอบอะไรไปบ้าง
ดีไซน์ตาม `DESIGN.md` (ขาว-ดำ + บล็อกสีพาสเทล, ปุ่มทรง pill)

## เริ่มใช้งาน

```bash
npm install                 # ลง React/Vite/Prisma/Express (postinstall จะ prisma generate ให้)

# 1) ต่อ Supabase — ใส่ใน .env (ดูตัวอย่างท้าย .env.example)
#    DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
#    DIRECT_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
npm run db:push             # สร้างตารางใน Supabase (ครั้งแรก / ทุกครั้งที่แก้ prisma/schema.prisma)

# 2) รัน
npm run dev:all             # บอท (watch.js) + หน้าเว็บ พร้อมกันในหน้าต่างเดียว
#   หรือแยกหน้าต่าง:
npm run dev                 # บอท
npm run ui                  # หน้าเว็บ → http://localhost:5174
```

ไม่ได้ตั้ง `DATABASE_URL` ก็ยังตอบแชทผ่านหน้าเว็บได้ แค่ยังไม่มีประวัติ AI / คำตอบสำเร็จรูป / โน้ต / ปิด AI รายห้อง

โหมดแก้โค้ดหน้าเว็บ: `npm run ui:dev` → http://localhost:5173 (hot reload)

## ใช้ token ชุดเดียวกัน ไม่ล็อกอินซ้ำ

ทุกโปรเซส (`watch.js`, `ui-server.js`, `outbox.js`, `reply.js` ฯลฯ) ใช้ `.token.json` ไฟล์เดียวกัน

- เปิดโปรแกรมใหม่ → ใช้ token ในไฟล์ต่อ ไม่ล็อกอินใหม่
- เน็ตกระตุกตอนเช็ค token → **ไม่ถือว่า token เสีย** (เดิมจะล็อกอินใหม่ แล้ว token ของโปรเซสอื่นโดนเตะ)
- token หมดอายุจริง (401) → ล็อกอินได้ **ทีละโปรเซส** (มีไฟล์ล็อก `.token.lock`)
  โปรเซสที่เหลือจะรอ แล้วหยิบ token ใหม่จากไฟล์ไปใช้เอง
- โปรเซสไหนได้ token ใหม่ โปรเซสอื่นที่รันค้างอยู่จะสลับไปใช้ตัวใหม่อัตโนมัติ (ดู `.token.json` ทุก 3 วินาที)
- อยากบังคับล็อกอินใหม่จริง ๆ: `npm run relogin`

## หน้าต่าง ๆ

| หน้า | ทำอะไรได้ |
|---|---|
| **แชท** | รายการห้องทุกร้าน (กรอง รอตอบ/ยังไม่อ่าน/ร้าน/แท็ก, ค้นชื่อ) · อ่านประวัติ · ตอบ (Enter ส่ง) · พิมพ์ `/` เรียกคำตอบสำเร็จรูป · ใช้ร่างของ AI · ส่งการ์ดสินค้า · ติด/เอาแท็กออก · ดูออร์เดอร์+เลขพัสดุ · โน้ตลูกค้า · **ปิด/เปิด AI รายห้อง** · แชทเด้งสด |
| **AI ตอบ** | ทุกคำตอบ/ร่างที่ AI สร้าง กรองตามสถานะ วันที่ คะแนน ค้นข้อความ · ให้คะแนน 👍/👎 · โน้ตว่าควรตอบอะไร · **ส่งคำตอบที่ดีไปเป็นตัวอย่างให้ AI** (`knowledge/admin-examples.json`) · กดเปิดแชทห้องนั้น |
| **ภาพรวม** | ตัวเลขวันนี้ + กราฟ AI ตอบรายวัน (7/14/30 วัน) |
| **คำตอบสำเร็จรูป** | เพิ่ม/แก้/ลบ ข้อความตอบบ่อย พร้อมคำย่อ |
| **ความรู้ AI** | แก้ไฟล์ใน `knowledge/` ได้จากเว็บ (Ctrl+S) — AI ใช้ข้อมูลใหม่ทันที |
| **Log บอท** | อีเวนต์ของ `watch.js` แบบสด (AI ตอบ / ข้าม / แท็ก / error) |
| **ระบบ** | สถานะ Duoke socket, Supabase, AI, บอท |

## บอทกับหน้าเว็บคุยกันยังไง

```
watch.js ──(ทุกอีเวนต์)──► db-log.js ──► Supabase ◄── ui-server.js ◄──► หน้าเว็บ (React)
    ▲                                        │
    └──── ก่อนตอบ ถาม "ห้องนี้ปิด AI / แอดมินเพิ่งตอบจาก Desk ไหม?" ┘
```

- ข้อความที่ส่งจากหน้าเว็บใช้บัญชีเดียวกับบอท Duoke จึงมองเป็น "บอท" — ระบบจึงจด `lastStaffReplyAt`
  ไว้ใน DB แล้ว `watch.js` เช็คก่อนตอบ **บอทจะไม่ตอบทับแอดมิน**
- ในหน้าแชทแยกให้เห็นว่าข้อความไหน **AI ตอบ** (ม่วง), **แอดมินตอบจาก Desk** (ดำ), **ระบบแพลตฟอร์ม** (ครีม)

## ไฟล์ที่เพิ่ม

```
prisma/schema.prisma   ตาราง Conversation, Message, AiReply, StaffReply, QuickReply, EventLog
db.js                  Prisma client (ไม่มี DATABASE_URL = ข้าม ไม่ล่ม)
db-log.js              watch.js → Supabase + เช็คปิด AI/แอดมินตอบแล้ว
ui-server.js           API + live stream (SSE) + เสิร์ฟหน้าเว็บ
vite.config.mjs        ตั้งค่า Vite (โค้ดหน้าเว็บอยู่ใน web/)
web/src/               React + TypeScript
```

## .env ที่เกี่ยวข้อง

```
DATABASE_URL=        # Supabase pooler :6543 ?pgbouncer=true&connection_limit=1
DIRECT_URL=          # Supabase :5432 (ใช้ตอน db:push)
UI_PORT=5174
UI_HOST=127.0.0.1    # 0.0.0.0 = ให้มือถือในวงแลนเปิดได้ → ตั้ง UI_PASSWORD ด้วย
UI_PASSWORD=
EVENT_LOG_DAYS=30   # Log บอทเก็บกี่วัน (ประวัติ AI ตอบไม่ลบ)
UI_BRAND_NAME=Duoke Desk   # ชื่อบนแท็บเบราว์เซอร์
UI_LOGO_URL=               # ลิงก์โลโก้ (หรือวางไฟล์ branding/logo.png แทน)
```

## โลโก้ / รูปโปรไฟล์

- **โลโก้ของคุณ**: วางไฟล์ `branding/logo.png` (สี่เหลี่ยมจัตุรัส) แล้วรีเฟรชหน้าเว็บ
- **รูปลูกค้า / โลโก้ร้าน**: ดึงจากข้อมูลของ Duoke อัตโนมัติ
  ถ้าไม่ขึ้น เปิด http://localhost:5174/api/debug/fields แล้วส่งผลให้ดู (โชว์แค่ชื่อฟิลด์ ไม่มีข้อมูลลูกค้า)
- **ไอคอนแพลตฟอร์ม** (Shopee/Lazada/TikTok): ใช้ favicon ของเว็บแพลตฟอร์ม — ออฟไลน์จะเป็นตัวอักษรแทน
