import test from 'node:test';
import assert from 'node:assert/strict';
import { waitingForStaff } from './waiting-staff.js';

test('reads missing view tags from conversation list, normalizes IDs and observes removal', async () => {
  let tags = [42, 9];
  const api = {
    getTagList: async () => [{ id: '42', tagName: 'รอเจ้าหน้าที่' }],
    viewConversation: async () => ({ dkConversationVO: {} }),
    queryConversationList: async () => ({ list: [{ conversationId: 'room', tagIdList: tags }] }),
  };
  assert.equal(await waitingForStaff(api, { conversationId: 'room' }), true);
  tags = [9];
  assert.equal(await waitingForStaff(api, { conversationId: 'room' }), false);
  tags = [];
  assert.equal(await waitingForStaff(api, { conversationId: 'room' }), false);
  api.queryConversationList = async () => ({ list: [] });
  await assert.rejects(waitingForStaff(api, { conversationId: 'room' }), /Cannot verify/);
});
