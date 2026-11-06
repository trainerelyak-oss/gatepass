import { setMeta } from '../db.js';
import { esc, icon, toast } from '../ui.js';

export default async function onboarding(root, ctx) {
  root.innerHTML = `
    <section class="onboarding">
      <div class="onboarding-mark">${icon('shield')}</div>
      <h1>Start your shift</h1>
      <p class="muted"><strong>${esc(ctx.config.site.name)}</strong>. Visitor records are kept on this device and uploaded whenever there's a connection, so the gate keeps running through outages.</p>
      <form class="stack" id="signin">
        <label class="field">
          <span>Full name</span>
          <input name="fullname" required autocomplete="name" placeholder="e.g. Daniel Tan">
        </label>
        <label class="field">
          <span>Officer ID</span>
          <input name="id" required autocapitalize="characters" placeholder="e.g. SO-1042">
        </label>
        <label class="field">
          <span>Your post</span>
          <select name="gate" required>
            ${ctx.config.gates.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
            <option value="__temp">Temporary post…</option>
          </select>
        </label>
        <div class="stack" data-temp hidden>
          <label class="field">
            <span>Post name</span>
            <input name="postName" placeholder="e.g. Atrium event entrance">
          </label>
          <label class="field">
            <span>Deployed until</span>
            <input name="until" type="time">
          </label>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Begin shift</button>
      </form>
    </section>
  `;

  const form = root.querySelector('#signin');
  form.gate.addEventListener('change', () => {
    form.querySelector('[data-temp]').hidden = form.gate.value !== '__temp';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const temporary = data.get('gate') === '__temp';
    const guard = {
      name: data.get('fullname').trim(),
      id: data.get('id').trim().toUpperCase(),
      gate: data.get('gate'),
      post: null,
      signedInAt: new Date().toISOString()
    };
    if (!guard.name || !guard.id) return;
    if (temporary) {
      const postName = String(data.get('postName') || '').trim();
      const until = String(data.get('until') || '');
      if (!postName || !until) {
        toast('Name the temporary post and when it ends', 'warn');
        return;
      }
      const end = new Date();
      const [h, m] = until.split(':').map(Number);
      end.setHours(h, m, 0, 0);
      if (end <= new Date()) end.setDate(end.getDate() + 1);
      const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      const pick = () => letters[crypto.getRandomValues(new Uint8Array(1))[0] % letters.length];
      guard.gate = `T${pick()}${pick()}`;
      guard.post = { id: guard.gate, name: postName, temporary: true, until: end.toISOString() };
    }
    await setMeta('guard', guard);
    ctx.guard = guard;
    ctx.navigate('gate');
  });
}
