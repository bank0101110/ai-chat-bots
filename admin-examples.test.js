import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAdminExamples, relevantAdminExamples } from './admin-examples.js';

test('learns human answers only, deduplicates, filters identifiers, selects relevant examples', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoke-admin-test-'));
  const file = path.join(dir, 'examples.json');
  const msg = (fromAccountType, text, account) => ({ fromAccountType, account, messageContent: JSON.stringify({ text }) });
  const human = m => m.account === 'Admin-riw';
  const history = [msg(1, 'ถุงหิ้วขนาดไหนครับ'), msg(2, 'กรุณารอสักครู่นะครับ', 'bot'), msg(2, 'เลือกขนาดตามตัวเลือกสินค้าได้เลยครับ', 'Admin-riw')];
  try {
    assert.equal(collectAdminExamples(history, human, { file }), 1);
    assert.equal(collectAdminExamples(history, human, { file }), 0);
    assert.match(relevantAdminExamples('ถุงหิ้วขนาดไหน', file), /เลือกขนาด/);
    assert.equal(relevantAdminExamples('สีทาบ้าน', file), '');
    assert.equal(collectAdminExamples([msg(1, 'ขอรายละเอียดหน่อย'), msg(2, 'โทรติดต่อ 0812345678 ได้ครับ', 'Admin-riw')], human, { file }), 0);
    assert.equal(collectAdminExamples([msg(1, 'ขอรายละเอียดหน่อย'), msg(2, 'เลือกขนาดได้เลยครับ', 'bot')], human, { file }), 0);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
