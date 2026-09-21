import { Filter, RefreshCw, Layers } from 'lucide-react';
import type { InboxSummary } from '../types';
import PlatformMark from './PlatformMark';
import Avatar from './Avatar';

type Props = { summary: InboxSummary | null; shopId: string; onPick: (id: string) => void; onRefresh: () => void };

export default function ShopColumn({ summary, shopId, onPick, onRefresh }: Props) {
  return (
    <aside className="shopcol" aria-label="ร้านค้า">
      <div className="shopcol-head">
        <span className="icon-ghost"><Filter size={16} /></span>
        <span className="caption">ร้านค้า</span>
        <button className="icon-ghost" onClick={onRefresh} aria-label="รีเฟรชจำนวน"><RefreshCw size={15} /></button>
      </div>
      <button className={`shop-item all${shopId === '' ? ' is-active' : ''}`} onClick={() => onPick('')}>
        <span className="shop-ico"><Layers size={15} /></span>
        <span className="shop-name">ทุกร้าน</span>
        {!!summary?.unread && <span className="count">{summary.unread}</span>}
      </button>
      <div className="shop-list-col">
        {!summary && [0, 1, 2].map(i => <span key={i} className="skeleton shop-skel" />)}
        {summary?.shops.map(s => (
          <button key={s.id} className={`shop-item${shopId === s.id ? ' is-active' : ''}`} onClick={() => onPick(s.id)} title={`${s.name} · รอตอบ ${s.awaiting}`}>
            <span className="shop-logo">
              {s.logo ? <Avatar src={s.logo} name={s.name} size={24} square /> : <PlatformMark platform={s.platform} size={24} />}
              {s.logo && <span className="shop-logo-plat"><PlatformMark platform={s.platform} size={12} ring /></span>}
            </span>
            <span className="shop-name">{s.name}</span>
            {s.unread > 0 ? <span className="count">{s.unread}</span> : s.awaiting > 0 ? <span className="count soft">{s.awaiting}</span> : null}
          </button>
        ))}
      </div>
      <div className="shopcol-foot">
        <p className="caption">วันนี้</p>
        <p><b>{summary?.aiToday ?? '—'}</b> AI ตอบ</p>
        <p><b>{summary?.staffToday ?? '—'}</b> แอดมินตอบ</p>
      </div>
    </aside>
  );
}
