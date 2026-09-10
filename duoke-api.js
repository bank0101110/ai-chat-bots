/**
 * duoke-api.js — REST client ของ Duoke web (https://web.duoke.com)
 *
 * ใช้ได้ทั้ง Node 18+ (มี fetch ในตัว) และในเบราว์เซอร์
 *
 *   import { DuokeApi } from './duoke-api.js';
 *   const api = new DuokeApi({ token: process.env.DUOKE_TOKEN });
 *
 * token = ค่าคุกกี้ `token` ของ web.duoke.com (DevTools → Application → Cookies)
 *
 * ⚠️ internal API — ไม่ใช่ public API ของ Duoke อาจเปลี่ยนได้ทุกเมื่อ
 */

const DEFAULT_BASE = 'https://web.duoke.com';

export class DuokeError extends Error {
  constructor(code, message, body) {
    super(`Duoke API error ${code}: ${message}`);
    this.name = 'DuokeError';
    this.code = code;
    this.body = body;
  }
}

export class DuokeApi {
  /**
   * @param {object} opts
   * @param {string} opts.token       JWT จากคุกกี้ `token`
   * @param {string} [opts.baseUrl]   default https://web.duoke.com
   * @param {string} [opts.language]  th | en | zh-CN ...
   */
  constructor({ token, baseUrl = DEFAULT_BASE, language = 'th' } = {}) {
    if (!token) throw new Error('ต้องใส่ token (ค่าคุกกี้ `token` ของ web.duoke.com)');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.language = language;
  }

  // ---------------------------------------------------------------- transport

  async _request(method, path, { query, json, form } = {}) {
    let url = this.baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }

