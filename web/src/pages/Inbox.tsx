import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import ShopColumn from '../components/ShopColumn';
import ConversationList from '../components/ConversationList';
import ChatView from '../components/ChatView';
import SidePanel, { type PanelTab } from '../components/SidePanel';
import type { Conversation, InboxSummary, Tag } from '../types';

type Props = { summary: InboxSummary | null; reloadSummary: () => void };

export default function Inbox({ summary, reloadSummary }: Props) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [shopId, setShopId] = useState('');
  const [tab, setTab] = useState<PanelTab>('orders');
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 1180);
  const insertRef = useRef<((t: string) => void) | null>(null);
  const listRef = useRef<Conversation[]>([]);

  useEffect(() => { api<Tag[]>('/tags').then(setTags).catch(() => {}); }, []);

  // เปิดจากลิงก์ตรง (/c/:id?shop=..&p=..) เช่น กดมาจากหน้า "AI ตอบ" หรือ Log
  useEffect(() => {
    if (!id) { setConv(null); return; }
    if (conv?.id === id) return;
    const inList = listRef.current.find(c => c.id === id);
    if (inList) { setConv(inList); return; }
    const sid = params.get('shop') || '';
    const platform = params.get('p') || '';
    api<Conversation>(`/conversations/${id}`, { query: { shopId: sid, platform } })
      .then(setConv)
      .catch(() => sid && platform && setConv({
        id, shopId: sid, platform, shopName: null, buyerName: params.get('name'), buyerId: null, avatar: null,
        lastText: '', lastAt: null, unread: 0, awaiting: false, tagIds: [], groupId: null, aiPaused: false, note: null,
      }));
  }, [id]);

  const select = useCallback((c: Conversation) => {
    setConv(c);
    navigate(`/c/${c.id}?shop=${c.shopId}&p=${c.platform}`, { replace: Boolean(id) });
  }, [id, navigate]);

  const onLoaded = useCallback((list: Conversation[]) => {
    listRef.current = list;
    setConv(c => {
      if (!c) return c;
      const fresh = list.find(x => x.id === c.id);
      return fresh ? { ...c, ...fresh, aiPaused: c.aiPaused || fresh.aiPaused, note: c.note ?? fresh.note } : c;
    });
  }, []);

  // ↑/↓ สลับห้อง (ตอนไม่ได้พิมพ์อยู่) · Alt+↑/↓ ใช้ได้ทุกที่ แม้กำลังพิมพ์
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (!e.altKey && typing) return;
      if (document.querySelector('.tagmenu, .pop')) return;          // มีเมนูเปิดอยู่ → ให้เมนูใช้ลูกศรเอง
      const list = listRef.current;
      if (!list.length) return;
      e.preventDefault();
      const i = list.findIndex(c => c.id === conv?.id);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conv?.id, select]);

  const patch = (p: Partial<Conversation>) => setConv(c => (c ? { ...c, ...p } : c));

  return (
    <div className={`inbox${conv ? ' has-conv' : ''}${sideOpen && conv ? ' side-open' : ''}`}>
      <ShopColumn summary={summary} shopId={shopId} onPick={setShopId} onRefresh={reloadSummary} />
      <ConversationList selectedId={conv?.id} onSelect={select} onLoaded={onLoaded} shopId={shopId} tags={tags} initialQ={params.get('q') ?? ''} />
      {conv ? (
        <>
          <ChatView
            conv={conv}
            tags={tags}
            summary={summary}
            onChange={patch}
            onOpenProducts={() => { setSideOpen(true); setTab('products'); }}
            onToggleSide={() => setSideOpen(s => !s)}
            onBack={() => navigate('/')}
            insertRef={insertRef}
          />
          {sideOpen && (
            <SidePanel conv={conv} tags={tags} tab={tab} setTab={setTab} onChange={patch}
              onClose={() => setSideOpen(false)} insertText={t => insertRef.current?.(t)} />
          )}
        </>
      ) : (
        <section className="inbox-empty">
          <div className="board">
            <div className="note n1"><p className="caption">เริ่มต้น</p><p className="note-big">เลือกห้องแชท<br />ทางซ้าย</p></div>
            <div className="note n2"><p className="caption">ทางลัด</p><p><kbd>/</kbd> คำตอบสำเร็จรูป</p><p><kbd>Alt</kbd>+<kbd>↑</kbd><kbd>↓</kbd> สลับห้อง</p></div>
            <div className="note n3"><p className="caption">AI</p><p>ร่างของ AI ขึ้นเหนือช่องพิมพ์ กด <b>ใช้ร่างนี้</b> แล้วแก้ก่อนส่งได้</p></div>
            <div className="note n4"><p className="caption">ปิด AI รายห้อง</p><p>สวิตช์ AI มุมขวาบน — บอทจะไม่ตอบห้องนั้นจนกว่าจะเปิด</p></div>
          </div>
        </section>
      )}
    </div>
  );
}
