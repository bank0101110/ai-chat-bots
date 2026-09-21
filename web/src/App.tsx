import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import {
  MessageSquareText, Sparkles, BarChart3, Zap, BookOpen, ScrollText, Settings as Cog, Bell, Volume2, VolumeX, Search,
} from 'lucide-react';
import { api, setKey } from './api';
import { useBus, useStreamEvent } from './bus';
import { ding, getPref, setPref } from './prefs';
import type { InboxSummary, Status } from './types';
import Inbox from './pages/Inbox';
import AiReplies from './pages/AiReplies';
import Dashboard from './pages/Dashboard';
import QuickReplies from './pages/QuickReplies';
import Knowledge from './pages/Knowledge';
import Events from './pages/Events';
import Settings from './pages/Settings';

const STATE_TH: Record<string, string> = {
  connected: 'ออนไลน์', reconnecting: 'กำลังต่อใหม่', disconnected: 'หลุด', starting: 'กำลังเริ่ม',
  error: 'ต่อไม่ได้', kicked: 'ถูกเตะออก',
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [unreviewed, setUnreviewed] = useState(0);
  const [needKey, setNeedKey] = useState(false);
  const [sound, setSound] = useState(getPref('sound', 'on') === 'on');
  const [q, setQ] = useState('');
  const { live } = useBus();
  const navigate = useNavigate();

  const load = useCallback(() => {
    api<Status>('/status').then(setStatus).catch(() => {});
    api<{ total: number }>('/ai-replies', { query: { reviewed: 'false', size: 1 } }).then(r => setUnreviewed(r.total)).catch(() => {});
  }, []);
  const loadSummary = useCallback(() => { api<InboxSummary>('/inbox/summary').then(setSummary).catch(() => {}); }, []);

  useEffect(() => {
    load(); loadSummary();
    const t = setInterval(load, 30_000);
    const t2 = setInterval(loadSummary, 45_000);
    const onKey = () => setNeedKey(true);
    window.addEventListener('duoke:need-key', onKey);
    return () => { clearInterval(t); clearInterval(t2); window.removeEventListener('duoke:need-key', onKey); };
  }, [load, loadSummary]);

  // จำนวนยังไม่อ่านโชว์บนแท็บเบราว์เซอร์
  useEffect(() => {
    const n = summary?.unread ?? 0;
    const name = status?.brand?.name ?? 'Duoke Desk';
    document.title = n ? `(${n}) ${name}` : name;
  }, [summary?.unread, status?.brand?.name]);

  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  useStreamEvent('message', () => { ding(); clearTimeout(summaryTimer); summaryTimer = setTimeout(loadSummary, 1200); });
  useStreamEvent('duoke_state', d => setStatus(s => (s ? { ...s, duoke: { ...s.duoke, state: d.state } } : s)));
  useStreamEvent('bot_event', e => { if (e?.event === 'ai_reply') setUnreviewed(n => n + 1); });

  const toggleSound = () => { const v = !sound; setSound(v); setPref('sound', v ? 'on' : 'off'); if (v) ding(); };
  const state = status?.duoke.state ?? 'starting';
  const online = live && state === 'connected';

  const RAIL = [
    { to: '/', label: 'แชท', icon: MessageSquareText, end: true, badge: summary?.unread },
    { to: '/ai', label: 'AI ตอบ', icon: Sparkles, badge: unreviewed },
    { to: '/dashboard', label: 'ภาพรวม', icon: BarChart3 },
    { to: '/quick', label: 'คำตอบสำเร็จรูป', icon: Zap },
    { to: '/knowledge', label: 'ความรู้ AI', icon: BookOpen },
    { to: '/events', label: 'Log บอท', icon: ScrollText },
  ];

  return (
    <div className="shell">
      <nav className="rail" aria-label="เมนูหลัก">
        <NavLink to="/" className="rail-logo" aria-label={status?.brand?.name ?? 'Duoke Desk'} title={status?.brand?.name ?? 'Duoke Desk'}>
          {status?.brand?.logo ? <img className="logo-img" src={status.brand.logo} alt="" /> : <span className="logo-mark" />}
          <span className={`logo-live${online ? ' on' : ''}`} />
        </NavLink>
        {RAIL.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `rail-btn${isActive ? ' is-active' : ''}`} aria-label={n.label}>
            <n.icon size={20} strokeWidth={1.8} />
            {!!n.badge && <span className="rail-badge">{n.badge > 99 ? '99+' : n.badge}</span>}
            <span className="rail-tip">{n.label}</span>
          </NavLink>
        ))}
        <span className="grow" />
        <NavLink to="/settings" className={({ isActive }) => `rail-btn${isActive ? ' is-active' : ''}`} aria-label="ระบบ">
          <Cog size={20} strokeWidth={1.8} />
          <span className="rail-tip">ระบบ</span>
        </NavLink>
        <span className="rail-avatar" title={status?.duoke.account ?? ''}>{(status?.duoke.account ?? '?').slice(0, 1).toUpperCase()}</span>
      </nav>

      <div className="frame">
        <header className="topbar">
          <span className={`state-pill ${online ? 'ok' : 'bad'}`}>
            <span className="state-dot" />{STATE_TH[state] ?? state}
            {status && <em>· AI {status.ai.enabled ? (status.ai.autoSend ? 'ตอบเอง' : 'ร่างอย่างเดียว') : 'ปิด'}</em>}
          </span>
          <form className="global-search" onSubmit={e => { e.preventDefault(); navigate(`/?q=${encodeURIComponent(q)}`); }}>
            <select className="gs-scope" aria-label="ขอบเขตการค้น" defaultValue="all"><option value="all">ทั้งหมด</option></select>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="ค้นหาลูกค้า / ข้อความ" aria-label="ค้นหา" />
            <button className="gs-btn" aria-label="ค้นหา"><Search size={16} /></button>
          </form>
          <div className="topbar-right">
            <span className="caption">{status?.db.ok ? 'SUPABASE ✓' : 'DB —'}</span>
            <button className="icon-btn sm" onClick={toggleSound} aria-label={sound ? 'ปิดเสียงแจ้งเตือน' : 'เปิดเสียงแจ้งเตือน'} title="เสียงแจ้งเตือน">
              {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            <NavLink to="/ai?reviewed=false" className="icon-btn sm bell" aria-label="AI ที่ยังไม่ได้ตรวจ" title="AI ที่ยังไม่ได้ตรวจ">
              <Bell size={16} />
              {unreviewed > 0 && <span className="bell-dot" />}
            </NavLink>
          </div>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<Inbox summary={summary} reloadSummary={loadSummary} />} />
            <Route path="/c/:id" element={<Inbox summary={summary} reloadSummary={loadSummary} />} />
            <Route path="/ai" element={<AiReplies />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/quick" element={<QuickReplies />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/events" element={<Events />} />
            <Route path="/settings" element={<Settings status={status} reload={load} />} />
          </Routes>
        </main>
      </div>

      {needKey && <KeyDialog onDone={() => { setNeedKey(false); load(); }} />}
    </div>
  );
}

function KeyDialog({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState('');
  return (
    <div className="scrim">
      <form className="dialog" onSubmit={e => { e.preventDefault(); setKey(v); onDone(); location.reload(); }}>
        <p className="eyebrow">ต้องใส่รหัสผ่าน</p>
        <h2 className="headline">เข้าใช้ Duoke Desk</h2>
        <input className="input" type="password" autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="UI_PASSWORD" />
        <button className="btn btn-primary" type="submit">เข้าใช้งาน</button>
      </form>
    </div>
  );
}
