/**
 * shopee-products.js — ดึงสินค้าร้าน Shopee ผ่าน Duoke แล้วสร้างคลังความรู้ให้ AI อ่าน
 *
 *   node shopee-products.js            # ใช้ข้อมูลใน .cache/ แล้วสร้างไฟล์ใหม่
 *   node shopee-products.js --fetch    # ดึงสินค้าใหม่จาก Duoke ก่อนสร้าง
 *
 * ทำไมไม่ scrape shopee.co.th ตรง ๆ: Shopee มี anti-bot (error 90309999) บล็อก
 * /api/v4/search/search_items กับ /api/v4/pdp/* หมด แต่ร้านนี้ต่อกับ Duoke อยู่แล้ว
 * (shopeeShopId 54723061) ข้อมูลจาก Duoke จึงครบกว่า — มีตัวเลือกย่อย สเปก และ SKU
 *
 * ไฟล์ที่สร้างออกมา "ไม่มีราคาและสต๊อก" ตั้งใจตัดออก เพราะเปลี่ยนบ่อยและที่ซิงก์มามัก
 * ไม่ตรงจริง (ของที่ปิดการขาย Shopee รายงานราคา 9999 สต๊อก 0) → ราคาให้ดูหน้าร้านจริง
 *
 * ผลลัพธ์ → knowledge/products/ (โฟลเดอร์ย่อย = ai-bot.js ไม่ดูดเข้า prompt อัตโนมัติ
 * เพราะ loadKnowledge() อ่านเฉพาะไฟล์ชั้นบนสุด) ใช้เปิดอ่านเฉพาะไฟล์ที่ต้องการได้
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuokeApi } from './duoke-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '.cache', 'shopee-products-raw.json');
const OUT = path.join(__dirname, 'knowledge', 'products');

const SHOP = { duokeShopId: '1691277887617500104', platform: 'shopee', shopeeShopId: '54723061', name: 'บ้านไท ฮาร์ดแวร์', username: 'baanthaihardware' };

// ------------------------------------------------------------------ หมวดหมู่
// กฎบนลงล่าง เจอตัวแรกชนะ → เรียงกฎเฉพาะเจาะจงไว้ก่อนกฎกว้าง
const RULES = [
  ['กาว-เทป-ซีลแลนท์', [
    ['กาวร้อน', /กาวร้อน|ตราช้าง|Alteco|อัลติก้า/i],
    ['กาวซิลิโคน-ยาแนว', /ซิลิโคน|ยาแนว|Silicone|กาวอะคริลิ|มหาอุด|ปิดรอยต่อ|กันซึม/i],
    ['กาวทาท่อ-กาวยาง-กาวอเนกประสงค์', /กาวทาท่อ|กาวยาง|กาวตะปู|กาวลาเท็กซ์|กาวขาว|กาวไม้|กาวแท่ง|Anybond|เอนี่บอนด์|กาว/],
    ['เทปกาว', /เทป|Tape|สก๊อตเทป|แลคซีน/i],
  ]],
  // อะไหล่/ใบต่าง ๆ ต้องมาก่อนหมวดตัวเครื่อง ไม่งั้น "ใบมีดตัดหญ้า" จะไปอยู่หมวดเครื่องตัดหญ้า
  ['ใบตัด-ดอกสว่าน-อะไหล่เครื่องมือ', [
    ['ใบตัด-ใบเจียร', /ใบตัด|ใบเจียร|หินเจียร|ใบขัด|จานทราย|ใบเพชร/],
    ['ใบเลื่อย-โซ่-บาร์-ใบตัดหญ้า', /ใบเลื่อย|โซ่เลื่อย|บาร์เลื่อย|ใบมีดตัดหญ้า|เอ็นตัดหญ้า|ตะไบแทง|ใบกบ|อะไหล่เครื่องตัดหญ้า/],
    ['ดอกสว่าน-ดอกไขควง-ลูกบ๊อก', /ดอกสว่าน|ดอกไขควง|ดอกเจาะ|ดอกต๊าป|ลูกบ๊อก|บ๊อกซ์|บล็อคชุด|บล็อกชุด/],
    ['ใบมีด-คัตเตอร์', /ใบมีด|คัตเตอร์/],
  ]],
  ['เครื่องมือไฟฟ้า-เครื่องยนต์', [
    ['เครื่องตัดหญ้า-เลื่อยยนต์-เครื่องพ่นยา', /ตัดหญ้า|เลื่อยยนต์|เลื่อยโซ่|เครื่องพ่นยา|พ่นยา/],
    ['สว่าน-เจียร-เลื่อยไฟฟ้า', /เครื่องเจียร|เลื่อยไฟฟ้า|เลื่อยวงเดือน|เครื่องขัด|โรตารี่|แท่นตัด|สว่าน(?!.*(ดอก|ก้าน))/],
    ['ปั๊มน้ำ-ปั๊มลม-มอเตอร์', /ปั๊มน้ำ|ปั้มน้ำ|ปั๊มลม|ปั๊มแช่|ไดโว่/],
  ]],
  ['งานเชื่อม-แก๊ส-ลม', [
    ['ตู้เชื่อม-อุปกรณ์เชื่อม', /ตู้เชื่อม|หน้ากากเชื่อม|คีมเชื่อม|สายเชื่อม|แม่เหล็กจับฉาก/],
    ['ลวดเชื่อม-บัดกรี', /ลวดเชื่อม|ตะกั่วบัดกรี|ลวดบัดกรี|ฟลักซ์|หัวแร้ง/],
    ['ชุดตัดแก๊ส-หัวพ่นไฟ', /ตัดแก๊ส|หัวพ่นไฟ|หัวพ่นแก๊ส|เป่าแก๊ส|อะเซทิลีน|เกจ์วัดแรงดัน|เกจวัดแรงดัน|ออกซิเจน/],
    ['ปืนลม-สูบลม', /ปืนฉีดลม|ปืนเป่าลม|สูบลม|เติมลม/],
  ]],
  ['เครื่องมือช่างมือ', [
    ['คีม-ประแจ-ไขควง', /คีม|ประแจ|ไขควง|ปากตาย|แหวนข้าง|ด้ามฟรี|บล็อค|บล็อก/],
    ['ค้อน-สิ่ว-ตะไบ-สกัด', /ค้อน|สิ่ว|ตะไบ|ชะแลง|เหล็กสกัด/],
    ['เครื่องวัด-ตีเส้น-ระดับ', /ตลับเมตร|ตีเส้น|บักเต้า|ปักเต้า|ระดับน้ำ|ฉากเหล็ก|ฉากวัด|เวอร์เนีย|เลเซอร์วัด|ลูกดิ่ง/],
    ['เลื่อย-กรรไกร-มีด', /เลื่อย|กรรไกร|มีด(?!โกน)/],
    ['ปากกาจับ-แคลมป์-รอก-แม่แรง', /ปากกาจับ|แคลมป์|แค้ม|clamp|แม่แรง|รอก|กล่องเครื่องมือ|เข็มขัดช่าง|ปืนยิง/i],
    ['พลั่ว-จอบ-เสียม', /พลั่ว|จอบ|เสียม|คราด/],
  ]],
  ['ประปา-ท่อ-สุขภัณฑ์', [
    ['ก๊อกน้ำ-วาล์ว', /ก๊อก|ก็อก|วาล์ว|วาวล์|ลูกลอย/],
    ['ท่อ-ข้อต่อ-PVC', /ข้อต่อ|ข้องอ|สามทาง|ท่อ ?PVC|ท่อพีวีซี|ยูเนี่ยน|เกลียวใน|เกลียวนอก|นิปเปิ้ล|ท่อประปา|ท่อน้ำ|ท่ออุด|ยูโบลท์|U-Bolt|รัดท่อ|แฮงเกอร์/i],
    ['สุขภัณฑ์-อ่าง-ฝักบัว-สายชำระ', /สะดืออ่าง|ฝักบัว|สายฉีดชำระ|หัวฉีดชำระ|หัวชำระ|ชักโครก|อ่างล้าง|ขาเสียบอ่าง|ฝาส้วม|สายน้ำดี|ราวแขวน|ที่ใส่สบู่/],
    ['สายยาง-ถังน้ำ-ทะลวงท่อ', /สายยาง|ถังเก็บน้ำ|งูเหล็ก|ทะลวงท่อ|ล้างท่อ|ท่อตัน|สปริงทะลวง/],
  ]],
  ['ไฟฟ้า-อิเล็กทรอนิกส์', [
    ['สายไฟ-ปลั๊ก-สวิตช์-เบรกเกอร์', /สายไฟ|ปลั๊ก|สวิตช์|สวิทช์|เต้ารับ|เบรกเกอร์|ฟิวส์|รางไฟ/],
    ['หลอดไฟ-โคมไฟ-ไฟฉาย', /หลอดไฟ|โคมไฟ|ไฟ ?LED|สปอตไลท์|ไฟฉาย|ขั้วหลอด/i],
    ['เครื่องวัดไฟ-มิเตอร์', /มัลติมิเตอร์|มิเตอร์|Sanwa|ไขควงวัดไฟ|เครื่องวัดไฟ/i],
    ['พัดลม-เครื่องใช้ไฟฟ้า', /พัดลม|ปลั๊กพ่วง|ไทม์เมอร์|กระดิ่ง|ออดไฟฟ้า/],
  ]],
  ['น็อต-สกรู-ตะปู-อุปกรณ์ยึด', [
    ['น็อต-สกรู-แหวน', /น็อต|นอต|สกรู|ตะปูควง|เกลียวปล่อย|เกลียวเร่ง|สตัด|แหวนอีแปะ|แหวนสปริง|TURN ?BACKLE/i],
    ['ตะปู-ลูกแม็ก', /ตะปู|ลูกแม็ก|แม็กเดี่ยว|ลวดเย็บ/],
    ['พุก-เคเบิ้ลไทร์-กิ๊บรัด', /พุก|เคเบิ้ลไทร์|เคเบิ้ลไท|สายรัด|หนวดกุ้ง|กิ๊บ|เข็มขัดรัด/],
  ]],
  ['กุญแจ-บานพับ-อุปกรณ์ประตูหน้าต่าง', [
    ['กุญแจ-สายยู', /กุญแจ|สายยู|แม่กุญแจ/],
    ['บานพับ-กลอน-มือจับ-กันชน', /บานพับ|กลอน|มือจับ|มือหมุน|ลูกบิด|กันชนประตู|โช๊คประตู|ตัวล็อค|ขอสับ|บานเกล็ด|บู๊ท/],
    ['ล้อ-ราง-อุปกรณ์รั้ว', /ล้อประตู|ล้อรั้ว|ล้อเลื่อน|ล้อประคอง|รางเลื่อน|ลูกล้อ|ท้าวแขน/],
  ]],
  ['สี-อุปกรณ์ทาสี', [
    ['สี-ทินเนอร์-วานิช', /^สี|สีสเปรย์|สีน้ำมัน|สีน้ำ|ทินเนอร์|น้ำมันสน|รองพื้น|แลคเกอร์|วานิช/],
    ['แปรง-ลูกกลิ้ง-เกรียง', /แปรงทาสี|แปรงทา|แปรงทองเหลือง|แปรงลวด|ลูกกลิ้ง|เกรียง|เกียง|ถาดสี/],
    ['กระดาษทราย-ขัดผิว', /กระดาษทราย|ผ้าทราย|ใยขัด|แปรงขัด/],
  ]],
  ['วัสดุก่อสร้าง-โครงสร้าง', [
    ['ยิปซั่ม-ผ้าฉาบ-ปูน', /ยิปซั่ม|ยิปซัม|ผ้าฉาบ|ปูน|ฉาบ|โป๊ว/],
    ['เหล็ก-ลวด-ตะแกรง', /ลวดตาข่าย|เหล็กฉาก|ลวดหนาม|ลวดผูกเหล็ก|ตะแกรง|เหล็กเส้น/],
    ['บันได-เสาธง-ฉากยึด', /บันได|เสาธง|หัวเสา|ฉากยึด|ขายึด|ชั้นวาง/],
  ]],
  ['เกษตร-สวน', [
    ['ยากำจัดวัชพืช-ปุ๋ย-กำจัดสัตว์', /กำจัดวัชพืช|ฆ่าหญ้า|กลูโฟซิเนต|ไกลโฟเซต|คายี|ปุ๋ย|ยาฆ่าแมลง|กำจัดปลวก|ฮอร์โมน|ดักหนู|กรงดัก/],
    ['อุปกรณ์รดน้ำ-ตัดแต่งต้นไม้', /ฝักบัวรดน้ำ|บัวรดน้ำ|หัวฉีดน้ำ|สปริงเกอร์|กระถาง|มีดพร้า|ตัดกิ่ง/],
    ['ตาข่าย-สแลน-ผ้าฟาง-พลาสติกคลุม', /สแลน|ตาข่าย|พลาสติกปูบ่อ|ผ้าฟาง|บลูชีท|ผ้าใบ|มุ้ง|กรงไก่/],
  ]],
  ['พลาสติก-บรรจุภัณฑ์', [
    ['ถุงพลาสติก', /ถุงหูหิ้ว|ถุงร้อน|ถุงเย็น|ถุงขยะ|ถุงซิป|ถุงแกง|ถุงพลาสติก|พลาสติกห่อ|wrap/i],
    ['กระสอบ-กล่อง-ลัง-เข่ง', /กระสอบ|กล่องพลาสติก|กล่องฝาล็อค|ลังพลาสติก|เข่ง|ตะกร้า/],
    ['ถัง-อ่าง-ภาชนะ', /ถังขยะ|ถังน้ำ|อ่างเปล|กะละมัง|ขันน้ำ|ถังพลาสติก/],
  ]],
  ['ของใช้ในบ้าน-ทำความสะอาด', [
    ['น้ำยา-ผงซักฟอก-เคมีทำความสะอาด', /ผงซักฟอก|น้ำยา|โซดาไฟ|สบู่|แชมพู|กัดสนิม|ขัดเงา|ครอบจักรวาล|SONAX/i],
    ['อุปกรณ์ทำความสะอาด', /ไม้กวาด|ไม้ถูพื้น|ที่ตักขยะ|ฟองน้ำ|ผ้าเช็ด|ไม้ปัดฝุ่น/],
    ['เครื่องเขียน', /ชอล์ค|ชอล์ก|ปากกา|เมจิก|มาร์คเกอร์|ดินสอ/],
    ['ของใช้ทั่วไป-ครัว', /ช้อน|ส้อม|จาน|แก้ว|ไม้แขวนเสื้อ|ร่ม|ถุงเท้า|เชือก|กระติก|หมวก/],
  ]],
  ['เซฟตี้-อุปกรณ์ป้องกัน', [
    ['ถุงมือ', /ถุงมือ/],
    ['แว่น-หน้ากาก-รองเท้า-ชุดกันฝน', /แว่นตา|หน้ากาก|อุดหู|รองเท้า|บูท|นิรภัย|เอี๊ยม|ชุดกันฝน/],
  ]],
];

function categorize(name) {
  for (const [cat, subs] of RULES) {
    for (const [sub, re] of subs) if (re.test(name)) return [cat, sub];
  }
  return ['เบ็ดเตล็ด', 'อื่น ๆ'];
}

// ---------------------------------------------------------------------- fetch

async function fetchAll() {
  const { token } = JSON.parse(fs.readFileSync(path.join(__dirname, '.token.json'), 'utf8'));
  const api = new DuokeApi({ token });
  const SIZE = 50;
  const seen = new Set(), all = [];
  const first = await api.getProductList({ shopId: SHOP.duokeShopId, platform: SHOP.platform, pageNo: 1, pageSize: SIZE });
  const total = Number(first.total);
  const pages = Math.ceil(total / SIZE);
  const take = list => { for (const p of list || []) if (!seen.has(p.productId)) { seen.add(p.productId); all.push(p); } };
  take(first.list);
  for (let page = 2; page <= pages; page++) {
    let r = null;
    for (let a = 0; a < 3 && !r; a++) {
      try { r = await api.getProductList({ shopId: SHOP.duokeShopId, platform: SHOP.platform, pageNo: page, pageSize: SIZE }); }
      catch (e) { console.warn('  retry', page, String(e).slice(0, 60)); await new Promise(r => setTimeout(r, 1500)); }
    }
    take(r?.list);
    process.stdout.write(`\r  ดึงแล้ว ${all.length}/${total}`);
    await new Promise(r => setTimeout(r, 300));
  }
  process.stdout.write('\n');
  write(CACHE, JSON.stringify(all));
  return all;
}

// -------------------------------------------------------------------- helpers
// หมายเหตุ: ไฟล์ที่สร้างออกมา "ไม่มีราคาและไม่มีสต๊อก" ตั้งใจตัดออก เพราะสองอย่างนี้
// เปลี่ยนตลอดและข้อมูลที่ซิงก์มามักไม่ตรงจริง → ให้ดูจากหน้าร้าน/การ์ดสินค้าแทน

/** ตัดคำนำหน้าโปรฯ ในวงเล็บ/ดอกจัน ออกจากชื่อ เหลือชื่อสินค้าจริง */
const cleanName = n => n
  .replace(/\*+/g, ' ')
  .replace(/^[\s]*[\(\[][^)\]]{0,30}[\)\]]\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();
