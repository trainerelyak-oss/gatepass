import { esc, icon, toast } from './ui.js';

export function compressImage(file, maxSize = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

export function mountPhotoPicker(container, { max = 4 } = {}) {
  const photos = [];

  container.classList.add('photo-picker');
  container.innerHTML = `
    <div class="photo-grid"></div>
    <label class="photo-add">
      ${icon('camera')}
      <span>Add photo</span>
      <input type="file" accept="image/*" capture="environment" multiple hidden>
    </label>
  `;

  const grid = container.querySelector('.photo-grid');
  const addButton = container.querySelector('.photo-add');
  const input = container.querySelector('input');

  function render() {
    grid.innerHTML = photos
      .map((src, i) => `
        <figure class="photo-thumb">
          <img src="${esc(src)}" alt="Attached photo ${i + 1}">
          <button type="button" class="photo-remove" data-index="${i}" aria-label="Remove photo">×</button>
        </figure>`)
      .join('');
    addButton.hidden = photos.length >= max;
  }

  input.addEventListener('change', async () => {
    const files = [...input.files].slice(0, max - photos.length);
    input.value = '';
    for (const file of files) {
      try {
        photos.push(await compressImage(file));
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    render();
  });

  grid.addEventListener('click', event => {
    const button = event.target.closest('.photo-remove');
    if (!button) return;
    photos.splice(Number(button.dataset.index), 1);
    render();
  });

  render();

  return {
    get photos() {
      return [...photos];
    },
    reset() {
      photos.length = 0;
      render();
    }
  };
}
