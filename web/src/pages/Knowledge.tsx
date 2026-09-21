import { useEffect, useMemo, useState } from 'react';
import { FileText, Save } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import type { KnowledgeFile } from '../types';

export default function Knowledge() {
  const toast = useToast();
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api<KnowledgeFile[]>('/knowledge').then(setFiles).catch(e => setError(e.message)); }, []);

  const open = async (p: string) => {
    if (content !== original && !confirm('ยังไม่ได้บันทึก — ทิ้งการแก้ไข?')) return;
    const r = await api<{ content: string }>('/knowledge/file', { query: { path: p } });
    setCurrent(p); setContent(r.content); setOriginal(r.content);
  };
  const save = async () => {
    if (!current) return;
    setSaving(true);
    try {
      await api('/knowledge/file', { method: 'PUT', body: { path: current, content } });
      setOriginal(content);
      toast('บันทึกแล้ว — AI อ่านไฟล์ใหม่อัตโนมัติ ไม่ต้องรีสตาร์ต');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSaving(false); }
  };

  const groups = useMemo(() => {
    const m = new Map<string, KnowledgeFile[]>();
    for (const f of files) m.set(f.folder || 'knowledge/', [...(m.get(f.folder || 'knowledge/') ?? []), f]);
    return [...m];
  }, [files]);

  return (
    <div className="page page-split knowledge">
      <aside className="list-col">
        <p className="eyebrow">ไฟล์ความรู้ของ AI</p>
        {error && <div className="notice notice-error">{error}</div>}
        {groups.map(([folder, list]) => (
          <div key={folder} className="file-group">
            <p className="caption">{folder}</p>
            {list.map(f => (
              <button key={f.path} className={`file${current === f.path ? ' is-active' : ''}`} onClick={() => open(f.path)}>
                <FileText size={14} /> <span>{f.name}</span> <span className="caption">{(f.size / 1024).toFixed(1)}KB</span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <section className="editor">
        {current ? (
          <>
            <div className="editor-head">
              <span className="mono-sm">{current}</span>
              <span className="grow" />
              {content !== original && <span className="caption">ยังไม่ได้บันทึก</span>}
              <button className="btn btn-primary btn-sm" disabled={saving || content === original} onClick={save}><Save size={14} /> บันทึก</button>
            </div>
            <textarea className="editor-area" value={content} onChange={e => setContent(e.target.value)} spellCheck={false}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } }} />
          </>
        ) : (
          <div className="block block-mint">
            <p className="eyebrow">ความรู้ AI</p>
            <h1 className="headline">เลือกไฟล์ทางซ้ายเพื่อแก้ไข</h1>
            <p className="body-sm">ไฟล์ในโฟลเดอร์ knowledge/ คือสิ่งที่ AI ใช้ตอบลูกค้า แก้แล้วกดบันทึก (Ctrl+S) AI จะใช้ข้อมูลใหม่ทันที</p>
          </div>
        )}
      </section>
    </div>
  );
}