const slug = s => s.replace(/[\\/:*?"<>|]/g, '-');
const rmDir = d => fs.rmSync(d, { recursive: true, force: true });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, 'utf8'); };
const oneLine = s => (s || '').replace(/\s+/g, ' ').trim();

/** ข้อความบรรยายสินค้าจาก extraInfo.descriptionInfo (JSON ซ้อนอยู่ในสตริง) */
function description(p) {
  const raw = p.extraInfo?.descriptionInfo;
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const fields = j.extended_description?.field_list || [];
    return fields.map(f => f.text || '').join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch { return ''; }
}

function brandOf(p) {
  try {
    const b = JSON.parse(p.productBrand || '{}').original_brand_name;
    return b && b !== 'NoBrand' ? b : '';
  } catch { return ''; }
}

/** ตัวเลือกย่อย (ไซซ์/สี/แพ็ค) — เอาเฉพาะชื่อตัวเลือก ไม่เอาราคา/สต๊อก */
function options(p) {
  const seen = new Set();
  return (p.items || [])
    .filter(i => i.itemId)
    .map(i => oneLine(i.attribute || i.itemSku))
    .filter(n => n && !seen.has(n) && seen.add(n));
}

// ชื่อสเปกของ Shopee เป็นอังกฤษ → แปลตัวที่เจอบ่อยให้อ่านง่าย
const ATTR_TH = {
  'Warranty Type': 'ประเภทการรับประกัน', 'Warranty Duration': 'ระยะประกัน',
  'Region of Origin': 'แหล่งผลิต', 'Material': 'วัสดุ', 'Glue Type': 'ชนิดกาว',
  'Saw Type': 'ชนิดใบเลื่อย', 'Formulation': 'รูปแบบผลิตภัณฑ์', 'Product Type': 'ประเภทสินค้า',
  'Tool Surface Compatibility': 'ใช้กับพื้นผิว', 'pack type': 'รูปแบบแพ็ค', 'Tape Type': 'ชนิดเทป',
  'Quantity': 'จำนวนในแพ็ค', 'Electrical Equipment': 'ประเภทอุปกรณ์ไฟฟ้า', 'Length': 'ความยาว',
  'Wall Paint Type': 'ชนิดสีทาผนัง', 'Condition': 'สภาพสินค้า', 'Dimension (L x W x H)': 'ขนาด (ก x ย x ส)',
  'Scent': 'กลิ่น', 'Model': 'รุ่น', 'Power': 'กำลังไฟ', 'Custom Product': 'สินค้าสั่งทำ',
  'indication': 'ใช้สำหรับ', 'Size': 'ขนาด', 'Color': 'สี', 'Weight': 'น้ำหนัก',
};

