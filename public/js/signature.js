export function mountSignaturePad(canvas) {
  const context = canvas.getContext('2d');
  let drawing = false;
  let empty = true;
  let lastPoint = null;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    context.lineWidth = 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#13202b';
    empty = true;
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', event => {
    drawing = true;
    lastPoint = point(event);
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const p = point(event);
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(p.x, p.y);
    context.stroke();
    lastPoint = p;
    empty = false;
  });

  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  resize();

  return {
    get empty() {
      return empty;
    },
    clear() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      resize();
    },
    toDataURL() {
      return empty ? null : canvas.toDataURL('image/png');
    }
  };
}
