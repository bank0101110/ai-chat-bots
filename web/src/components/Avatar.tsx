import { useEffect, useState } from 'react';
import { initials } from '../format';

const TONES = ['#dceeb1', '#c5b0f4', '#f4ecd6', '#c8e6cd', '#efd4d4', '#f3c9b6'];
/** สีพื้นคงที่ต่อชื่อ — ลูกค้าคนเดิมได้สีเดิมทุกครั้ง */
function toneOf(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/** รูปโปรไฟล์ลูกค้า/ร้าน — ไม่มีรูปหรือรูปเสีย → ตัวอักษรย่อบนพื้นพาสเทล */
export default function Avatar({ src, name, size = 44, square = false, className = '' }: {
  src?: string | null; name?: string | null; size?: number; square?: boolean; className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className={`avatar${square ? '' : ' round'} ${className}`} style={{ width: size, height: size, fontSize: Math.max(10, size * 0.3), background: toneOf(name ?? '') }}>
      {src && !broken
        ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : initials(name)}
    </span>
  );
}
