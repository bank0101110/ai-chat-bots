import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquareDot, Bookmark, ArrowDownUp, BotOff, Search, X } from 'lucide-react';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import { timeShort, tagTone } from '../format';
import type { Conversation, Tag } from '../types';
import PlatformMark from './PlatformMark';
import Avatar from './Avatar';
import TagMenu from './TagMenu';
import { prefetch } from '../cache';

type Props = {
  selectedId?: string;
  onSelect: (c: Conversation) => void;
  onLoaded?: (list: Conversation[]) => void;
  shopId: string;
  tags: Tag[];
  initialQ?: string;
};

const TABS = [
  { key: 'all', label: 'All', title: 'ทั้งหมด' },
  { key: 'awaiting', icon: MessageSquareDot, title: 'รอตอบ — เฉพาะห้องที่ลูกค้าทักมาแล้วยังไม่ได้อ่าน/ตอบ' },
] as const;

export default function ConversationList({ selectedId, onSelect, onLoaded, shopId, tags, initialQ = '' }: Props) {
  const [list, setList] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState('all');
  const [tagId, setTagId] = useState('');
  const [q, setQ] = useState(initialQ);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialQ));
  const [newestFirst, setNewestFirst] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState({ offset: 0, hasMore: false });
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverT = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { if (initialQ) { setQ(initialQ); setSearchOpen(true); } }, [initialQ]);

  const load = useCallback(async (append = false, offset = 0) => {
    setLoading(true);
    try {
      const r = await api<{ list: Conversation[]; hasMore: boolean; nextOffset: number }>('/conversations', {
        query: { filter, shopId, tagId, q, offset, size: 50 },
      });
      setList(xs => (append ? [...xs, ...r.list.filter(c => !xs.some(x => x.id === c.id))] : r.list));
      setNext({ offset: r.nextOffset, hasMore: r.hasMore });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, shopId, tagId, q]);

  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  useEffect(() => { loadedRef.current?.(list); }, [list]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(), q ? 300 : 0);
  }, [load]);

  // แชทเด้ง → รีเฟรช + ไฮไลต์ห้องนั้นแวบหนึ่ง
  useStreamEvent('message', d => {
    const id = d?.conversationId ? String(d.conversationId) : null;
    if (id) {
      setFlash(s => new Set(s).add(id));
      setTimeout(() => setFlash(s => { const n = new Set(s); n.delete(id); return n; }), 2400);
    }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(), 700);
  });
  useStreamEvent('conversations', () => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(), 900);
  });

  const tagOf = (id: string) => tags.find(t => t.id === id);
  const shown = newestFirst ? list : [...list].reverse();
  const activeTag = tagOf(tagId);
  const tabIndex = filter === 'all' ? 0 : 1;
  const pendingCount = list.length && filter === 'awaiting' ? list.length : undefined;

  // ห้องที่เลือก (รวมตอนกดลูกศร) → เลื่อนให้เห็นในรายการ
  useEffect(() => {
    document.querySelector('.convlist .conv.is-active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <aside className="convlist" aria-label="รายการแชท">
      <div className="conv-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.key} role="tab" aria-selected={filter === t.key} title={t.title}
            className={`conv-tab${filter === t.key ? ' is-active' : ''}`} onClick={() => setFilter(t.key)}>
            {'icon' in t ? <><t.icon size={16} strokeWidth={1.8} />{t.key === 'awaiting' && pendingCount ? <span className="tab-count-sm">{pendingCount}</span> : null}</> : <b>{t.label}</b>}
          </button>
        ))}
        <div className="tag-menu-wrap">
          <TagMenu tags={tags} selected={tagId ? [tagId] : []} allowAll title="กรองตามแท็ก"
            onPick={t => setTagId(t?.id ?? '')}
            trigger={open => (
              <button className={`conv-tab${tagId || open ? ' is-on' : ''}`} title="กรองตามแท็ก" aria-expanded={open}>
                <Bookmark size={16} strokeWidth={1.8} /><span className="caret">▾</span>
              </button>
            )} />
        </div>
        <button className={`conv-tab${searchOpen ? ' is-on' : ''}`} title="ค้นหา" onClick={() => setSearchOpen(s => !s)}><Search size={16} strokeWidth={1.8} /></button>
        <span className="tab-ink" style={{ transform: `translateX(${tabIndex * 100}%)`, width: 'calc((100% - 16px) / 4)' }} />
      </div>

      {searchOpen && (
        <label className="search slim">
          <Search size={14} aria-hidden />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="ชื่อลูกค้า / ข้อความล่าสุด" />
          {q && <button className="icon-ghost" onClick={() => setQ('')} aria-label="ล้าง"><X size={14} /></button>}
        </label>
      )}

      <div className="conv-sort">
        <button className="linkish plain" onClick={() => setNewestFirst(v => !v)}>
          เรียงตาม {newestFirst ? 'ล่าสุด' : 'เก่าสุด'} <ArrowDownUp size={12} />
        </button>
        {activeTag && <span className={`tagpill tone-${tagTone(activeTag.color)}`}>{activeTag.name}<button onClick={() => setTagId('')} aria-label="ล้างแท็ก"><X size={11} /></button></span>}
        <span className="grow" />
        <span className="caption">{list.length} ห้อง</span>
      </div>

      <div className="convlist-body">
        {error && <div className="notice notice-error">{error}</div>}
        {loading && !list.length && [0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} className="conv skeleton-row"><span className="skeleton av" /><span className="skeleton-lines"><span className="skeleton" /><span className="skeleton short" /></span></div>
        ))}
        {!error && !loading && list.length === 0 && <div className="empty">ไม่มีห้องแชทตามเงื่อนไขนี้</div>}
        <ul>
          {shown.map((c, i) => (
            <li key={c.id} style={{ ['--d' as string]: `${Math.min(i, 12) * 18}ms` }}>
              <button className={`conv${c.id === selectedId ? ' is-active' : ''}${flash.has(c.id) ? ' flash' : ''}`} onClick={() => onSelect(c)}
                onMouseEnter={() => { clearTimeout(hoverT.current); hoverT.current = setTimeout(() => prefetch(c.id, { shopId: c.shopId, platform: c.platform }), 120); }}
                onMouseLeave={() => clearTimeout(hoverT.current)}>
                {c.awaiting && <span className="conv-flag" title="รอตอบ" />}
                <span className="avatar-wrap">
                  <Avatar src={c.avatar} name={c.buyerName} size={38} />
                  {c.unread > 0 && <span className="av-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
                  <span className="av-plat"><PlatformMark platform={c.platform} size={14} ring /></span>
                </span>
                <span className="conv-main">
                  <span className="conv-top">
                    <span className="conv-name">{c.buyerName ?? c.id}</span>
                    <span className="conv-shop">| {c.shopName}</span>
                    <span className="conv-time">{timeShort(c.lastAt)}</span>
                  </span>
                  <span className="conv-last">
                    {c.aiPaused && <BotOff size={12} aria-label="ปิด AI" />}{c.lastText || '—'}
                  </span>
                  {c.tagIds.length > 0 && (
                    <span className="conv-tags">
                      {c.tagIds.slice(0, 3).map(id => {
                        const t = tagOf(id);
                        return t ? <span key={id} className={`tagpill tone-${tagTone(t.color)}`}>{t.name}</span> : null;
                      })}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {next.hasMore && (
          <button className="btn btn-secondary btn-sm btn-block" disabled={loading} onClick={() => load(true, next.offset)}>
            {loading ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
          </button>
        )}
      </div>
    </aside>
  );
}
