/**
 * duoke-realtime.js — รับ "แชทเด้ง" แบบ realtime + ส่งข้อความผ่าน socket
 *
 * ต้องติดตั้ง: npm i socket.io-client
 *
 *   import { DuokeApi } from './duoke-api.js';
 *   import { DuokeRealtime } from './duoke-realtime.js';
 *
 *   const api = new DuokeApi({ token: process.env.DUOKE_TOKEN });
 *   const rt  = new DuokeRealtime({ api });
 *   rt.on('newMessage', e => console.log(e));
 *   await rt.connect();
 *
 * ⚠️ internal API — ไม่ใช่ public API ของ Duoke อาจเปลี่ยนได้ทุกเมื่อ
 */

import { io } from 'socket.io-client';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

export const IM_DOMAINS = [
  'https://im.duoke.com',
  'https://cn-im.duoke.com',
  'https://global-im.duoke.com',
];

export const SDK_APP_ID = 1400575678;
export const SDK_VERSION = '1.0.16';
export const SOCKET_PATH = '/dkim';

export class DuokeRealtime extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./duoke-api.js').DuokeApi} opts.api
   * @param {string} [opts.clientId] uuid คงที่ต่อเครื่อง (หน้าเว็บเก็บใน localStorage.dkImSdkClientId)
   */
  constructor({ api, clientId = randomUUID() } = {}) {
    super();
    this.api = api;
    this.clientId = clientId;
    this.socket = null;
    this.imToken = null;
    this.userId = null;
    this.domainIndex = 0;
  }

  get serverUrl() { return IM_DOMAINS[this.domainIndex % IM_DOMAINS.length]; }

  // ------------------------------------------------------------------ connect

  async connect() {
    // 1) เอา userSig จาก Duoke
    const user = await this.api.getUser();
    // GET /api/v1/user/ ห่อข้อมูลไว้ใน data.user
    const tencent = user?.user?.tencentUserInfo ?? user?.tencentUserInfo;
    if (!tencent?.userId || !tencent?.userSig) {
      throw new Error('ไม่พบ tencentUserInfo ใน GET /api/v1/user/ — บัญชีอาจยังไม่เปิดใช้ IM');
    }
    this.userId = tencent.userId;

    // 2) แลก token ของ IM
    this.imToken = await this._imLogin(tencent);

    // 3) ต่อ socket.io
    this.socket = io(this.serverUrl, {
      transports: ['websocket'],
      path: SOCKET_PATH,
      auth: cb => cb({ token: this.imToken }),
      query: {
        sdkAppId: SDK_APP_ID,
        nonce: Math.random().toString(36),
        timestamp: Date.now(),
        clientType: 3,
        version: SDK_VERSION,
        token: this.imToken,
      },
    });

    this._bind();

    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
    });
    return this;
  }

  async _imLogin({ userId, userSig }) {
    const res = await fetch(`${this.serverUrl}/im/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: SDK_APP_ID,
        userId,
        userSig,
        clientType: 3,
        clientId: this.clientId,
        version: SDK_VERSION,
      }),
    });
    const body = await res.json();
    // ตัว SDK คืน data ตรง ๆ เป็น token string
    const token = typeof body === 'string' ? body : (body.data ?? body.token);
    if (!token) throw new Error(`im/auth/login ไม่คืน token: ${JSON.stringify(body).slice(0, 300)}`);
    return token;
  }

  _bind() {
    const s = this.socket;

    s.on('connect', () => this.emit('state', { state: 'connected' }));
    s.on('disconnect', reason => {
      this.emit('state', { state: 'disconnected', reason });
      if (reason === 'io server disconnect') s.connect();
    });
    s.io.on('reconnect_attempt', attempt => {
      // SDK จริงจะวนเปลี่ยนโดเมนทุกครั้งที่ retry
      this.domainIndex += 1;
      s.io.uri = this.serverUrl;
      this.emit('state', { state: 'reconnecting', attempt, uri: s.io.uri });
    });
    s.io.on('reconnect', () => s.emitWithAck('init').catch(() => {}));

    // ---- event จาก server ----
    s.on('msg/new-msg', raw => this._onNewMsg(raw));
    s.on('msg/modified', raw => this.emit('messageModified', raw));
    s.on('msg/broadcast-msg', raw => this.emit('broadcast', raw));
    s.on('conversation/updated', raw => this.emit('conversationUpdated', raw));
    s.on('user/kicked', raw => this.emit('kicked', raw));
    s.on('user/status-updated', raw => this.emit('userStatus', raw));
  }

  // ------------------------------------------------------------- แชทเด้ง เข้ามา

  _onNewMsg(raw) {
    const list = Array.isArray(raw) ? raw : [raw];
    for (const m of list) {
      const desc = m?.payload?.description;
      let data;
      try { data = JSON.parse(m?.payload?.data ?? '{}'); } catch { data = {}; }

      this.emit('raw', m);

      if (desc === 'system_message_push') {
        // มีข้อความใหม่ในห้องนี้ → ไปดึงเนื้อหาจริงเอง
        this.emit('newMessage', {
          type: desc,
          shopId: data.shopId,
          conversationId: data.conversationId,
          platform: data.platform,
          puid: data.puid,
          time: data.time,
          raw: m,
        });
      } else if (desc === 'system_conversation_push_v2') {
        // รายการห้องแชทอัปเดต — ปกติ payload เป็น gzip + base64
        // แต่บาง push ไม่มี payload (null) หรือส่ง conversations มาตรง ๆ
        let conversations = [];
        try {
          if (typeof data.payload === 'string' && data.payload) {
            conversations = JSON.parse(gunzipSync(Buffer.from(data.payload, 'base64')).toString('utf8'));
          } else if (Array.isArray(data.conversations)) {
            conversations = data.conversations;
          } else if (Array.isArray(data.list)) {
            conversations = data.list;
          }
          // ไม่มีทั้ง payload และ list → push ว่าง/keepalive: ปล่อยเป็น [] ไม่ใช่ error
        } catch (err) {
          this.emit('error', err);
        }
        this.emit('conversations', {
          type: desc,
          shopId: data.shopId,
          minSeq: data.minSeq,
          maxSeq: data.maxSeq,
          conversations,
          raw: m,
        });
      } else {
        this.emit('other', { type: desc, data, raw: m });
      }
    }
  }

  /** ดึงข้อความจริงหลังโดนแชทเด้ง */
  async fetchNewMessages({ shopId, conversationId, platform, pageSize = 20 }) {
    return this.api.getMessageList({ shopId, conversationId, platform, pageNo: 1, pageSize });
  }

  // -------------------------------------------------------------- ส่งข้อความ

  /**
   * ตอบแชท — เส้นทางเดียวกับที่หน้าเว็บใช้จริง
   *
   * @param {object} p
   * @param {string} p.shopId
   * @param {string} p.conversationId
   * @param {string} p.platform         tiktok | shopee | lazada | ...
   * @param {string} p.text             ข้อความ
   * @param {string} p.puid             parent uid ของบัญชี (จาก getUser)
   * @param {string} [p.groupId]        ถ้ามีอยู่แล้วจะข้าม claimConversation
   */
  async sendText({ shopId, conversationId, platform, text, puid, groupId }) {
    return this.sendMessage({
      shopId, conversationId, platform, puid, groupId,
      contentType: 'text',
      content: { text },
      extraMeta: { text },
    });
  }

  /**
   * ส่งข้อความชนิดใด ๆ
   * ลำดับ: claimConversation → msg/create → msg/send
   */
  async sendMessage({
    shopId, conversationId, platform, puid,
    contentType = 'text', content, extraMeta = {}, groupId,
  }) {
    if (!this.socket?.connected) throw new Error('socket ยังไม่เชื่อมต่อ — เรียก connect() ก่อน');

    // 1) เอา groupId
    let gid = groupId;
    if (!gid) {
      const claimed = await this.api.claimConversation({ shopId, conversationId, platform });
      gid = claimed?.groupId;
      if (!gid) throw new Error('claimConversation ไม่คืน groupId');
    }

    // 2) meta ที่ฝั่ง Duoke ใช้ตีความข้อความ
    const cloudCustomData = JSON.stringify({
      puid,
      messageType: contentType,
      dkMessageType: contentType,
      platform,
      ...extraMeta,
    });

    // 3) สร้าง message
    const created = await this.socket.emitWithAck('msg/create', {
      to: gid,
      conversationType: 'GROUP',
      type: 'TIMCustomElem',
      payload: {
        data: JSON.stringify(content),
        description: contentType,
      },
      cloudCustomData,
    });
    if (created?.code !== 200) throw new Error(`msg/create ล้มเหลว: ${JSON.stringify(created)}`);

    // 4) ส่ง
    const sent = await this.socket.emitWithAck('msg/send', created.data);
    if (sent?.code !== 200) throw new Error(`msg/send ล้มเหลว: ${JSON.stringify(sent)}`);

    return { groupId: gid, message: created.data, ack: sent };
  }

  /** ทำเครื่องหมายห้องแชท (markType: 1=ดาว 2=ยังไม่อ่าน 3=พับ) */
  markConversation({ conversationIDList, markType, enableMark = true }) {
    return this.socket.emitWithAck('conversation/mark-conversation', {
      conversationIDList, markType, enableMark,
    });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
}

export default DuokeRealtime;
