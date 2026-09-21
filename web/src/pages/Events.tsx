import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import { timeFull } from '../format';
import type { BotEvent } from '../types';

const PRESETS = [
  { key: '', label: 'ทั้งหมด' },
  { key: 'ai_reply', label: 'AI ตอบ' },
  { key: 'message', label: 'ข้อความเข้า' },
  { key: 'ai_skip', label: 'AI ข้าม' },
  { key: 'tag_add,invoice_tag,mark_unread', label: 'แท็ก' },
  { key: 'warn,error,rate_limited,relogin', label: 'ปัญหา' },
];

export default function Events() {
  const [rows, setRows] = useState<BotEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    api<BotEvent[]>('/events', { query: { event: filter, size: 150 } }).then(r => { setRows(r); setError(null); }).catch(e => setError(e.message));
  }, [filter]);

  useStreamEvent('bot_event', (e: BotEvent) => {
    if (paused) return;
    if (filter && !filter.split(',').includes(e.event)) return;
    setRows(xs => [e, ...xs].slice(0, 300));
  });

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const more = await api<BotEvent[]>('/events', { query: { event: filter, size: 150, before: last.id } });
    setRows(xs => [...xs, ...more]);
  };

  return (
    <div className="page">
      <div className="panel-head">
        <div>
          <p className="eyebrow">สด จาก watch.js</p>
          <h1 className="headline">Log บอท</h1>
        </div>
        <div className="pill-row">
          {PRESETS.map(p => <button key={p.key} className={`chip${filter === p.key ? ' is-active' : ''}`} onClick={() => setFilter(p.key)}>{p.label}</button>)}
          <button className="chip" onClick={() => setPaused(p => !p)}>{paused ? '▶ ต่อ' : '❚❚ หยุด'}</button>
        </div>
      </div>
      {error && <div className="notice notice-error">{error}</div>}
      <div className="log">
        {rows.map(r => {
          const { event, shop, platform, buyer, conversationId, time, ...rest } = r.payload as Record<string, unknown>;
          void event; void shop; void buyer; void conversationId; void time;
          return (
            <div key={r.id} className={`log-row ev-${r.event}`}>
              <time>{timeFull(r.createdAt)}</time>
              <span className="log-ev">{r.event}</span>
              <span className="log-who">
                {r.conversationId
                  ? <Link to={`/c/${r.conversationId}?shop=${(rest.shopId as string) ?? ''}&p=${(platform as string) ?? ''}`}>{r.buyer ?? r.conversationId}</Link>
                  : '—'}
              </span>
              <code className="log-data">{summarize(r.event, rest)}</code>
            </div>
          );
        })}
      </div>
      {rows.length >= 150 && <button className="btn btn-secondary center" onClick={loadMore}>เก่ากว่านี้</button>}
    </div>
  );
}

function summarize(ev: string, p: Record<string, unknown>) {
  if (ev === 'ai_reply') return `[${p.status}] ${p.text ?? p.reason ?? ''}`;
  if (ev === 'message') return `${p.from}: ${p.text ?? ''}`;
  if (ev === 'ai_skip') return String(p.reason ?? '');
  const { replyTo, result, ...rest } = p;
  void replyTo; void result;
  return JSON.stringify(rest);
}
