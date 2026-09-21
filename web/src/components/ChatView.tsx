import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Send, Zap, Bot, BotOff, Package, Smile, Sparkles, X, Copy, CornerDownLeft, ChevronDown,
  AlertTriangle, PanelRight, ArrowLeft, ExternalLink,
} from 'lucide-react';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import { useToast } from '../toast';
import { money, timeFull, timeStamp, aiStatus, WAITING_TAG } from '../format';
import type { AiReply, Conversation, InboxSummary, Message, QuickReply, Tag } from '../types';
import PlatformMark from './PlatformMark';
import Avatar from './Avatar';
import { fetchMessages, getCached, putCached } from '../cache';

type Props = {
  conv: Conversation;
  tags: Tag[];
  summary: InboxSummary | null;
  onChange: (patch: Partial<Conversation>) => void;
  onOpenProducts: () => void;
  onToggleSide: () => void;
  onBack: () => void;
  insertRef: React.MutableRefObject<((text: string) => void) | null>;
};

const MAX_LEN = 600;
const EMOJI = ['🙏', '😊', '😄', '🥰', '👍', '👌', '🙌', '💯', '✅', '📦', '🚚', '⏰', '💬', '📌', '🎁', '❤️', '🔥', '✨', '😅', '🤝', '📷', '🧾', '🔧', '🛒'];

const WHO: Record<string, string> = {
  ai: 'AI ตอบอัตโนมัติ', ui: 'แอดมิน · Desk', staff: 'แอดมิน', me: 'บัญชีบอท', 'platform-bot': 'ข้อความตอบกลับอัตโนมัติ',
};