/** สเปกจาก productAttribute → [[ชื่อ, ค่า], ...] (ตัดข้อมูลที่ไม่ช่วยตอบลูกค้าทิ้ง) */
const SKIP_ATTR = new Set(['Custom Product', 'Warranty Type', 'Warranty Duration']);
function specs(p) {
  try {
    return JSON.parse(p.productAttribute || '[]')
      .filter(a => !SKIP_ATTR.has(a.original_attribute_name))
      .map(a => [
        ATTR_TH[a.original_attribute_name] || a.original_attribute_name,
        (a.attribute_value_list || []).map(v => oneLine(v.original_value_name) + (v.value_unit ? ' ' + v.value_unit : '')).filter(Boolean).join(', '),
      ])
      .filter(([, v]) => v);
  } catch { return []; }
}

/** การรับประกันสรุปเป็นบรรทัดเดียว (แยกออกมาเพราะลูกค้าถามบ่อย) */
function warranty(p) {
  try {
    const at = JSON.parse(p.productAttribute || '[]');
    const g = n => at.find(a => a.original_attribute_name === n)?.attribute_value_list?.[0]?.original_value_name;
    const type = g('Warranty Type'), dur = g('Warranty Duration');
    if (!type && !dur) return '';
    const TH = { 'Supplier Warranty': 'ประกันจากผู้จำหน่าย', 'No Warranty': 'ไม่มีประกัน', 'International Manufacturer Warranty': 'ประกันผู้ผลิต (สากล)', 'Local Manufacturer Warranty': 'ประกันผู้ผลิตในประเทศ', 'Local Supplier Warranty': 'ประกันร้านค้าในประเทศ' };
    const D = { '1 Month': '1 เดือน', '3 Months': '3 เดือน', '6 Months': '6 เดือน', '1 Year': '1 ปี', '2 Years': '2 ปี', '3 Years': '3 ปี' };
    return [TH[type] || type, dur ? (D[dur] || dur) : ''].filter(Boolean).join(' · ');
  } catch { return ''; }
}

