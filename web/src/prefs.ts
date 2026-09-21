// ค่าที่จำไว้ในเบราว์เซอร์นี้ (เสียงแจ้งเตือน ฯลฯ) — เปิดโหมดส่วนตัวแล้วอ่านไม่ได้ก็ไม่เป็นไร
export function getPref(key: string, fallback: string) {
  try { return localStorage.getItem(`desk:${key}`) ?? fallback; } catch { return fallback; }
}
export function setPref(key: string, v: string) {
  try { localStorage.setItem(`desk:${key}`, v); } catch { /* ignore */ }
}

let ctx: AudioContext | null = null;
/** เสียง "ติ๊ง" สั้น ๆ ตอนลูกค้าทักเข้ามา */
export function ding() {
  if (getPref('sound', 'on') !== 'on') return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.09]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t + at);
      o.stop(t + at + 0.3);
    }
  } catch { /* เบราว์เซอร์ไม่อนุญาตเสียงก่อนผู้ใช้คลิก */ }
}
