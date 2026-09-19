// Read-only check: never write, remove, or replace conversation tags.
export async function waitingForStaff(api, room, label = 'รอเจ้าหน้าที่', knownIds = []) {
  let ids = knownIds.map(String);
  if (!ids.length) {
    const result = await api.getTagList();
    const tags = Array.isArray(result) ? result : result?.list;
    if (!Array.isArray(tags)) throw new Error('Cannot read tag definitions');
    ids = tags.filter(t => t.tagName === label || t.tagName === 'รอเจ้าหน้าที่').map(t => String(t.id));
    if (!ids.length) return false;
  }
  const view = await api.viewConversation(room);
  const direct = view?.tagIdList ?? view?.dkConversationVO?.tagIdList;
  if (Array.isArray(direct) && direct.length) return direct.some(id => ids.includes(String(id)));
  // viewConversation often omits tags; an empty/missing field is not evidence of no tags.
  for (let page = 0; page < 10; page++) {
    const result = await api.queryConversationList({ shopIdList: [room.shopId], size: 200, offset: page * 200 });
    const rows = result?.list;
    if (!Array.isArray(rows)) throw new Error('Cannot read conversation tags');
    const found = rows.find(r => String(r.conversationId) === String(room.conversationId));
    if (Array.isArray(found?.tagIdList)) return found.tagIdList.some(id => ids.includes(String(id)));
    if (found || !result.hasMore || rows.length < 200) break;
  }
  throw new Error('Cannot verify waiting-for-staff tag');
}