    const headers = {
      Accept: 'application/json, text/plain, */*',
      'x-access-token': this.token,
    };
    let body;

    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(form);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new DuokeError(res.status, `ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`, text);
    }

    if (!res.ok) throw new DuokeError(res.status, payload.message || res.statusText, payload);
    if (payload.code !== 0 && payload.code !== undefined && payload.success !== true) {
      throw new DuokeError(payload.code, payload.message || 'request failed', payload);
    }
    return payload.data;
  }

  _get(path, query) { return this._request('GET', path, { query }); }
  _post(path, json) { return this._request('POST', path, { json }); }
  _postForm(path, form) { return this._request('POST', path, { form: form || {} }); }

  // ------------------------------------------------------------------ account

  /** ข้อมูลผู้ใช้ปัจจุบัน — มี tencentUserInfo { userId, userSig } สำหรับต่อ socket */
  getUser() { return this._get('/api/v1/user/', { version: 'web' }); }

  /** รายการร้านค้าทั้งหมด */
  async getShops() {
    const d = await this._get('/api/v1/shop/');
    return Array.isArray(d) ? d : (d?.shops ?? d?.list ?? []);
  }

  // ------------------------------------------------------- conversations (แชท)

  /**
   * รายการห้องแชท
   * @param {object} p
   * @param {string[]} [p.shopIdList]
   * @param {object[]} [p.filterGroups]  ตัวกรองแบบเดียวกับ UI
   * @param {number} [p.size]
   * @param {number} [p.offset]
   * @param {object} [p.sortModel]
   */
  queryConversationList({ shopIdList, filterGroups = [], size = 20, offset = 0, sortModel } = {}) {
    return this._post('/api/v1/im/conversation/queryConversationList', {
      shopIdList, filterGroups, size, offset, sortModel,
    });
  }

  /** จำนวนที่ยังไม่อ่านรวม */
  queryTotalUnreadCount(shopIds) {
    return this._post('/api/v1/im/conversation/queryTotalUnreadCount', { shopIds });
  }

  /** จำนวนที่ "ยังไม่จัดการ" รวม — หน้าเว็บ poll ตัวนี้ทุก ~30 วินาที */
  queryTotalUnHandlerCount() {
    return this._get('/api/v1/im/conversation/queryTotalUnHandlerCount');
  }

  /** ห้องแชทที่ปักหมุด */
  getPinnedConversations() {
    return this._get('/api/v1/im/conversation/getPinnedConversationsList');
  }

  /** รายละเอียดห้องแชท 1 ห้อง */
  viewConversation({ shopId, conversationId, platform }) {
    return this._get('/api/v1/im/conversation/view/v2', { shopId, conversationId, platform });
  }

  /**
   * ประวัติข้อความ
   * NOTE: messageContent เป็น JSON string ต้อง JSON.parse อีกชั้น
   */
  getMessageList({
    shopId, conversationId, platform,
    pageNo = 1, pageSize = 50, language = this.language,
    createTimeStampBefore, createTimeStampAfter,
  }) {
    return this._get('/api/v1/im/message/list', {
      pageNo, pageSize, shopId, conversationId, language, platform,
      createTimeStampBefore, createTimeStampAfter,
    });
  }

  /** ข้อความใหม่กว่า latestMessageId — เบากว่า getMessageList ตอนโดนแชทเด้ง */
  getLatestMessageList({ shopId, conversationId, latestMessageId, language = this.language }) {
    return this._get('/api/v1/chat/getLatestMessageList', {
      conversationId, shopId, latestMessageId, language,
    });
  }

  /**
   * รับเรื่องห้องแชท → คืน groupId ที่ใช้ส่งข้อความผ่าน socket
   * ต้องเรียกก่อนส่งข้อความเสมอ
   */
  claimConversation({ shopId, conversationId, platform }) {
    return this._post('/api/v1/im/conversation/claimConversation/v2', {
      shopId, conversationId, platform,
    });
  }

  // ------------------------------------------------------------ ส่งข้อความ REST

  /**
   * ส่งข้อความ (เส้นทาง REST — ของเก่า/สำรอง)
   * เส้นทางหลักที่หน้าเว็บใช้จริงคือ socket ดู duoke-realtime.js → sendText()
   */
  sendMessageRest({
    conversationId, shopId, toId, contentType = 'text', content,
    referenceId = String(Date.now()), sourceContent,
  }) {
    return this._post('/api/v1/chat/send', {
      referenceId, conversationId, contentType, shopId, toId,
      content: JSON.stringify(content),
      sourceContent,
    });
  }

  /** เปิดแชทใหม่กับผู้ซื้อที่ยังไม่เคยคุย แล้วส่งข้อความแรกทันที */
  openConversationAndSendMessage({ shopId, buyerId, messageType = 'text', messageContent, cloudCustomData }) {
    return this._post('/api/v1/im/conversation/openConversationAndSendMessage', {
      shopId, buyerId, messageType,
      messageContent: typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent),
      cloudCustomData: typeof cloudCustomData === 'string' ? cloudCustomData : JSON.stringify(cloudCustomData),
    });
  }

  /** ส่งข้อความแบบ template */
  sendTemplateMessage({ shopId, conversationId, cloudCustomData }) {
    return this._post('/api/v1/v2/im/conversation/sendMessage', {
      shopId, conversationId,
      cloudCustomData: typeof cloudCustomData === 'string' ? cloudCustomData : JSON.stringify(cloudCustomData),
    });
  }

  // ------------------------------------------------------------------ แท็ก/tag

  /** รายการแท็กทั้งหมดของบัญชี — ใช้ฟิลด์ `id` เป็น tagId */
  getTagList() { return this._postForm('/api/v1/user/tag/getTagList'); }

  /** สร้างแท็กใหม่ — tagColor: blue | red | orange | green */
  addTag({ tagName, tagColor = 'blue' }) {
    return this._postForm('/api/v1/user/tag/addTag', { tagName, tagColor });
  }

  updateTag({ tagId, tagName, tagColor }) {
    return this._post('/api/v1/user/tag/updateTag', { tagId, tagName, tagColor });
  }

  deleteTag({ tagId }) {
    return this._post('/api/v1/user/tag/deleteTag', { tagId });
  }

  batchUpdateTag({ tagList }) {
    return this._post('/api/v1/user/tag/batchUpdateTag', { tagList });
  }

  /**
   * ★ ติดแท็กให้ห้องแชท — แทนที่ทั้งลิสต์ (ไม่ใช่ append)
   * @returns {Promise<Array>} tagList ชุดใหม่ของห้องนั้น
   */
  updateConversationTag({ shopId, conversationId, tagIdList }) {
    return this._post('/api/v1/user/tag/updateConversationTag', {
      shopId, conversationId, tagIdList,
    });
  }

  /** เอาแท็ก 1 ตัวออกจากห้องแชท */
  deleteConversationTag({ shopId, conversationId, tagId }) {
    return this._post('/api/v1/user/tag/deleteConversationTag', {
      shopId, conversationId, tagId,
    });
  }

  /** ค้นห้องแชทตามแท็ก */
  listConversationsByTag({ platform, tagIds, lastTagId, pageSize = 20, nextStartTime }) {
    return this._postForm('/api/v1/im/conversation/listConversationsByTag', {
      platform, tagIds, lastTagId, pageSize, nextStartTime,
    });
  }

  // ------------------------------------------------- คำสั่งซื้อ (แท็บ "คำสั่งซื้อ")

  /**
   * ออร์เดอร์ของลูกค้าในห้องแชท — แท็บ "คำสั่งซื้อ" ในแผงขวา
   *
   * ⚠️ ต้องมี buyerId ไม่งั้นได้ list ว่างเสมอ (buyerId อยู่ใน conversation object)
   * ⚠️ ส่ง buyerName หรือ conversationId ไปด้วยไม่ได้ — ฝั่งเซิร์ฟเวอร์จะตอบ code -1
   *    "system error" (buyerName) หรือ list ว่าง (conversationId) → ส่งแค่ 3 ตัวนี้พอ
   */
  getOrderList({ shopId, buyerId, platform, pageNo = 1, pageSize = 10 }) {
    return this._post('/api/v1/dk/unity/order/list', {
      shopId, buyerId, platform, pageNo, pageSize,
    });
  }

  /** รายละเอียดออร์เดอร์ */
  getOrderDetail({ shopId, platform, orderNumber }) {
    return this._post('/api/v1/dk/unity/order/detail', { shopId, platform, orderNumber });
  }

  /** ดึงออร์เดอร์จากแพลตฟอร์มใหม่ */
  syncOrder({ shopId, platform, orderNumber }) {
    return this._post('/api/v1/dk/unity/order/synchronous', { shopId, orderNumber, platform });
  }

  /**
   * สถานะขนส่ง
   * @param {object} orders รูปแบบ { "<orderNumber>": ["<trackingNo>"] }
   */
  getLogisticsByOrder({ shopId, orders }) {
    return this._postForm('/api/v1/order/getLogisticsByOrder', { shopId, orders });
  }

  /** ออร์เดอร์จากการ์ดที่ส่งในแชท */
  getConversationOrder({ orderId, platform }) {
    return this._get('/api/v1/order/getConversationOrder', { orderId, platform });
  }

  getOrderNote({ platformOrderId, shopId, platform }) {
    return this._get('/api/v1/dk/note/detail', { platformOrderId, shopId, platform });
  }

  editOrderNote({ platformOrderId, shopId, id, platform, content }) {
    return this._post('/api/v1/dk/note/edit', { platformOrderId, shopId, id, platform, content });
  }

  // --------------------------------------------------------- สินค้า (แท็บ "สินค้า")

  /**
   * สินค้าของร้าน — แท็บ "สินค้า" ในแผงขวา
   *
   * @param {object} p
   * @param {string} [p.searchField]  platform_product_name | platform_product_id | platform_product_sku
   * @param {string} [p.sortField]    platform_product_price | platform_product_update_time | platform_product_sales (shopee)
   * @param {'ASC'|'DESC'} [p.sortBy]
   * @param {string} [p.messageItemIds] itemId ที่ลูกค้าเพิ่งถามถึง → ดันขึ้นบนสุด (recentlyConsulted)
   */
  getProductList({
    shopId, platform, searchField, searchValue, sortBy, sortField,
    messageItemIds, pageNo = 1, pageSize = 20,
  }) {
    return this._post('/api/v1/dk/unity/product/list', {
      shopId, platform, searchField, searchValue, sortBy, sortField,
      messageItemIds, pageNo, pageSize,
    });
  }

  /** ซิงก์สินค้าทั้งร้าน (ปุ่มรีเฟรช) */
  syncProducts({ shopId, platform, async: isAsync = true }) {
    return this._post('/api/v1/dk/unity/product/syncByShop', { shopId, platform, async: isAsync });
  }

  /** ซิงก์สินค้าตัวเดียว */
  syncProductById({ shopId, platform, productId }) {
    return this._post('/api/v1/dk/unity/product/syncByProductId', { shopId, platform, productId });
  }

  /** ค้นสินค้าข้ามหลายร้าน (popup เลือกสินค้าส่งเข้าแชท) */
  searchProductItems({
    platform, shopIds, name, productIds, skus, subSku, specification,
    stockStatus, perSellType, type, sortType, sortContent,
    selectedItemSkuIds, pageNo = 1, pageSize = 20,
  }) {
    return this._post('/api/v1/dk/unity/product/itemModule/list', {
      platform, shopIds, stockStatus, perSellType, name, productIds, skus, subSku,
      specification, type, sortType, sortContent, selectedItemSkuIds, pageNo, pageSize,
    });
  }

  /** ข้อมูล voucher (แท็บ Voucher) */
  getVoucherInfo({ shopId, voucherId }) {
    return this._get('/api/v1/voucher/getVoucherInfo', { shopId, voucherId });
  }

  // ----------------------------------------------------------------- ช่วยเหลือ

  /**
   * เพิ่มแท็ก 1 ตัวเข้าห้องแชทโดยไม่ลบของเดิม
   * (updateConversationTag เป็นการแทนที่ จึงต้องอ่านของเดิมมารวมก่อน)
   *
   * @param {object} p
   * @param {string[]} [p.currentTagIds] tagIdList เดิม ถ้ามีอยู่แล้วส่งมาเลยจะเร็วกว่า
   */
  async addTagToConversation({ shopId, conversationId, platform, tagId, currentTagIds }) {
    // ⚠ updateConversationTag เขียนทับรายการแท็กทั้งชุด ไม่ใช่การเพิ่มทีละอัน
    // จึงต้องอ่านของสดจากเซิร์ฟเวอร์เสมอ ห้ามเชื่อรายการที่ผู้เรียกแคชไว้
    // ไม่งั้นแท็กที่เจ้าหน้าที่เพิ่งติดในเว็บ Duoke จะถูกลบทิ้งไปด้วย
    const conv = await this.viewConversation({ shopId, conversationId, platform });
    const live = conv?.tagIdList || conv?.dkConversationVO?.tagIdList || [];
    if (live.includes(tagId)) return live;               // มีอยู่แล้ว ไม่ต้องเขียนอะไร

    // รวมของสดกับที่ผู้เรียกส่งมา (เผื่อผู้เรียกรู้แท็กที่เพิ่งติดแต่เซิร์ฟเวอร์ยังไม่อัปเดต)
    const tagIdList = [...new Set([...live, ...(currentTagIds ?? []), tagId])];

    // การ์ดกันเผลอลบ: รายการใหม่ต้องมีแท็กเดิมครบทุกตัว ไม่งั้นแปลว่ากำลังจะลบของใครบางคน
    const missing = live.filter(t => !tagIdList.includes(t));
    if (missing.length) {
      throw new Error(`ปฏิเสธการเขียนแท็ก: จะทำให้แท็กเดิมหาย ${missing.length} ตัว (${missing.join(', ')})`);
    }

    await this.updateConversationTag({ shopId, conversationId, tagIdList });
    return tagIdList;
  }

  /** หา tagId จากชื่อแท็ก (สร้างให้ถ้ายังไม่มี) */
  async ensureTag({ tagName, tagColor = 'blue' }) {
    const tags = await this.getTagList();
    const found = (tags || []).find(t => t.tagName === tagName);
    if (found) return found.id;
    const created = await this.addTag({ tagName, tagColor });
    const list = Array.isArray(created) ? created : await this.getTagList();
    return (list.find(t => t.tagName === tagName) || {}).id;
  }
}

// -------------------------------------------------------------------- utils

/** axios `postForm` ทำแบบนี้: array → key[]=v1&key[]=v2, object → JSON string */
function encodeForm(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${encodeURIComponent(k)}[]=${encodeURIComponent(item)}`);
    } else if (typeof v === 'object') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(JSON.stringify(v))}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

/** แกะ messageContent (JSON string) ออกมาเป็น object */
export function parseMessageContent(msg) {
  try {
    return typeof msg.messageContent === 'string'
      ? JSON.parse(msg.messageContent)
      : msg.messageContent;
  } catch {
    return { text: msg.messageContent };
  }
}

export default DuokeApi;
