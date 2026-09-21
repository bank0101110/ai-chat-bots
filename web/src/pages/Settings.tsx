import type { Status } from '../types';
import { platformOf, timeFull } from '../format';

export default function Settings({ status, reload }: { status: Status | null; reload: () => void }) {
  if (!status) return <div className="page"><div className="empty">กำลังโหลด…</div></div>;
  const { duoke, db, ai, bot } = status;
  return (
    <div className="page">
      <section className="block block-navy hero-block">
        <p className="eyebrow">ระบบ</p>
        <h1 className="display">สถานะการเชื่อมต่อ</h1>
        <p className="subhead">UI ใช้ token ชุดเดียวกับบอท (.token.json) — ล็อกอินครั้งเดียว ทุกโปรเซสใช้ร่วมกัน ไม่เตะกันเอง</p>
        <button className="btn btn-secondary" onClick={reload}>ตรวจอีกครั้ง</button>
      </section>

      <div className="kpis">
        <div className="kpi">
          <p className="eyebrow">Duoke</p>
          <p className="kpi-value sm">{duoke.state}</p>
          <p className="kpi-label">{duoke.account ?? '—'}</p>
          {duoke.error && <p className="notice notice-error">{duoke.error}</p>}
        </div>
        <div className="kpi">
          <p className="eyebrow">ฐานข้อมูล</p>
          <p className="kpi-value sm">{db.ok ? 'ออนไลน์' : db.enabled ? 'ต่อไม่ได้' : 'ยังไม่ตั้ง'}</p>
          <p className="kpi-label">Supabase · Prisma</p>
          {db.error && <p className="notice notice-error">{db.error}</p>}
        </div>
        <div className="kpi">
          <p className="eyebrow">AI</p>
          <p className="kpi-value sm">{ai.enabled ? (ai.autoSend ? 'ตอบเอง' : 'ร่างอย่างเดียว') : 'ปิด'}</p>
          <p className="kpi-label">{ai.provider} · {ai.model}</p>
        </div>
        <div className="kpi">
          <p className="eyebrow">บอท (watch.js)</p>
          <p className="kpi-value sm">{bot ? bot.event : '—'}</p>
          <p className="kpi-label">{bot ? `ล่าสุด ${timeFull(bot.createdAt)}` : 'ยังไม่เห็นอีเวนต์ (ต้องต่อ DB)'}</p>
        </div>
      </div>

      <section className="panel">
        <p className="eyebrow">ร้านที่เชื่อมไว้</p>
        <ul className="shop-list">
          {duoke.shops.map(s => (
            <li key={s.id}><span className="mono-tag" style={{ background: platformOf(s.platform).color }}>{platformOf(s.platform).label}</span> {s.name} <span className="mono-sm">{s.id}</span></li>
          ))}
        </ul>
      </section>

      {!db.enabled && (
        <section className="block block-lime">
          <p className="eyebrow">ตั้งค่าฐานข้อมูล</p>
          <h2 className="headline">ต่อ Supabase ใน 3 ขั้น</h2>
          <ol className="steps">
            <li>ใส่ <code>DATABASE_URL</code> (pooler :6543) และ <code>DIRECT_URL</code> (:5432) ใน .env</li>
            <li>รัน <code>npm run db:push</code> เพื่อสร้างตาราง</li>
            <li>รีสตาร์ต <code>npm run dev</code> และ <code>npm run ui</code></li>
          </ol>
        </section>
      )}
    </div>
  );
}
