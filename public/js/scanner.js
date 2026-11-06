export function cameraScanSupported() {
  return 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function parseCheckpointCode(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const cp = url.searchParams.get('cp');
    if (cp) return cp.toUpperCase();
  } catch {}
  const match = value.match(/CP-?(\d+)/i);
  if (!match) return value.toUpperCase();
  return `CP-${match[1].padStart(2, '0')}`;
}

export async function startCameraScan(video, onCode) {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();

  let active = true;
  let lastValue = null;
  let lastAt = 0;

  const scan = async () => {
    if (!active) return;
    try {
      const codes = await detector.detect(video);
      const value = codes[0]?.rawValue;
      const now = Date.now();
      if (value && (value !== lastValue || now - lastAt > 3000)) {
        lastValue = value;
        lastAt = now;
        onCode(value);
      }
    } catch {}
    if (active) setTimeout(scan, 200);
  };
  scan();

  return () => {
    active = false;
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  };
}
