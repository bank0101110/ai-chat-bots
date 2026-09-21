import { useEffect, useRef, useState } from 'react';
import {
  X, Send, Search, ThumbsUp, ThumbsDown, Copy, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ExternalLink, Tag as TagIcon, Check, MessageSquarePlus,
} from 'lucide-react';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import { useToast } from '../toast';
import { ORDER_STATUS, aiStatus, money, timeFull, timeShort, platformOf, tagTone } from '../format';
import type { AiReply, CatalogHit, Conversation, Order, OrderDetail, Product, Profile, Tag } from '../types';
import PlatformMark from './PlatformMark';
import Avatar from './Avatar';
import TagMenu from './TagMenu';

export type PanelTab = 'orders' | 'products' | 'ai' | 'note';

type Props = {
  conv: Conversation;
  tags: Tag[];
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  onChange: (patch: Partial<Conversation>) => void;
  insertText: (t: string) => void;
  onClose: () => void;
};

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'orders', label: 'คำสั่งซื้อ' },
  { key: 'products', label: 'สินค้า' },
  { key: 'ai', label: 'AI' },
  { key: 'note', label: 'โน้ต' },
];

export default function SidePanel(props: Props) {
  const { conv, tab, setTab, onClose } = props;
  const tabsRef = useRef<HTMLDivElement>(null);
  const scrollTabs = (d: number) => tabsRef.current?.scrollBy({ left: d * 120, behavior: 'smooth' });
  const idx = TABS.findIndex(t => t.key === tab);

  return (
    <aside className="side" aria-label="ข้อมูลลูกค้า">
      <CustomerCard {...props} />

      <div className="side-card grow-card">
        <div className="side-tabs">
          <button className="icon-ghost" onClick={() => scrollTabs(-1)} aria-label="เลื่อนซ้าย"><ChevronLeft size={16} /></button>
          <div className="side-tabs-track" ref={tabsRef} role="tablist">
            {TABS.map(t => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} className={`side-tab${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
            <span className="side-ink" style={{ transform: `translateX(${idx * 100}%)`, width: `${100 / TABS.length}%` }} />
          </div>
          <button className="icon-ghost" onClick={() => scrollTabs(1)} aria-label="เลื่อนขวา"><ChevronRight size={16} /></button>
          <button className="icon-ghost close-side" onClick={onClose} aria-label="ปิดแผง"><X size={16} /></button>
        </div>
        <div className="side-body" key={`${conv.id}-${tab}`}>
          {tab === 'orders' && <OrdersTab conv={conv} insertText={props.insertText} />}
          {tab === 'products' && <ProductsTab conv={conv} insertText={props.insertText} />}
          {tab === 'ai' && <AiTab conv={conv} insertText={props.insertText} />}
          {tab === 'note' && <NoteTab conv={conv} onChange={props.onChange} />}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------- โปรไฟล์ลูกค้า + แท็ก
function CustomerCard({ conv, tags, onChange }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const p = platformOf(conv.platform);

  useEffect(() => {
    setProfile(null);
    api<Profile>(`/conversations/${conv.id}/profile`, { query: { shopId: conv.shopId, platform: conv.platform, buyerId: conv.buyerId } })
      .then(setProfile).catch(() => {});
  }, [conv.id]);

  const toggleTag = async (t: Tag) => {
    setBusy(t.id);
    try {
      if (conv.tagIds.includes(t.id)) {
        await api(`/conversations/${conv.id}/tags/${t.id}`, { method: 'DELETE', query: { shopId: conv.shopId } });
        onChange({ tagIds: conv.tagIds.filter(x => x !== t.id) });
      } else {
        const r = await api<{ tagIds: string[] }>(`/conversations/${conv.id}/tags`, { method: 'POST', body: { shopId: conv.shopId, platform: conv.platform, tagId: t.id } });
        onChange({ tagIds: r.tagIds });
      }
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  // ป้ายระดับลูกค้าจากประวัติซื้อ
  const level = !profile ? null
    : profile.completed >= 5 ? { label: 'ลูกค้าประจำ', tone: 'lime' }
    : profile.completed >= 2 ? { label: 'ซื้อซ้ำ', tone: 'mint' }
    : profile.completed === 1 ? { label: 'เคยซื้อ 1 ครั้ง', tone: 'cream' }
    : { label: 'ยังไม่เคยซื้อ', tone: 'pink' };

  return (
    <div className="side-card customer">
      <div className="cust-cover" style={{ background: p.color }}>
        <span className="cust-cover-plat"><PlatformMark platform={conv.platform} size={18} /> {p.label}</span>
        {level && <span className={`status-pill tone-${level.tone}`}>{level.label}</span>}
      </div>
      <div className="cust-row">
        <span className="cust-av-wrap"><Avatar src={conv.avatar} name={conv.buyerName} size={48} /></span>
        <div className="cust-info">
          <p className="cust-name">{conv.buyerName ?? '—'}
            <button className="icon-ghost" title="คัดลอกชื่อ" onClick={() => { navigator.clipboard?.writeText(conv.buyerName ?? ''); toast('คัดลอกแล้ว'); }}><Copy size={13} /></button>
          </p>
          <p className="cust-shop">
            {conv.shopLogo ? <Avatar src={conv.shopLogo} name={conv.shopName} size={16} square /> : <PlatformMark platform={conv.platform} size={16} />}
            {conv.shopName}
          </p>
        </div>
      </div>

      <div className="cust-stats">
        <div><b>{profile ? profile.orders : '…'}</b><span>คำสั่งซื้อ</span></div>
        <div><b>{profile ? money(profile.spent, profile.currency) : '…'}</b><span>ยอดซื้อรวม</span></div>
        <div><b>{profile?.lastOrderAt ? timeShort(profile.lastOrderAt) : '—'}</b><span>สั่งล่าสุด</span></div>
      </div>
      {profile && (profile.aiCount != null || profile.cancelled > 0) && (
        <p className="cust-meta">
          {profile.aiCount != null && <span>AI ตอบ {profile.aiCount} ครั้ง</span>}
          {profile.staffCount != null && <span>แอดมินตอบ {profile.staffCount} ครั้ง</span>}
          {profile.cancelled > 0 && <span>ยกเลิก {profile.cancelled}</span>}
          {profile.firstOrderAt && <span>ลูกค้าตั้งแต่ {timeShort(profile.firstOrderAt)}</span>}
        </p>
      )}

      <div className="cust-tags">
        {conv.tagIds.map(id => {
          const t = tags.find(x => x.id === id);
          return t ? <span key={id} className={`tagpill tone-${tagTone(t.color)}`}>{t.name}</span> : null;
        })}
        <TagMenu tags={tags} selected={conv.tagIds} busy={busy} title="ติด / เอาแท็กออก"
          onPick={t => t && toggleTag(t)}
          trigger={open => <button className={`chip xs${open ? ' is-active' : ''}`} aria-expanded={open}><TagIcon size={11} /> เลือกแท็ก</button>} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- คำสั่งซื้อ
function OrdersTab({ conv, insertText }: { conv: Conversation; insertText: (t: string) => void }) {
  const toast = useToast();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);
  const load = () => {
    setSpin(true);
    api<{ list: Order[] }>(`/conversations/${conv.id}/orders`, { query: { shopId: conv.shopId, platform: conv.platform, buyerId: conv.buyerId } })
      .then(r => { setOrders(r.list); setError(null); }).catch(e => setError(e.message)).finally(() => setSpin(false));
  };
  useEffect(() => { setOrders(null); load(); }, [conv.id]);
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast('คัดลอกแล้ว'); };

  if (!conv.buyerId) return <div className="empty">ห้องนี้ไม่มี buyerId — ดึงคำสั่งซื้อไม่ได้</div>;
  if (error) return <div className="notice notice-error">{error}</div>;
  if (!orders) return <div className="stack">{[0, 1].map(i => <span key={i} className="skeleton order-skel" />)}</div>;
  if (!orders.length) return <div className="empty">ยังไม่มีคำสั่งซื้อ</div>;
  return (
    <div className="stack">
      {orders.map((o, i) => (
        <article key={o.orderNumber} className="order" style={{ ['--d' as string]: `${i * 60}ms` }}>
          <div className="order-head">
            <span className={`status-pill tone-${statusTone(o.status)}`}>{ORDER_STATUS[o.status] ?? o.status}</span>
            <span className="grow" />
            {i === 0 && <button className="icon-ghost" onClick={load} aria-label="รีเฟรช"><RefreshCw size={15} className={spin ? 'spin' : ''} /></button>}
          </div>
          <p className="order-no">{o.orderNumber} <button className="icon-ghost" onClick={() => copy(o.orderNumber)} aria-label="คัดลอกเลขคำสั่งซื้อ"><Copy size={13} /></button></p>
          <p className="order-date">{timeFull(o.createdAt)} (UTC+07:00)</p>
          <div className="order-items">
            {o.products.map((p, k) => (
              <OrderItem key={k} p={p} currency={o.currency} />
            ))}
          </div>
          <dl className="order-kv">
            <dt>จำนวนเงินที่ผู้ซื้อชำระ</dt><dd><b>{money(o.amount, o.currency)}</b></dd>
            {o.paymentMethod && <><dt>วิธีการชำระเงิน</dt><dd>{o.paymentMethod}</dd></>}
            {o.paidAt && <><dt>เวลาชำระ</dt><dd>{timeFull(o.paidAt)}</dd></>}
          </dl>
          {o.buyerNote && <p className="order-note">หมายเหตุผู้ซื้อ: {o.buyerNote}</p>}
          {o.logistics && (o.logistics.name || o.logistics.tracking.length > 0) && (
            <div className="order-logi">
              <p className="caption">ข้อมูลโลจิสติกส์</p>
              <p>{o.logistics.name ?? '—'}</p>
              {o.logistics.tracking.map(t => <p key={t} className="mono-sm">{t} <button className="icon-ghost" onClick={() => copy(t)} aria-label="คัดลอกเลขพัสดุ"><Copy size={12} /></button></p>)}
            </div>
          )}
          <OrderMore conv={conv} orderNumber={o.orderNumber} />
          <button className="btn btn-secondary btn-xs" onClick={() => insertText(
            `คำสั่งซื้อ ${o.orderNumber} สถานะ: ${ORDER_STATUS[o.status] ?? o.status}${o.logistics?.tracking.length ? ` · ${o.logistics.name ?? 'ขนส่ง'} เลขพัสดุ ${o.logistics.tracking.join(', ')}` : ''}`,
          )}><MessageSquarePlus size={13} /> ส่งสถานะให้ลูกค้า</button>
        </article>
      ))}
    </div>
  );
}
/** แถวสินค้าในคำสั่งซื้อ — กดแล้วเปิดหน้าสินค้าบนแพลตฟอร์ม */
function OrderItem({ p, currency }: {
  p: { name: string; option: string | null; sku: string | null; quantity: number; price: number | string | null; image: string | null; url?: string | null; originalPrice?: number | string | null };
  currency: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const body = (
    <>
      {p.image && !broken
        ? <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <span className="img-ph">📦</span>}
      <div className="oi-main">
        <p className="oi-name">{p.name}{p.url && <ExternalLink size={11} className="oi-ext" />}</p>
        {p.option && <p className="oi-sub">ตัวเลือกสินค้า: {p.option}</p>}
        {p.sku && <p className="oi-sub">SKU: {p.sku}</p>}
      </div>
      <div className="oi-price">
        <b>{money(p.price, currency)}</b>
        {p.originalPrice != null && Number(p.originalPrice) > Number(p.price) && <s>{money(p.originalPrice, currency)}</s>}
        <span>x {p.quantity}</span>
      </div>
    </>
  );
  return p.url
    ? <a className="order-item link" href={p.url} target="_blank" rel="noreferrer" title="เปิดหน้าสินค้า">{body}</a>
    : <div className="order-item">{body}</div>;
}

/** รายละเอียดเต็มของคำสั่งซื้อ (โหลดเมื่อกดเปิด) */
function OrderMore({ conv, orderNumber }: { conv: Conversation; orderNumber: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen(o => !o);
    if (!data && !error) {
      api<OrderDetail>(`/orders/${encodeURIComponent(orderNumber)}`, { query: { shopId: conv.shopId, platform: conv.platform } })
        .then(setData).catch(e => setError(e.message));
    }
  };
  const fmt = (v: unknown, key = '') => {
    if (typeof v === 'boolean') return v ? 'ใช่' : 'ไม่';
    const s = String(v);
    if (/status$/i.test(key) && ORDER_STATUS[s]) return `${ORDER_STATUS[s]} (${s})`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return timeFull(s);
    return s;
  };
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast('คัดลอกแล้ว'); };
  return (
    <div className="order-more">
      <button className="order-more-btn" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {open ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียดทั้งหมด'}
      </button>
      {open && (
        <div className="order-detail">
          {error && <p className="notice notice-error">{error}</p>}
          {!data && !error && <span className="skeleton order-skel" style={{ height: 90 }} />}
          {data && (
            <>
              {data.items.length > 0 && (
                <section>
                  <p className="caption">สินค้า ({data.items.length})</p>
                  <div className="order-items">
                    {data.items.map((p, i) => <OrderItem key={i} p={p} currency={data.currency} />)}
                  </div>
                </section>
              )}
              {data.groups.map(g => (
                <details key={g.title} className="od-group" open={g.title !== 'ข้อมูลอื่น ๆ'}>
                  <summary className="caption">{g.title} <span>{g.fields.length}</span></summary>
                  <dl className="order-kv">
                    {g.fields.map(f => (
                      <div key={f.key} className="od-row" title={f.key}>
                        <dt>{f.label ?? f.key}</dt>
                        <dd onDoubleClick={() => copy(String(f.value))}>{fmt(f.value, f.key)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
              <p className="od-hint">ดับเบิลคลิกค่าเพื่อคัดลอก</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function statusTone(s: string) {
  if (['COMPLETED', 'DELIVERED', 'TO_CONFIRM_RECEIVE'].includes(s)) return 'mint';
  if (['SHIPPED', 'PROCESSED', 'READY_TO_SHIP', 'RETRY_SHIP'].includes(s)) return 'lime';
  if (['CANCELLED', 'IN_CANCEL', 'TO_RETURN', 'RETURNED', 'INVALID'].includes(s)) return 'pink';
  return 'cream';
}

// ------------------------------------------------------------------ สินค้า
function ProductsTab({ conv, insertText }: { conv: Conversation; insertText: (t: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [source, setSource] = useState<'shop' | 'catalog'>('shop');
  const [items, setItems] = useState<Product[]>([]);
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);

  const search = async () => {
    setLoading(true);
    try {
      if (source === 'shop') setItems((await api<{ list: Product[] }>('/products', { query: { shopId: conv.shopId, platform: conv.platform, q } })).list);
      else setHits(q ? await api<CatalogHit[]>('/catalog', { query: { q } }) : []);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { search(); }, [conv.id, source]);

  const sendCard = async (itemId: string) => {
    setSending(itemId);
    try {
      await api(`/conversations/${conv.id}/product`, { method: 'POST', body: { shopId: conv.shopId, platform: conv.platform, itemId } });
      setSent(s => new Set(s).add(itemId));
      toast('ส่งการ์ดสินค้าแล้ว');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(null); }
  };

  return (
    <div className="stack">
      <div className="seg">
        <button className={source === 'shop' ? 'is-active' : ''} onClick={() => setSource('shop')}>สินค้าในร้าน</button>
        <button className={source === 'catalog' ? 'is-active' : ''} onClick={() => setSource('catalog')}>คลังความรู้</button>
      </div>
      <form className="search slim" onSubmit={e => { e.preventDefault(); search(); }}>
        <Search size={14} aria-hidden />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={source === 'shop' ? 'ชื่อสินค้า หรือ itemId แล้วกด Enter' : 'ค้นจาก catalog ในเครื่อง'} />
      </form>
      {loading && [0, 1, 2].map(i => <span key={i} className="skeleton product-skel" />)}
      {source === 'shop' && !loading && items.map(p => (
        <div key={p.itemId} className="product">
          {p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="img-ph">📦</span>}
          <div className="product-info">
            {p.url
              ? <a className="product-name link" href={p.url} target="_blank" rel="noreferrer">{p.name} <ExternalLink size={11} /></a>
              : <p className="product-name">{p.name}</p>}
            <p className="product-meta">
              <b>{Number(p.minPrice) === Number(p.maxPrice) ? money(p.minPrice, p.currency) : `${money(p.minPrice, p.currency)}–${money(p.maxPrice, p.currency)}`}</b>
              <span>สต็อก {p.stock ?? '—'}</span>
            </p>
            <div className="product-actions">
              <button className={`btn btn-xs ${sent.has(p.itemId) ? 'btn-secondary' : 'btn-primary'}`} disabled={sending === p.itemId} onClick={() => sendCard(p.itemId)}>
                {sent.has(p.itemId) ? <><Check size={12} /> ส่งแล้ว</> : <><Send size={12} /> {sending === p.itemId ? 'กำลังส่ง' : 'ส่งการ์ด'}</>}
              </button>
              {p.url && <button className="btn btn-secondary btn-xs" onClick={() => insertText(p.url!)}>ใส่ลิงก์</button>}
            </div>
          </div>
        </div>
      ))}
      {source === 'shop' && !loading && !items.length && <div className="empty">ไม่พบสินค้า</div>}
      {source === 'catalog' && !loading && hits.map(h => (
        <details key={h.itemId} className="product catalog">
          <summary>
            <p className="product-name">{h.name}</p>
            <p className="product-meta"><span>{h.category}</span><span>{h.brand || '—'}</span></p>
          </summary>
          {h.detail && <pre className="detail">{h.detail}</pre>}
          <div className="product-actions">
            <button className="btn btn-primary btn-xs" disabled={sending === h.itemId} onClick={() => sendCard(h.itemId)}><Send size={12} /> ส่งการ์ด</button>
          </div>
        </details>
      ))}
      {source === 'catalog' && !loading && !hits.length && <div className="empty">{q ? 'ไม่พบใน catalog' : 'พิมพ์ชื่อสินค้าแล้วกด Enter'}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------- AI
function AiTab({ conv, insertText }: { conv: Conversation; insertText: (t: string) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<AiReply[] | null>(null);
  const load = () => api<AiReply[]>(`/conversations/${conv.id}/ai-replies`).then(setRows).catch(() => setRows([]));
  useEffect(() => { setRows(null); load(); }, [conv.id]);
  useStreamEvent('bot_event', e => { if (e?.conversationId === conv.id && e.event === 'ai_reply') load(); });

  const rate = async (r: AiReply, rating: 'good' | 'bad') => {
    try {
      const next = r.rating === rating ? null : rating;
      await api(`/ai-replies/${r.id}`, { method: 'PATCH', body: { rating: next } });
      setRows(xs => xs?.map(x => (x.id === r.id ? { ...x, rating: next, reviewed: true } : x)) ?? null);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!rows) return <div className="stack">{[0, 1].map(i => <span key={i} className="skeleton order-skel" />)}</div>;
  if (!rows.length) return <div className="empty">AI ยังไม่เคยตอบห้องนี้ (หรือยังไม่ได้ต่อฐานข้อมูล)</div>;
  return (
    <ul className="timeline">
      {rows.map(r => {
        const s = aiStatus(r.status);
        return (
          <li key={r.id} className="ai-mini">
            <span className={`tl-dot tone-${s.tone}`} />
            <div className="ai-mini-head">
              <span className={`status-pill tone-${s.tone}`}>{s.label}</span>
              <time className="oi-sub">{timeFull(r.createdAt)}</time>
            </div>
            {r.question && <p className="ai-q">“{r.question}”</p>}
            <p className="ai-a">{r.reply ?? '—'}</p>
            {r.reason && <p className="oi-sub">{r.reason}</p>}
            <div className="ai-mini-actions">
              <button className={`icon-btn xs${r.rating === 'good' ? ' is-good' : ''}`} aria-label="ตอบดี" onClick={() => rate(r, 'good')}><ThumbsUp size={13} /></button>
              <button className={`icon-btn xs${r.rating === 'bad' ? ' is-bad' : ''}`} aria-label="ตอบไม่ดี" onClick={() => rate(r, 'bad')}><ThumbsDown size={13} /></button>
              {r.reply && <button className="linkish" onClick={() => insertText(r.reply!)}><Copy size={12} /> ใช้ข้อความนี้</button>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// -------------------------------------------------------------------- โน้ต
function NoteTab({ conv, onChange }: { conv: Conversation; onChange: (p: Partial<Conversation>) => void }) {
  const toast = useToast();
  const [note, setNote] = useState(conv.note ?? '');
  useEffect(() => setNote(conv.note ?? ''), [conv.id, conv.note]);
  const save = async () => {
    try {
      await api(`/conversations/${conv.id}/control`, { method: 'PATCH', body: { note, shopId: conv.shopId, platform: conv.platform, buyerName: conv.buyerName, shopName: conv.shopName } });
      onChange({ note });
      toast('บันทึกโน้ตแล้ว');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="stack">
      <div className="sticky-note">
        <p className="caption">โน้ตลูกค้า · เห็นเฉพาะทีม</p>
        <textarea rows={7} value={note} onChange={e => setNote(e.target.value)} placeholder="เช่น ขอใบกำกับทุกครั้ง / ลูกค้าประจำ ส่งด่วน" />
      </div>
      <button className="btn btn-primary btn-sm" disabled={note === (conv.note ?? '')} onClick={save}>บันทึกโน้ต</button>
      <dl className="order-kv">
        <dt>Buyer ID</dt><dd className="mono-sm">{conv.buyerId ?? '—'}</dd>
        <dt>ห้อง</dt><dd className="mono-sm">{conv.id}</dd>
      </dl>
    </div>
  );
}
