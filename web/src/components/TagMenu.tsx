import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import { tagTone } from '../format';
import type { Tag } from '../types';

type Props = {
  tags: Tag[];
  selected: string[];
  onPick: (tag: Tag | null) => void;      // null = "ทุกแท็ก"
  trigger: (open: boolean) => ReactNode;
  allowAll?: boolean;
  busy?: string | null;
  title?: string;
};

/** เมนูเลือกแท็ก — ลอยเหนือทุกคอลัมน์ (ไม่โดนตัดขอบ) มีช่องค้น กด Esc / คลิกข้างนอกเพื่อปิด */
export default function TagMenu({ tags, selected, onPick, trigger, allowAll, busy, title }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btn = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 264, h = Math.min(360, window.innerHeight - 24);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = tags.filter(t => !q || t.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <span ref={btn} className="tagmenu-trigger" onClick={() => { setOpen(o => !o); setQ(''); }}>{trigger(open)}</span>
      {open && createPortal(
        <div ref={pop} className="tagmenu" style={{ top: pos.top, left: pos.left }} role="menu">
          {title && <p className="tagmenu-title">{title}</p>}
          {tags.length > 6 && (
            <label className="tagmenu-search">
              <Search size={13} />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="ค้นแท็ก" />
            </label>
          )}
          <div className="tagmenu-list">
            {allowAll && !q && (
              <button className={`tagmenu-item${selected.length === 0 ? ' on' : ''}`} onClick={() => { onPick(null); setOpen(false); }}>
                <span className="tone-dot all" />ทุกแท็ก{selected.length === 0 && <Check size={13} />}
              </button>
            )}
            {shown.map(t => {
              const on = selected.includes(t.id);
              return (
                <button key={t.id} className={`tagmenu-item${on ? ' on' : ''}`} disabled={busy === t.id} title={t.name}
                  onClick={() => { onPick(t); if (allowAll) setOpen(false); }}>
                  <span className={`tone-dot tone-${tagTone(t.color)}`} />
                  <span className="tagmenu-name">{t.name}</span>
                  {on && <Check size={13} />}
                </button>
              );
            })}
            {!shown.length && <p className="tagmenu-empty">{tags.length ? 'ไม่พบแท็ก' : 'ยังไม่มีแท็กในบัญชี'}</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
