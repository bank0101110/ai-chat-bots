import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useStreamEvent } from '../bus';
import type { Stats } from '../types';

// กลุ่มสถานะในกราฟ — สีผ่านตัวตรวจ palette (CVD/contrast) แล้ว
const GROUPS = [
  { key: 'sent', label: 'ส่งแล้ว', color: '#2f8f57', statuses: ['sent', 'sent_staff'] },
  { key: 'draft', label: 'ร่าง/รอแอดมิน', color: '#7b5cd6', statuses: ['suggested', 'draft_staff'] },
  { key: 'held', label: 'ไม่ส่ง', color: '#d06a3a', statuses: ['blocked', 'no_draft'] },
] as const;

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const load = () => api<Stats>('/stats', { query: { days } }).then(s => { setStats(s); setError(null); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, [days]);
  useStreamEvent('bot_event', e => { if (e?.event === 'ai_reply') load(); });

  const t = stats?.today ?? {};
  const sentToday = (t.sent ?? 0) + (t.sent_staff ?? 0);
  const draftsToday = (t.suggested ?? 0) + (t.draft_staff ?? 0);
  const heldToday = (t.blocked ?? 0) + (t.no_draft ?? 0);

  return (
    <div className="page">
      <section className="block block-lime hero-block">
        <p className="eyebrow">ภาพรวมวันนี้</p>
        <h1 className="display">{sentToday.toLocaleString('th-TH')} <span className="display-unit">คำตอบที่ AI ส่งแล้ว</span></h1>
        <p className="subhead">ลูกค้าทักเข้ามา {stats?.messagesToday ?? 0} ข้อความ · แอดมินตอบผ่าน Desk {stats?.staffToday ?? 0} ครั้ง</p>
      </section>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="kpis">
        <Kpi label="ร่าง / รอแอดมิน" value={draftsToday} hint="วันนี้" />
        <Kpi label="ไม่ส่ง (ข้อมูลไม่ยืนยัน)" value={heldToday} hint="วันนี้" />
        <Kpi label="ยังไม่ได้ตรวจ" value={stats?.unreviewed ?? 0} hint="ทั้งหมด" to="/ai?reviewed=false" />
        <Kpi label="ถูกให้คะแนนว่าไม่ดี" value={stats?.bad ?? 0} hint="ทั้งหมด" to="/ai" />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">AI ตอบรายวัน</p>
            <h2 className="headline">จำนวนคำตอบของ AI แยกตามผล</h2>
          </div>
          <div className="pill-row">
            {[7, 14, 30].map(d => (
              <button key={d} className={`chip${days === d ? ' is-active' : ''}`} onClick={() => setDays(d)}>{d} วัน</button>
            ))}
          </div>
        </div>
        {stats && <DailyChart stats={stats} days={days} />}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint, to }: { label: string; value: number; hint: string; to?: string }) {
  const body = (
    <>
      <p className="eyebrow">{hint}</p>
      <p className="kpi-value">{value.toLocaleString('th-TH')}</p>
      <p className="kpi-label">{label}</p>
    </>
  );
  return to ? <Link to={to} className="kpi">{body}</Link> : <div className="kpi">{body}</div>;
}

function DailyChart({ stats, days }: { stats: Stats; days: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const rows = useMemo(() => {
    const out: { day: string; label: string; values: Record<string, number>; total: number }[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const values: Record<string, number> = {};
      for (const g of GROUPS) {
        values[g.key] = stats.daily.filter(r => r.day === day && (g.statuses as readonly string[]).includes(r.status)).reduce((a, r) => a + r.n, 0);
      }
      out.push({ day, label: d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }), values, total: Object.values(values).reduce((a, b) => a + b, 0) });
    }
    return out;
  }, [stats, days]);

  const W = 760, H = 240, padL = 36, padB = 28, padT = 12;
  const max = Math.max(4, ...rows.map(r => r.total));
  const niceMax = Math.ceil(max / 4) * 4;
  const plotH = H - padB - padT;
  const slot = (W - padL) / rows.length;
  const barW = Math.min(36, slot * 0.6);
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  return (
    <div className="chart">
      <ul className="legend">
        {GROUPS.map(g => <li key={g.key}><span className="swatch" style={{ background: g.color }} />{g.label}</li>)}
      </ul>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="กราฟแท่งซ้อน จำนวนคำตอบ AI ต่อวัน">
          {[0, 0.25, 0.5, 0.75, 1].map(f => (
            <g key={f}>
              <line x1={padL} x2={W} y1={y(niceMax * f)} y2={y(niceMax * f)} className="grid" />
              <text x={padL - 8} y={y(niceMax * f) + 4} className="axis" textAnchor="end">{Math.round(niceMax * f)}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            const segs = GROUPS.filter(g => r.values[g.key] > 0);
            return (
              <g key={r.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={cx - slot / 2} y={padT} width={slot} height={plotH} fill="transparent" />
                {segs.map((g, si) => {
                  const v = r.values[g.key];
                  const top = y(acc + v), bottom = y(acc);
                  acc += v;
                  const isTop = si === segs.length - 1;
                  const h = Math.max(0, bottom - top - (si > 0 ? 2 : 0));   // 2px gap ระหว่างชั้น
                  return isTop
                    ? <path key={g.key} fill={g.color} d={roundTop(cx - barW / 2, top, barW, h, Math.min(4, h))} />
                    : <rect key={g.key} x={cx - barW / 2} y={top} width={barW} height={h} fill={g.color} />;
                })}
                {(days <= 14 || i % 3 === 0) && <text x={cx} y={H - 8} className="axis" textAnchor="middle">{r.label}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%` }}>
            <b>{rows[hover].label}</b>
            {GROUPS.map(g => (
              <span key={g.key}><i className="swatch" style={{ background: g.color }} />{g.label} <b>{rows[hover].values[g.key]}</b></span>
            ))}
            <span>รวม <b>{rows[hover].total}</b></span>
          </div>
        )}
      </div>
      <details className="table-view">
        <summary>ดูเป็นตาราง</summary>
        <table>
          <thead><tr><th>วันที่</th>{GROUPS.map(g => <th key={g.key}>{g.label}</th>)}<th>รวม</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.day}><td>{r.label}</td>{GROUPS.map(g => <td key={g.key}>{r.values[g.key]}</td>)}<td>{r.total}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** แท่งมุมบนมน 4px ฐานตรง */
function roundTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
