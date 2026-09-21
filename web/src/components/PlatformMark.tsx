import { useState } from 'react';
import { platformOf, platformIcon } from '../format';

/** โลโก้แพลตฟอร์มเล็ก ๆ — ใช้ favicon จริงของแพลตฟอร์ม ถ้าโหลดไม่ได้ใช้ตัวอักษรบนพื้นพาสเทล */
export default function PlatformMark({ platform, size = 18, ring = false }: { platform?: string | null; size?: number; ring?: boolean }) {
  const p = platformOf(platform);
  const icon = platformIcon(platform);
  const [broken, setBroken] = useState(false);
  if (icon && !broken) {
    return (
      <span className={`pmark img${ring ? ' ring' : ''}`} style={{ width: size, height: size }} title={p.label}>
        <img src={icon} alt={p.label} onError={() => setBroken(true)} loading="lazy" />
      </span>
    );
  }
  return (
    <span className={`pmark${ring ? ' ring' : ''}`} style={{ background: p.color, width: size, height: size, fontSize: size * 0.5 }} title={p.label} aria-label={p.label}>
      {p.short}
    </span>
  );
}