export default function ChatView({ conv, tags, summary, onChange, onOpenProducts, onToggleSide, onBack, insertRef }: Props) {
  const toast = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [draftFrom, setDraftFrom] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [quick, setQuick] = useState<QuickReply[]>([]);
  const [pop, setPop] = useState<null | 'quick' | 'emoji' | 'send'>(null);
  const [aiDraft, setAiDraft] = useState<AiReply | null>(null);
  const [dismissWaiting, setDismissWaiting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const known = useRef<Set<string>>(new Set());

  const q = { shopId: conv.shopId, platform: conv.platform };
  const waitingTag = tags.find(t => t.name === WAITING_TAG);
  const isWaiting = Boolean(waitingTag && conv.tagIds.includes(waitingTag.id));

  const load = useCallback(async (silent = false) => {
    const live = silent;             // โหลดเพราะมีข้อความใหม่ → ต้องดึงของสดจริง ไม่ใช้ผลที่กำลังโหลดค้างอยู่
    // มีในแคช → โชว์ทันที แล้วดึงของสดเงียบ ๆ ตามหลัง
    const cached = !silent ? getCached(conv.id) : undefined;
    if (cached) {
      known.current = new Set(cached.list.map(m => m.id));
      setMessages(cached.list); setHasMore(cached.hasMore); setLoading(false);
      silent = true;
    } else if (!silent) setLoading(true);
    try {
      const r = await fetchMessages(conv.id, q, live);
      // ข้อความที่เพิ่งเข้ามา (ไม่ใช่ตอนโหลดครั้งแรก) → ใส่แอนิเมชันเด้งเข้า
      if (silent) {
        const added = r.list.filter(m => !known.current.has(m.id)).map(m => m.id);
        if (added.length) {
          setFresh(new Set(added));
          setTimeout(() => setFresh(new Set()), 900);
        }
      }
      known.current = new Set(r.list.map(m => m.id));
      setMessages(r.list);
      setHasMore(r.hasMore);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conv.id]);

  const loadDraft = useCallback(() => {
    api<AiReply[]>(`/conversations/${conv.id}/ai-replies`).then(rows => {
      const latest = rows[0];
      setAiDraft(latest && ['suggested', 'draft_staff', 'blocked'].includes(latest.status) && !latest.reviewed ? latest : null);
    }).catch(() => setAiDraft(null));
  }, [conv.id]);

  useEffect(() => {
    stickBottom.current = true;
    known.current = new Set();
    setMessages([]); setText(''); setDraftFrom(null); setPop(null); setDismissWaiting(false);
    load();
    loadDraft();
  }, [conv.id]);

  useEffect(() => { api<QuickReply[]>('/quick-replies').then(setQuick).catch(() => {}); }, []);

  useEffect(() => {
    insertRef.current = (t: string) => {
      setText(prev => (prev ? `${prev}\n${t}` : t));
      inputRef.current?.focus();
    };
    return () => { insertRef.current = null; };
  });

  useStreamEvent('message', d => { if (d?.conversationId === conv.id) load(true); });
  useStreamEvent('message_modified', d => { if (!d?.conversationId || d.conversationId === conv.id) load(true); });
  useStreamEvent('send_failed', d => {
    if (d?.conversationId !== conv.id) return;
    toast(`ส่งไม่สำเร็จ${d.reason ? `: ${d.reason}` : ''} — “${d.text ?? ''}”`, 'error');
    load(true);
  });
  useStreamEvent('bot_event', e => {
    if (e?.conversationId !== conv.id) return;
    if (e.event === 'ai_reply') { load(true); loadDraft(); }
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: messages.length && fresh.size ? 'smooth' : 'auto' });
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    const oldest = messages[0]?.time;
    if (!oldest) return;
    const el = scroller.current;
    const prevH = el?.scrollHeight ?? 0;
    stickBottom.current = false;
    const r = await api<{ list: Message[]; hasMore: boolean }>(`/conversations/${conv.id}/messages`, { query: { ...q, before: oldest, size: 40 } });
    setMessages(ms => {
      const merged = [...r.list.filter(m => !ms.some(x => x.id === m.id)), ...ms];
      putCached(conv.id, { list: merged, hasMore: r.hasMore });
      return merged;
    });
    r.list.forEach(m => known.current.add(m.id));
    setHasMore(r.hasMore);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevH; });
  };

  const removeWaiting = async () => {
    if (!waitingTag) return;
    await api(`/conversations/${conv.id}/tags/${waitingTag.id}`, { method: 'DELETE', query: { shopId: conv.shopId } });
    onChange({ tagIds: conv.tagIds.filter(t => t !== waitingTag.id) });
  };

  const setAi = async (paused: boolean) => {
    const r = await api<{ aiPaused: boolean }>(`/conversations/${conv.id}/control`, {
      method: 'PATCH',
      body: { aiPaused: paused, shopId: conv.shopId, platform: conv.platform, buyerName: conv.buyerName, shopName: conv.shopName },
    });
    onChange({ aiPaused: r.aiPaused });
    return r.aiPaused;
  };

  const send = async (after?: 'handled' | 'pause') => {
    const body = text.trim();
    if (!body || sending) return;
    if (body.length > MAX_LEN) { toast(`ข้อความยาวเกิน ${MAX_LEN} ตัวอักษร`, 'error'); return; }
    setSending(true); setPop(null);
    try {
      await api(`/conversations/${conv.id}/reply`, { method: 'POST', body: { ...q, text: body, aiReplyId: draftFrom ?? undefined } });
      setText(''); setDraftFrom(null);
      if (draftFrom) setAiDraft(null);
      stickBottom.current = true;
      if (after === 'handled' && isWaiting) { await removeWaiting(); toast('ส่งแล้ว · เอาแท็กรอเจ้าหน้าที่ออกแล้ว'); }
      if (after === 'pause') { await setAi(true); toast('ส่งแล้ว · ปิด AI ห้องนี้แล้ว'); }
      await load(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const toggleAi = async () => {
    try {
      const paused = await setAi(!conv.aiPaused);
      toast(paused ? 'ปิด AI ห้องนี้แล้ว — บอทจะไม่ตอบห้องนี้' : 'เปิด AI ห้องนี้แล้ว');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  // พิมพ์ / เพื่อเรียกคำตอบสำเร็จรูป
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const quickMatches = useMemo(() => {
    const term = slash ?? '';
    return quick.filter(r => !term || r.title.toLowerCase().includes(term) || (r.shortcut ?? '').toLowerCase().includes(term) || r.text.toLowerCase().includes(term)).slice(0, 8);
  }, [quick, slash]);
  const applyQuick = (r: QuickReply) => {
    setText(slash !== null ? r.text : (text ? `${text}\n${r.text}` : r.text));
    setPop(null);
    api(`/quick-replies/${r.id}/use`, { method: 'POST' }).catch(() => {});
    inputRef.current?.focus();
  };
  const insertAtCursor = (s: string) => {
    const el = inputRef.current;
    if (!el) { setText(t => t + s); return; }
    const a = el.selectionStart ?? text.length, b = el.selectionEnd ?? text.length;
    const next = text.slice(0, a) + s + text.slice(b);
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + s.length, a + s.length); });
  };

  const showQuick = pop === 'quick' || (slash !== null && quickMatches.length > 0);
  // ลูกศรขึ้น/ลงเลือกคำตอบสำเร็จรูป · Enter/Tab ใช้ · Esc ปิด
  const [qIdx, setQIdx] = useState(0);
  useEffect(() => setQIdx(0), [slash, pop]);
  useEffect(() => {
    document.querySelector('.quick-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [qIdx]);
  const len = text.length;

  return (
    <section className="chat" aria-label={`แชทกับ ${conv.buyerName ?? ''}`}>
      <div className="statbar">
        <span>ยังไม่อ่าน <b>{summary?.unread ?? '—'}</b></span>
        <span>รอตอบ <b>{summary?.awaiting ?? '—'}</b></span>
        <span>AI ตอบวันนี้ <b>{summary?.aiToday ?? '—'}</b></span>
        <span>แอดมินตอบวันนี้ <b>{summary?.staffToday ?? '—'}</b></span>
      </div>

      <header className="chat-head">
        <button className="icon-btn sm mobile-only" onClick={onBack} aria-label="กลับ"><ArrowLeft size={16} /></button>
        <span className="head-av">
          <Avatar src={conv.avatar} name={conv.buyerName} size={30} />
          <span className="av-plat"><PlatformMark platform={conv.platform} size={13} ring /></span>
        </span>
        <div className="chat-title">
          <h1 className="chat-name">{conv.buyerName ?? conv.id}</h1>
          <p className="chat-sub">{conv.shopLogo && <Avatar src={conv.shopLogo} name={conv.shopName} size={14} square />}{conv.shopName}</p>
        </div>
        <button className="icon-ghost" title="คัดลอกชื่อลูกค้า" onClick={() => { navigator.clipboard?.writeText(conv.buyerName ?? conv.id); toast('คัดลอกแล้ว'); }}><Copy size={14} /></button>
        <span className="grow" />
        <button className={`ai-switch${conv.aiPaused ? '' : ' on'}`} onClick={toggleAi} role="switch" aria-checked={!conv.aiPaused}
          title={conv.aiPaused ? 'AI ไม่ตอบห้องนี้ — กดเพื่อเปิด' : 'AI ตอบห้องนี้ — กดเพื่อปิด'}>
          <span className="ai-switch-knob">{conv.aiPaused ? <BotOff size={13} /> : <Bot size={13} />}</span>
          <span className="ai-switch-label">AI</span>
        </button>
        <button className="icon-btn sm" onClick={onToggleSide} aria-label="แผงลูกค้า" title="แผงลูกค้า"><PanelRight size={16} /></button>
      </header>

      {isWaiting && !dismissWaiting && (
        <div className="banner banner-coral" role="status">
          <AlertTriangle size={16} />
          <p>ห้องนี้ติดแท็ก <b>{WAITING_TAG}</b> — AI หยุดตอบ รอแอดมินจัดการ</p>
          <button className="btn btn-secondary btn-xs" onClick={() => setDismissWaiting(true)}>ละเลย</button>
          <button className="btn btn-primary btn-xs" onClick={() => removeWaiting().then(() => toast('จัดการแล้ว — เอาแท็กออก')).catch(e => toast(e.message, 'error'))}>จัดการแล้ว</button>
        </div>
      )}

      <div className="messages" ref={scroller} onScroll={onScroll}>
        {hasMore && !loading && <button className="btn btn-secondary btn-xs center" onClick={loadOlder}>ข้อความก่อนหน้า</button>}
        {loading && <div className="msg-skel">{[0, 1, 2].map(i => <span key={i} className={`skeleton bubble-skel${i === 1 ? ' right' : ''}`} />)}</div>}
        {error && <div className="notice notice-error">{error}</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDay = !prev || new Date(prev.time ?? 0).toDateString() !== new Date(m.time ?? 0).toDateString();
          return (
            <div key={m.id}>
              {showDay && m.time && <div className="day-sep"><span>{new Date(m.time).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>}
              <Bubble m={m} enter={fresh.has(m.id)} buyer={{ avatar: conv.avatar, name: conv.buyerName }}
                onRetry={t => { setText(t); inputRef.current?.focus(); }}
                onQuote={t => { setText(x => (x ? `${x}\n` : '') + t); inputRef.current?.focus(); }}
                onCopy={t => { navigator.clipboard?.writeText(t); toast('คัดลอกแล้ว'); }} />
            </div>
          );
        })}
      </div>

      {aiDraft && (
        <div className="banner banner-lilac draft">
          <Sparkles size={16} />
          <div className="draft-body">
            <p className="eyebrow">AI ร่างไว้ · {aiStatus(aiDraft.status).label}</p>
            <p className="draft-text">{aiDraft.reply || '(ไม่มีข้อความ)'}</p>
            {aiDraft.reason && <p className="draft-reason">{aiDraft.reason}</p>}
          </div>
          {aiDraft.reply && <button className="btn btn-magenta btn-xs" onClick={() => { setText(aiDraft.reply!); setDraftFrom(aiDraft.id); inputRef.current?.focus(); }}>ใช้ร่างนี้</button>}
          <button className="icon-btn sm" aria-label="ซ่อนร่าง" onClick={() => {
            api(`/ai-replies/${aiDraft.id}`, { method: 'PATCH', body: { reviewed: true } }).catch(() => {});
            setAiDraft(null);
          }}><X size={14} /></button>
        </div>
      )}

      <div className="composer">
        {showQuick && (
          <div className="pop up wide" role="listbox" aria-label="คำตอบสำเร็จรูป">
            {quickMatches.length === 0 && <p className="pop-empty">ยังไม่มีคำตอบสำเร็จรูป — เพิ่มได้ที่เมนู ⚡</p>}
            {quickMatches.length > 0 && <p className="kbd-hint"><span>↑↓ เลือก</span><span>Enter / Tab ใช้</span><span>Esc ปิด</span></p>}
            {quickMatches.map(r => (
              <button key={r.id} className={`quick-item${quickMatches[qIdx]?.id === r.id ? ' is-active' : ''}`}
                onMouseEnter={() => setQIdx(quickMatches.indexOf(r))} onClick={() => applyQuick(r)}>
                <b>{r.title}</b>{r.shortcut && <span className="mono-tag">/{r.shortcut}</span>}
                <span>{r.text}</span>
              </button>
            ))}
          </div>
        )}
        {pop === 'emoji' && (
          <div className="pop up emoji-pop">
            {EMOJI.map(e => <button key={e} onClick={() => insertAtCursor(e)}>{e}</button>)}
          </div>
        )}
        <div className="composer-tools">
          <button className={`tool${pop === 'emoji' ? ' on' : ''}`} onClick={() => setPop(p => (p === 'emoji' ? null : 'emoji'))} title="อีโมจิ"><Smile size={19} /></button>
          <button className={`tool${pop === 'quick' ? ' on' : ''}`} onClick={() => { setPop(p => (p === 'quick' ? null : 'quick')); inputRef.current?.focus(); }} title="คำตอบสำเร็จรูป"><Zap size={19} /></button>
          <button className="tool" onClick={onOpenProducts} title="ส่งการ์ดสินค้า"><Package size={19} /></button>
          <span className="grow" />
          {draftFrom && <span className="draft-chip"><Sparkles size={12} /> แก้จากร่าง AI <button onClick={() => setDraftFrom(null)} aria-label="ยกเลิก"><X size={11} /></button></span>}
        </div>
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={3}
          value={text}
          placeholder="กด / เพื่อเรียกคำตอบสำเร็จรูป"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { if (!showQuick && !pop) inputRef.current?.blur(); setPop(null); }
            if (showQuick && quickMatches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setQIdx(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + quickMatches.length) % quickMatches.length);
              return;
            }
            if (showQuick && quickMatches[qIdx] && e.key === 'Tab') { e.preventDefault(); applyQuick(quickMatches[qIdx]); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (showQuick && quickMatches[qIdx]) applyQuick(quickMatches[qIdx]); else send();
            }
          }}
        />
        <div className="composer-bar">
          <span className={`counter${len > MAX_LEN ? ' over' : ''}`}>{len}/{MAX_LEN}</span>
          <span className="grow" />
          <div className="split">
            <button className="btn btn-primary split-main" disabled={!text.trim() || sending} onClick={() => send()}>
              <Send size={15} /> {sending ? 'กำลังส่ง…' : 'ส่ง'}
            </button>
            <button className="btn btn-primary split-more" disabled={!text.trim() || sending} onClick={() => setPop(p => (p === 'send' ? null : 'send'))} aria-label="ตัวเลือกการส่ง"><ChevronDown size={15} /></button>
            {pop === 'send' && (
              <div className="pop up right" role="menu">
                <button className="pop-item" onClick={() => send()}><CornerDownLeft size={14} /> ส่ง</button>
                <button className="pop-item" disabled={!isWaiting} onClick={() => send('handled')}><Send size={14} /> ส่ง + จัดการแล้ว (เอาแท็ก{WAITING_TAG}ออก)</button>
                <button className="pop-item" onClick={() => send('pause')}><BotOff size={14} /> ส่ง + ปิด AI ห้องนี้</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Bubble({ m, enter, buyer, onQuote, onCopy, onRetry }: {
  m: Message; enter: boolean; buyer: { avatar: string | null; name: string | null };
  onQuote: (t: string) => void; onCopy: (t: string) => void; onRetry: (t: string) => void;
}) {
  const mine = m.from !== 'customer';
  const text = m.text ?? m.card?.title ?? '';
  return (
    <div className={`msg-row${mine ? ' right' : ''}${enter ? ' enter' : ''}`}>
      {!mine && <span className="msg-av"><Avatar src={m.avatar ?? buyer.avatar} name={buyer.name} size={28} /></span>}
      <div className="msg-col">
        {mine && <span className={`msg-who who-${m.from}`}>{m.from === 'ai' && <Sparkles size={11} />}{WHO[m.from] ?? m.from}{m.sender && m.from === 'staff' ? ` · ${m.sender}` : ''}</span>}
        <div className="msg-line">
          {mine && text && (
            <span className="msg-actions">
              <button onClick={() => onCopy(text)} title="คัดลอก"><Copy size={13} /></button>
            </span>
          )}
          {m.failed && <span className="fail-dot" title={m.failReason ?? 'ส่งไม่สำเร็จ'}><AlertTriangle size={13} /></span>}
          <div className={`bubble from-${m.from}${m.failed ? ' is-failed' : ''}`}>
            {m.kind === 'text' && <p className="bubble-text">{m.text}</p>}
            {m.kind === 'text' && m.translated && <p className="bubble-trans">แปล: {m.translated}</p>}
            {m.kind === 'image' && m.image && <a href={m.image} target="_blank" rel="noreferrer"><img className="bubble-img" src={m.image} alt="รูปจากแชท" loading="lazy" /></a>}
            {m.kind === 'video' && <a className="linkish" href={m.url ?? '#'} target="_blank" rel="noreferrer">▶ วิดีโอ</a>}
            {(m.kind === 'product' || m.kind === 'order') && m.card && (
              <div className="card-msg">
                <CardImage src={m.card.image} url={m.card.url} kind={m.kind} />
                <div>
                  <p className="caption">{m.kind === 'product' ? 'การ์ดสินค้า' : 'คำสั่งซื้อ'}</p>
                  <p className="card-title">{m.card.title || m.card.orderId}</p>
                  {m.card.option && <p className="card-sub">{m.card.option}</p>}
                  {(m.card.price ?? m.card.total) != null && <p className="card-price">{money(m.card.price ?? m.card.total, m.card.currency)}</p>}
                  {m.card.status && <p className="card-sub">{m.card.status}</p>}
                  {m.card.itemId && <p className="mono-sm">ID {m.card.itemId}</p>}
                  {m.card.url && <a className="linkish" href={m.card.url} target="_blank" rel="noreferrer">เปิด <ExternalLink size={12} /></a>}
                </div>
              </div>
            )}
            {m.kind === 'other' && <p className="bubble-text">[{m.type}] {m.text}</p>}
          </div>
          {!mine && text && (
            <span className="msg-actions">
              <button onClick={() => onQuote(`“${text.slice(0, 80)}” `)} title="อ้างอิงในคำตอบ"><CornerDownLeft size={13} /></button>
              <button onClick={() => onCopy(text)} title="คัดลอก"><Copy size={13} /></button>
            </span>
          )}
        </div>
        {m.failed && (
          <p className="fail-note">
            ส่งไม่สำเร็จ{m.failReason ? ` · ${m.failReason}` : ''}
            {text && <button className="linkish" onClick={() => onRetry(text)}>แก้แล้วส่งใหม่</button>}
          </p>
        )}
        <time className="msg-time" title={[timeFull(m.time), m.sendStatus].filter(Boolean).join(' · ')}>{timeStamp(m.time)}</time>
      </div>
    </div>
  );
}

/** รูปในการ์ดสินค้า/ออร์เดอร์ — กดเปิดหน้าสินค้า · รูปเสีย → ไอคอนแทน */
function CardImage({ src, url, kind }: { src?: string | null; url?: string | null; kind: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const ph = <span className="card-ph">{kind === 'product' ? '📦' : '🧾'}</span>;
  if (!src || broken) return ph;
  const img = <img className="card-img" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return url ? <a className="card-img-link" href={url} target="_blank" rel="noreferrer">{img}</a> : img;
}
