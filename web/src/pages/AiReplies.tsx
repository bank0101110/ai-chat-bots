import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, ThumbsUp, ThumbsDown, Check, MessageSquare, BookPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import { useToast } from '../toast';
import { AI_STATUS, aiStatus, platformOf, timeFull } from '../format';
import type { AiReply } from '../types';

type Page = { total: number; page: number; pages: number; list: AiReply[] };

export default function AiReplies() {
  const toast = useToast();
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [params] = useSearchParams();
  const [reviewed, setReviewed] = useState(params.get('reviewed') ?? '');
  const [rating, setRating] = useState('');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [fresh, setFresh] = useState(0);

  const load = () => api<Page>('/ai-replies', {
    query: { status, reviewed, rating, q, page, size: 20,
      from: from ? new Date(`${from}T00:00:00+07:00`).toISOString() : '',
      to: to ? new Date(`${to}T23:59:59+07:00`).toISOString() : '' },
  }).then(d => { setData(d); setError(null); setFresh(0); }).catch(e => setError(e.message));

  useEffect(() => { load(); }, [status, reviewed, rating, q, page, from, to]);
  useEffect(() => { const t = setTimeout(() => { setQ(qLive); setPage(1); }, 350); return () => clearTimeout(t); }, [qLive]);
  useStreamEvent('bot_event', e => { if (e?.event === 'ai_reply') setFresh(n => n + 1); });

  const update = async (r: AiReply, body: Partial<AiReply>) => {
    try {
      const row = await api<AiReply>(`/ai-replies/${r.id}`, { method: 'PATCH', body });
      setData(d => d && { ...d, list: d.list.map(x => (x.id === r.id ? row : x)) });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const toExample = async (r: AiReply) => {
    try {
      const res = await api<{ total: number }>(`/ai-replies/${r.id}/example`, { method: 'POST', body: {} });
      setData(d => d && { ...d, list: d.list.map(x => (x.id === r.id ? { ...x, rating: 'good', reviewed: true } : x)) });
      toast(`เพิ่มเป็นตัวอย่างให้ AI แล้ว (มีทั้งหมด ${res.total} ตัวอย่าง)`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const markAll = async () => {
    if (!confirm('ทำเครื่องหมาย "ตรวจแล้ว" ทุกรายการที่ยังไม่ได้ตรวจ?')) return;
    const r = await api<{ count: number }>('/ai-replies/mark-all-reviewed', { method: 'POST' });
    toast(`ตรวจแล้ว ${r.count} รายการ`);
    load();
  };

  return (
    <div className="page">
      <section className="block block-lilac hero-block">
        <p className="eyebrow">ประวัติคำตอบ AI</p>
        <h1 className="display">AI ตอบอะไรไปบ้าง</h1>
        <p className="subhead">ทุกคำตอบและร่างที่บอทสร้าง เก็บไว้ให้เปิดดูย้อนหลัง ให้คะแนน และส่งคำตอบที่ดีกลับไปเป็นตัวอย่างให้ AI</p>
      </section>

      <div className="filters">
        <label className="search grow">
          <Search size={16} aria-hidden />
          <input value={qLive} onChange={e => setQLive(e.target.value)} placeholder="ค้นคำถาม / คำตอบ / ชื่อลูกค้า" />
        </label>
        <select className="select" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} aria-label="สถานะ">
          <option value="">ทุกสถานะ</option>
          {Object.entries(AI_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="select" value={reviewed} onChange={e => { setReviewed(e.target.value); setPage(1); }} aria-label="การตรวจ">
          <option value="">ตรวจ/ยังไม่ตรวจ</option>
          <option value="false">ยังไม่ตรวจ</option>
          <option value="true">ตรวจแล้ว</option>
        </select>
        <select className="select" value={rating} onChange={e => { setRating(e.target.value); setPage(1); }} aria-label="คะแนน">
          <option value="">ทุกคะแนน</option>
          <option value="good">ตอบดี</option>
          <option value="bad">ตอบไม่ดี</option>
          <option value="none">ยังไม่ให้คะแนน</option>
        </select>
        <input className="input date" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} aria-label="ตั้งแต่วันที่" />
        <input className="input date" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} aria-label="ถึงวันที่" />
        <button className="btn btn-secondary btn-sm" onClick={markAll}><Check size={14} /> ตรวจทั้งหมด</button>
      </div>

      {fresh > 0 && <button className="btn btn-primary btn-sm center" onClick={() => { setPage(1); load(); }}>มีคำตอบใหม่ {fresh} รายการ — โหลด</button>}
      {error && <div className="notice notice-error">{error}</div>}
      {data && <p className="caption">{data.total.toLocaleString('th-TH')} รายการ</p>}

      <ul className="ai-list">
        {data?.list.map(r => {
          const s = aiStatus(r.status);
          const p = platformOf(r.platform);
          return (
            <li key={r.id} className={`ai-card${r.reviewed ? ' is-reviewed' : ''}`}>
              <header className="ai-card-head">
                <span className={`status-pill tone-${s.tone}`}>{s.label}</span>
                <span className="mono-tag" style={{ background: p.color }}>{p.label}</span>
                <b>{r.buyerName ?? r.conversationId}</b>
                <span className="muted-sm">{r.shopName}</span>
                <span className="grow" />
                <time className="muted-sm">{timeFull(r.createdAt)}</time>
              </header>
              <div className="ai-card-body">
                <div>
                  <p className="eyebrow">ลูกค้าถาม</p>
                  <p className="ai-q">{r.question ?? '—'}</p>
                </div>
                <div>
                  <p className="eyebrow">AI ตอบ</p>
                  <p className="ai-a">{r.reply ?? '—'}</p>
                </div>
              </div>
              {(r.reason || r.model) && (
                <p className="muted-sm">
                  {r.reason && <>เหตุผล: {r.reason} </>}
                  {r.model && <span className="mono-sm">· {r.model}{r.tokensIn != null ? ` · ${r.tokensIn}→${r.tokensOut} tokens` : ''}</span>}
                </p>
              )}
              <footer className="ai-card-actions">
                <button className={`icon-btn sm${r.rating === 'good' ? ' is-good' : ''}`} aria-label="ตอบดี" title="ตอบดี"
                  onClick={() => update(r, { rating: r.rating === 'good' ? null : 'good' })}><ThumbsUp size={15} /></button>
                <button className={`icon-btn sm${r.rating === 'bad' ? ' is-bad' : ''}`} aria-label="ตอบไม่ดี" title="ตอบไม่ดี"
                  onClick={() => update(r, { rating: r.rating === 'bad' ? null : 'bad' })}><ThumbsDown size={15} /></button>
                <button className={`chip${r.reviewed ? ' is-active' : ''}`} onClick={() => update(r, { reviewed: !r.reviewed })}>
                  <Check size={13} /> {r.reviewed ? 'ตรวจแล้ว' : 'ทำเครื่องหมายตรวจแล้ว'}
                </button>
                {r.question && r.reply && <button className="chip" onClick={() => toExample(r)}><BookPlus size={13} /> ใช้เป็นตัวอย่างให้ AI</button>}
                <span className="grow" />
                {r.shopId || r.platform ? (
                  <Link className="btn btn-secondary btn-sm" to={`/c/${r.conversationId}?shop=${r.shopId ?? ''}&p=${r.platform ?? ''}&name=${encodeURIComponent(r.buyerName ?? '')}`}>
                    <MessageSquare size={14} /> เปิดแชท
                  </Link>
                ) : null}
              </footer>
              <NoteField value={r.reviewNote} onSave={v => update(r, { reviewNote: v })} />
            </li>
          );
        })}
      </ul>
      {data && data.list.length === 0 && <div className="empty">ยังไม่มีรายการ</div>}

      {data && data.pages > 1 && (
        <nav className="pager" aria-label="หน้า">
          <button className="icon-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label="หน้าก่อน"><ChevronLeft size={16} /></button>
          <span className="caption">หน้า {data.page} / {data.pages}</span>
          <button className="icon-btn" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} aria-label="หน้าถัดไป"><ChevronRight size={16} /></button>
        </nav>
      )}
    </div>
  );
}

function NoteField({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(value ?? '');
  if (!open) {
    return value
      ? <p className="review-note" onClick={() => setOpen(true)}>โน้ต: {value}</p>
      : <button className="linkish" onClick={() => setOpen(true)}>+ เพิ่มโน้ต (ควรตอบว่าอะไร)</button>;
  }
  return (
    <form className="note-form" onSubmit={e => { e.preventDefault(); onSave(v); setOpen(false); }}>
      <input className="input" autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="เช่น ต้องบอกว่าส่งภายใน 1-2 วัน" />
      <button className="btn btn-primary btn-sm" type="submit">บันทึก</button>
    </form>
  );
}
