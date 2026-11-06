export function cameraAvailable() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    return new BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export async function startScanner(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  const detector = nativeDetector();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let active = true;
  let last = { value: null, at: 0 };

  async function read() {
    if (detector) {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue || null;
    }
    if (!window.jsQR || !video.videoWidth) return null;
    const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data || null;
  }

  async function loop() {
    if (!active) return;
    try {
      const value = await read();
      const now = Date.now();
      if (value && (value !== last.value || now - last.at > 3000)) {
        last = { value, at: now };
        onCode(value);
      }
    } catch {}
    if (active) setTimeout(loop, 180);
  }
  loop();

  return () => {
    active = false;
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  };
}
