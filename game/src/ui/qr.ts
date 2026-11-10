// Join QR code (qrcode-generator) and camera scanning (BarcodeDetector, where the browser has it).
import qrcode from 'qrcode-generator';
import { h, btn } from './dom';
import { icon } from './icons';

/** QR as an inline SVG element, ink on cream. */
export function qrElement(text: string, size = 180): HTMLElement {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
  const box = h('div', { class: 'qr', style: `width:${size}px;height:${size}px` });
  box.innerHTML = `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="Join code"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#f7f3ec"/><path d="${path}" fill="#2a2328"/></svg>`;
  return box;
}

interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare const BarcodeDetector: { new (o?: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats?: () => Promise<string[]> } | undefined;

export async function canScan(): Promise<boolean> {
  if (typeof BarcodeDetector === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  try { const f = await BarcodeDetector.getSupportedFormats?.(); return !f || f.includes('qr_code'); } catch { return false; }
}

/** Full-screen camera scanner. Resolves with the scanned text, or null if cancelled. */
export function scanQr(): Promise<string | null> {
  return new Promise((resolve) => {
    let stream: MediaStream | null = null;
    let done = false;
    const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
    const finish = (v: string | null) => {
      if (done) return; done = true;
      stream?.getTracks().forEach((t) => t.stop());
      wrap.remove();
      resolve(v);
    };
    const wrap = h('div', { class: 'modal scan', role: 'dialog', 'aria-label': 'Scan a table code' },
      h('div', { class: 'card' },
        h('h2', null, 'Point at the code'),
        h('div', { class: 'scan-box' }, video, h('div', { class: 'scan-frame' })),
        h('p', { class: 'hint' }, 'Hold the camera over the table code on the other phone.'),
        btn([icon('close'), ' Cancel'], () => finish(null), 'ghost')));
    document.getElementById('ui')!.appendChild(wrap);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        const det = new BarcodeDetector!({ formats: ['qr_code'] });
        const loop = async () => {
          if (done) return;
          try {
            if (video.readyState >= 2) {
              const res = await det.detect(video);
              if (res[0]?.rawValue) { finish(res[0].rawValue); return; }
            }
          } catch { /* keep trying */ }
          setTimeout(loop, 250);
        };
        loop();
      } catch {
        wrap.querySelector('.hint')!.textContent = 'The camera is not available. Type the code instead.';
      }
    })();
  });
}