// ---------------------------------------------------------------------- build

function build(raw) {
  const today = new Date().toISOString().slice(0, 10);
  const products = raw.map(p => {
    const [cat, sub] = categorize(p.productName);
    return {
      id: p.productId,
      name: oneLine(p.productName),
      short: cleanName(p.productName),
      cat, sub,
      brand: brandOf(p),
      sku: oneLine(p.productSku),
      opts: options(p),
      specs: specs(p),
      warranty: warranty(p),
      image: p.productImage || '',
      url: p.productUrl || `https://shopee.co.th/product/${SHOP.shopeeShopId}/${p.productId}`,
      desc: description(p),
    };
  }).sort((a, b) => a.cat.localeCompare(b.cat, 'th') || a.sub.localeCompare(b.sub, 'th') || a.name.localeCompare(b.name, 'th'));

  rmDir(OUT);

  // ---- จัดกลุ่มตามหมวด (เรียงตามลำดับใน RULES เพื่อให้เลขไฟล์คงที่)
  const order = [...RULES.map(r => r[0]), 'เบ็ดเตล็ด'];
  const byCat = new Map(order.map(c => [c, []]));
  for (const p of products) byCat.get(p.cat).push(p);
  const cats = order.filter(c => byCat.get(c).length);

  const files = new Map();          // cat -> ชื่อไฟล์
  cats.forEach((c, i) => files.set(c, `${String(i + 1).padStart(2, '0')}-${slug(c)}.md`));

  // ---- ไฟล์รายหมวด: 1 บรรทัด = 1 สินค้า + ตัวเลือกย่อย
  for (const cat of cats) {
    const list = byCat.get(cat);
    const bySub = new Map();
    for (const p of list) { if (!bySub.has(p.sub)) bySub.set(p.sub, []); bySub.get(p.sub).push(p); }
    const L = [];
    L.push(`# ${cat} (${list.length} รายการ)`);
    L.push(`ร้าน ${SHOP.name} · Shopee · อัปเดต ${today}`);
    L.push('รูปแบบ: `รหัส | ชื่อสินค้า` · บรรทัด `- ตัวเลือก:` = แบบ/ขนาด/สีที่มีให้เลือก');
    L.push('รายละเอียดเต็มของแต่ละตัว → `รายละเอียด/<รหัส>.md` · ลิงก์ → https://shopee.co.th/product/' + SHOP.shopeeShopId + '/<รหัส>');
    L.push('ไม่มีราคา/สต๊อกในไฟล์นี้ ให้ดูจากหน้าร้านหรือการ์ดสินค้าที่ลูกค้าส่งมา');
    for (const [sub, items] of bySub) {
      L.push('', `## ${sub} (${items.length})`);
      for (const p of items) {
        L.push(`${p.id} | ${p.name}`);
        if (p.opts.length > 1) L.push('- ตัวเลือก: ' + p.opts.join(' · '));
      }
    }
    L.push('');
    write(path.join(OUT, files.get(cat)), L.join('\n'));
  }

  // ---- ดัชนีรวม
  const idx = [];
  idx.push(`# ดัชนีสินค้า — ${SHOP.name} (Shopee: ${SHOP.username})`);
  idx.push('');
  idx.push(`${products.length} รายการ · ${cats.length} หมวด · อัปเดต ${today} · shopid ${SHOP.shopeeShopId}`);
  idx.push('**ไฟล์ชุดนี้ไม่มีราคาและสต๊อก** (ตั้งใจตัดออก เพราะเปลี่ยนบ่อย) มีแต่ชื่อ ตัวเลือก สเปก และรายละเอียดสินค้า');
  idx.push('');
  idx.push('## อ่านไฟล์ไหน');
  idx.push('1. ลูกค้าถามของกลุ่มไหน → เปิดไฟล์หมวดนั้นไฟล์เดียว (ตารางล่าง) จะเห็นชื่อ+ตัวเลือกทั้งหมวด');
  idx.push('2. รู้ชื่อ/รหัสแล้วอยากได้รายละเอียด → `รายละเอียด/<รหัสสินค้า>.md`');
  idx.push('3. ค้นข้ามหมวด (ไม่รู้ว่าอยู่หมวดไหน) → `catalog.tsv` ไฟล์เดียวมีครบทุกชื่อ');
  idx.push('');
  idx.push('## หมวดหมู่');
  idx.push('| # | หมวด | จำนวน | หมวดย่อยข้างใน (จำนวน) | ไฟล์ |');
  idx.push('|---|---|---|---|---|');
  cats.forEach((c, i) => {
    const subs = new Map();
    for (const p of byCat.get(c)) subs.set(p.sub, (subs.get(p.sub) || 0) + 1);
    const txt = [...subs].map(([s, n]) => `${s} (${n})`).join(' · ');
    idx.push(`| ${i + 1} | ${c} | ${byCat.get(c).length} | ${txt} | ${files.get(c)} |`);
  });
  idx.push('');
  idx.push('## หมายเหตุ');
  idx.push('- ชื่อสินค้ามีคำนำหน้าอย่าง (1ชิ้น) / ยกกล่อง12ชิ้น = ปริมาณที่ได้ต่อ 1 คำสั่งซื้อ สินค้าตัวเดียวกันมักมีหลายรายการแยกตามขนาดแพ็ค');
  idx.push('- สินค้าบางตัวผู้ขายไม่ได้เขียนรายละเอียดไว้ ไฟล์ `รายละเอียด/<รหัส>.md` จะมีแค่ชื่อ ตัวเลือก และสเปกเท่าที่มี');
  idx.push('- ต้องการราคา/สต๊อก/โปรโมชัน ให้ดูหน้าร้านหรือถามเจ้าหน้าที่ อย่าเดาจากไฟล์ชุดนี้');
  idx.push('');
  write(path.join(OUT, '_index.md'), idx.join('\n'));

  // ---- catalog.tsv — ค้นข้ามหมวดในไฟล์เดียว
  const tsv = [`# ${SHOP.name} Shopee · ${products.length} รายการ · อัปเดต ${today} · ไม่มีราคา/สต๊อก · ลิงก์=shopee.co.th/product/${SHOP.shopeeShopId}/<id>`];
  tsv.push(['id', 'ชื่อสินค้า', 'หมวด', 'หมวดย่อย', 'แบรนด์', 'ตัวเลือก'].join('\t'));
  for (const p of products) tsv.push([p.id, p.name, p.cat, p.sub, p.brand, p.opts.join(' / ')].join('\t'));
  write(path.join(OUT, 'catalog.tsv'), tsv.join('\n') + '\n');

  // ---- รายละเอียดรายสินค้า แยกไฟล์ละตัว (อ่านเฉพาะตัวที่ลูกค้าถาม = ประหยัดโทเคนสุด)
  let nDesc = 0;
  for (const p of products) {
    const L = [`# ${p.name}`, ''];
    L.push(`- รหัสสินค้า: ${p.id}`);
    L.push(`- หมวด: ${p.cat} / ${p.sub}`);
    if (p.brand) L.push(`- แบรนด์: ${p.brand}`);
    if (p.opts.length) L.push(`- ตัวเลือก (${p.opts.length}): ${p.opts.join(' · ')}`);
    if (p.warranty) L.push(`- การรับประกัน: ${p.warranty}`);
    L.push(`- ลิงก์: ${p.url}`);
    if (p.image) L.push(`- รูป: ${p.image}`);
    if (p.specs.length) {
      L.push('', '## สเปก');
      for (const [k, v] of p.specs) L.push(`- ${k}: ${v}`);
    }
    if (p.desc) {
      nDesc++;
      L.push('', '## รายละเอียดจากผู้ขาย', p.desc);
    }
    L.push('');
    write(path.join(OUT, 'รายละเอียด', `${p.id}.md`), L.join('\n'));
  }

  // ---- README อธิบายโฟลเดอร์
  write(path.join(OUT, 'README.md'), [
    '# knowledge/products — คลังสินค้าร้าน ' + SHOP.name + ' (Shopee)',
    '',
    'สร้างด้วย `node shopee-products.js` (เติม `--fetch` เพื่อดึงข้อมูลใหม่จาก Duoke)',
    'ข้อมูลดิบอยู่ที่ `.cache/shopee-products-raw.json` — ไฟล์ในโฟลเดอร์นี้สร้างใหม่ทับได้เสมอ',
    '',
    '## ไฟล์',
    '| ไฟล์ | ใช้เมื่อไหร่ |',
    '|---|---|',
    '| `_index.md` | อ่านก่อนเสมอ — มีหมวดอะไร กี่รายการ อยู่ไฟล์ไหน |',
    '| `NN-<หมวด>.md` | ลูกค้าถามของกลุ่มเดียว อ่านไฟล์เดียวเห็นทั้งหมวด (ชื่อ + ตัวเลือก) |',
    '| `รายละเอียด/<รหัส>.md` | รายละเอียดสินค้าตัวเดียว — ตัวเลือก สเปก ประกัน คำอธิบายจากผู้ขาย ลิงก์ รูป |',
    '| `catalog.tsv` | ค้นชื่อข้ามทุกหมวดในไฟล์เดียว (' + products.length + ' บรรทัด) |',
    '',
    '## ไม่มีราคาและสต๊อก',
    'ตัดออกตั้งใจ — ราคา/สต๊อกเปลี่ยนบ่อยและข้อมูลที่ซิงก์มาไม่ตรงจริง (สินค้าที่ปิดการขาย',
    'Shopee จะรายงานราคาเป็น 9999 และสต๊อก 0) ถ้าต้องใช้ราคา ให้ดูการ์ดสินค้าที่ลูกค้าส่งมา',
    'หรือหน้าร้านจริง ไฟล์ชุดนี้ตอบได้ว่า "ร้านมีอะไรบ้าง ใช้ยังไง มีตัวเลือกอะไร"',
    '',
    '## ทำไมแยกโฟลเดอร์',
    '`ai-bot.js` → `loadKnowledge()` อ่านเฉพาะไฟล์ชั้นบนสุดของ `knowledge/` ไฟล์ในโฟลเดอร์ย่อยนี้',
    'จึงไม่ถูกยัดเข้า system prompt ทุกครั้ง (สินค้า ' + products.length + ' รายการ = หลายหมื่นโทเคน)',
    'ให้เปิดอ่านเฉพาะไฟล์ที่ต้องใช้ ส่วนภาพรวมสั้น ๆ อยู่ที่ `knowledge/สินค้า-ภาพรวม.md`',
    '',
  ].join('\n'));

  // ---- ภาพรวมสั้น ๆ ไว้ชั้นบนสุด (เข้า prompt อัตโนมัติ)
  const brands = [...products.reduce((m, p) => (p.brand && m.set(p.brand, (m.get(p.brand) || 0) + 1), m), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([b]) => b);
  const ov = [];
  ov.push(`ร้าน ${SHOP.name} (Shopee: ${SHOP.username}) — ขายอุปกรณ์ช่าง ฮาร์ดแวร์ ประปา ไฟฟ้า เกษตร ของใช้ในบ้าน`);
  ov.push(`มีสินค้า ${products.length} รายการ · ข้อมูลอัปเดต ${today}`);
  ov.push('');
  ov.push('หมวดสินค้าที่ร้านมี:');
  cats.forEach(c => {
    const subs = [...new Set(byCat.get(c).map(p => p.sub))].join(', ');
    ov.push(`- ${c} (${byCat.get(c).length} รายการ) — ${subs}`);
  });
  ov.push('');
  ov.push('แบรนด์ที่ขายบ่อย: ' + brands.join(' · '));
  ov.push('');
  ov.push('ใช้ข้อมูลนี้ตอบได้ว่าร้านมีของกลุ่มไหนบ้าง แต่ชื่อรุ่น/ขนาด/รายละเอียดรายตัวไม่ได้อยู่ในนี้');
  ov.push('(อยู่ในโฟลเดอร์ knowledge/products/ เจ้าหน้าที่เปิดดูได้)');
  ov.push('ห้ามเดาราคา สต๊อก หรือสเปกสินค้าที่ไม่มีในบทสนทนา ถ้าลูกค้าถามให้ใส่ธง [[STAFF]] ให้เจ้าหน้าที่ตรวจ');
  ov.push('');
  write(path.join(__dirname, 'knowledge', 'สินค้า-ภาพรวม.md'), ov.join('\n'));

  return { products: products.length, cats: cats.length, nDesc, nOpts: products.filter(p => p.opts.length > 1).length };
}

// ------------------------------------------------------------------------ CLI

const wantFetch = process.argv.includes('--fetch');
let raw;
if (wantFetch || !fs.existsSync(CACHE)) {
  console.log('ดึงสินค้าจาก Duoke...');
  raw = await fetchAll();
} else {
  raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log(`ใช้ข้อมูลใน .cache (${raw.length} สินค้า) — ใส่ --fetch เพื่อดึงใหม่`);
}
const st = build(raw);
console.log(`สร้างเสร็จ → knowledge/products/`);
console.log(`  ${st.products} สินค้า · ${st.cats} หมวด · ${st.products} ไฟล์รายละเอียด (มีคำอธิบายจากผู้ขาย ${st.nDesc}) · มีตัวเลือกย่อย ${st.nOpts}`);
