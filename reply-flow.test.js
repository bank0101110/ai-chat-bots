import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { shopSenderKind, generateReply } from './ai-bot.js';

// Evaluate the production handlers without starting sockets, login, or paid AI calls.
const source = fs.readFileSync(new URL('./watch.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('function humanAfterBuyer('), source.indexOf('\nfunction wireEvents()'));
const buyer = id => ({ fromAccountType: 1, messageId: id, messageType: 'text', messageContent: JSON.stringify({ text: 'ขนาดเท่าไรครับ' }) });
const seller = account => ({ fromAccountType: 2, account, messageSource: account ? 2 : 1, messageType: 'text', messageContent: JSON.stringify({ text: 'ครับ' }) });
function fixture(initial, latest = initial, failSend = false) {
  const sent = [], logs = [];
  let reads = 0, drafts = 0;
  const ctx = vm.createContext({
    api: { getMessageList: async () => ({ list: [...(reads++ ? latest : initial)].reverse() }) },
    ai: { isEnabled: () => true, autoSend: () => true, isInboxMode: () => false, shopSenderKind,
      generateReply: async () => { drafts++; return { reply: 'ดูขนาดได้ที่ตัวเลือกสินค้าครับ', needsStaff: false }; } },
    rt: { sendText: async msg => { if (failSend) throw new Error('send failed'); sent.push(msg); } },
    myUid: 'bot', myPuid: 'puid', answeredMsgId: new Map(), answeredDirty: false, pendingLive: new Map(),
    outRoom: (_e, _i, value) => logs.push(value), out: value => logs.push(value),
    tagInvoiceCase: async () => {}, orderContextFor: async () => '', sendProductCard: async () => {},
    sendHolding: async () => false, oneLine: x => x, shortError: e => e.message, isAuthError: () => false, isRateLimit: () => false,
    stripAnsi: x => x, describe: m => JSON.parse(m.messageContent).text,
    skipWaitingStaff: async () => false,
    aiBlockedByUi: async () => null,
  });
  vm.runInContext(handler, ctx);
  return { ctx, sent, logs, drafts: () => drafts, run: () => ctx.aiRespond({ conversationId: 'room' }, {}) };
}

test('human reply, including a short acknowledgement, skips AI', async () => {
  const f = fixture([buyer('1'), seller('Admin-riw')]);
  assert.equal(await f.run(), 'skipped');
  assert.equal(f.drafts(), 0);
  assert.equal(f.sent.length, 0);
  const result = await generateReply({ messages: [buyer('1'), seller('Admin-riw')], myUid: 'bot' });
  assert.equal(result.skip, true);
});
test('platform and own bot replies do not block an unanswered customer message', async () => {
  for (const account of [null, 'ADMIN-TAK']) {
    const f = fixture([buyer('1'), seller(account)]);
    assert.equal(await f.run(), 'sent');
    assert.equal(f.sent.length, 1);
    assert.equal(await f.run(), 'skipped');
    assert.equal(f.sent.length, 1);
  }
});
test('human answering while AI drafts prevents sending', async () => {
  const f = fixture([buyer('1')], [buyer('1'), seller('Admin-riw')]);
  assert.equal(await f.run(), 'stale');
  assert.equal(f.sent.length, 0);
  assert.equal(f.ctx.answeredMsgId.size, 0);
});
test('waiting-for-staff tag skips generation and also blocks a draft already in progress', async () => {
  const tagged = fixture([buyer('1')]);
  tagged.ctx.skipWaitingStaff = async () => true;
  assert.equal(await tagged.run(), 'stale');
  assert.equal(tagged.drafts(), 0);
  assert.equal(tagged.sent.length, 0);
  const inProgress = fixture([buyer('1')]);
  let checks = 0;
  inProgress.ctx.skipWaitingStaff = async () => ++checks > 1;
  assert.equal(await inProgress.run(), 'stale');
  assert.equal(inProgress.drafts(), 1);
  assert.equal(inProgress.sent.length, 0);
});
test('new customer message invalidates draft and schedules fresh context', async () => {
  const f = fixture([buyer('1')], [buyer('1'), buyer('2')]);
  assert.equal(await f.run(), 'stale');
  assert.equal(f.sent.length, 0);
  assert.equal(f.ctx.pendingLive.has('room'), true);
});
test('failed send is not recorded as answered; success is', async () => {
  const f = fixture([buyer('1')], undefined, true);
  assert.equal(await f.run(), 'error');
  assert.equal(f.ctx.answeredMsgId.size, 0);
  const success = fixture([buyer('1')]);
  assert.equal(await success.run(), 'sent');
  assert.equal(success.ctx.answeredMsgId.get('room'), '1');
});

test('queue reserves live capacity, promotes waiting rooms, and serializes a room', async () => {
  const started = [], releases = [];
  const start = source.indexOf('function enqueueRoom(');
  const end = source.indexOf('async function queueWorker(');
  const ctx = vm.createContext({
    aiQueue: [], activeRooms: new Set(), pendingLive: new Map(), seenInQueue: new Set(), QUEUE_MAX: 200,
    process: { env: { AI_QUEUE_CONCURRENCY: '3' } }, out: () => {}, outRoom: () => {}, shortError: String,
    queueWorker: job => { started.push(job.e.conversationId); return new Promise(resolve => releases.push(resolve)); },
  });
  vm.runInContext(source.slice(start, end), ctx);
  const enqueue = (id, live = false) => ctx.enqueueRoom({ conversationId: id }, {}, null, live);
  enqueue('old1'); enqueue('old2'); enqueue('old3');
  assert.deepEqual(started, ['old1']);
  enqueue('old2', true);
  enqueue('new', true);
  assert.deepEqual(started, ['old1', 'old2', 'new']);
  enqueue('new', true); enqueue('new', true);
  assert.equal(ctx.pendingLive.size, 1);
  assert.equal(started.filter(id => id === 'new').length, 1);
  releases[2]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.filter(id => id === 'new').length, 2);
  for (const release of releases) release();
});

test('UI pause / admin reply from Duoke Desk blocks the AI before drafting', async () => {
  for (const reason of ['paused', 'staff_replied']) {
    const f = fixture([buyer('1')]);
    f.ctx.aiBlockedByUi = async () => reason;
    assert.equal(await f.run(), 'skipped');
    assert.equal(f.drafts(), 0);
    assert.equal(f.sent.length, 0);
  }
});
