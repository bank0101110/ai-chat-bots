import { useEffect, useState } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import type { QuickReply } from '../types';

const EMPTY = { title: '', shortcut: '', text: '' };

export default function QuickReplies() {
  const toast = useToast();
  const [rows, setRows] = useState<QuickReply[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<QuickReply[]>('/quick-replies').then(r => { setRows(r); setError(null); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) await api(`/quick-replies/${editing}`, { method: 'PATCH', body: form });
      else await api('/quick-replies', { method: 'POST', body: form });
      setForm(EMPTY); setEditing(null);
      toast('บันทึกแล้ว');
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const remove = async (r: QuickReply) => {
    if (!confirm(`ลบ "${r.title}"?`)) return;
    await api(`/quick-replies/${r.id}`, { method: 'DELETE' }).catch(err => toast(err.message, 'error'));
    load();
  };

  return (
    <div className="page page-split">
      <section className="block block-cream form-block">
        <p className="eyebrow">{editing ? 'แก้ไข' : 'เพิ่มใหม่'}</p>
        <h1 className="headline">คำตอบสำเร็จรูป</h1>
        <p className="body-sm">ในช่องตอบแชท พิมพ์ <span className="mono-tag">/</span> ตามด้วยคำย่อเพื่อเรียกใช้</p>
        <form className="stack" onSubmit={save}>
          <label className="field"><span>ชื่อ</span>
            <input className="input" required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="เช่น แจ้งเวลาจัดส่ง" />
          </label>
          <label className="field"><span>คำย่อ (ไม่บังคับ)</span>
            <input className="input" value={form.shortcut} onChange={e => setForm({ ...form, shortcut: e.target.value.replace(/\s/g, '') })} placeholder="ship" />
          </label>
          <label className="field"><span>ข้อความ</span>
            <textarea className="input" required rows={6} value={form.text} onChange={e => setForm({ ...form, text: e.target.value })} />
          </label>
          <div className="pill-row">
            <button className="btn btn-primary" type="submit"><Plus size={16} /> {editing ? 'บันทึกการแก้ไข' : 'เพิ่ม'}</button>
            {editing && <button className="btn btn-secondary" type="button" onClick={() => { setEditing(null); setForm(EMPTY); }}>ยกเลิก</button>}
          </div>
        </form>
      </section>

      <section className="list-col">
        {error && <div className="notice notice-error">{error}</div>}
        {!error && rows.length === 0 && <div className="empty">ยังไม่มีคำตอบสำเร็จรูป</div>}
        <ul className="stack">
          {rows.map(r => (
            <li key={r.id} className="template-card">
              <div className="template-head">
                <b>{r.title}</b>
                {r.shortcut && <span className="mono-tag">/{r.shortcut}</span>}
                <span className="grow" />
                <span className="caption">ใช้ {r.useCount} ครั้ง</span>
                <button className="icon-btn sm" aria-label="แก้ไข" onClick={() => { setEditing(r.id); setForm({ title: r.title, shortcut: r.shortcut ?? '', text: r.text }); }}><Pencil size={14} /></button>
                <button className="icon-btn sm" aria-label="ลบ" onClick={() => remove(r)}><Trash2 size={14} /></button>
              </div>
              <p className="pre">{r.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
