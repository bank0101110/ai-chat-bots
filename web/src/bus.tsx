import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { streamUrl } from './api';

type Handler = (data: any) => void;
type Bus = { on: (type: string, fn: Handler) => () => void; live: boolean };

const Ctx = createContext<Bus>({ on: () => () => {}, live: false });

/** เปิด EventSource เส้นเดียวทั้งแอป แล้วกระจายอีเวนต์ให้ทุกหน้า */
export function StreamProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<string, Set<Handler>>());
  const [live, setLive] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const types = ['hello', 'message', 'conversations', 'bot_event', 'duoke_state', 'message_modified', 'send_failed'];
    const open = () => {
      es = new EventSource(streamUrl());
      es.onopen = () => setLive(true);
      es.onerror = () => {
        setLive(false);
        es?.close();
        retry = setTimeout(open, 3000);
      };
      for (const t of types) {
        es.addEventListener(t, ev => {
          let data: unknown = null;
          try { data = JSON.parse((ev as MessageEvent).data); } catch { /* ignore */ }
          handlers.current.get(t)?.forEach(fn => fn(data));
        });
      }
    };
    open();
    return () => { clearTimeout(retry); es?.close(); };
  }, []);

  const on = (type: string, fn: Handler) => {
    if (!handlers.current.has(type)) handlers.current.set(type, new Set());
    handlers.current.get(type)!.add(fn);
    return () => { handlers.current.get(type)?.delete(fn); };
  };

  return <Ctx.Provider value={{ on, live }}>{children}</Ctx.Provider>;
}

export function useBus() { return useContext(Ctx); }

/** ฟังอีเวนต์ — callback ใช้ค่าล่าสุดเสมอ ไม่ต้องใส่ deps */
export function useStreamEvent(type: string, fn: Handler) {
  const { on } = useBus();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(type, d => ref.current(d)), [type]);
}
