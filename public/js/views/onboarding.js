import { setMeta } from '../db.js';
import { esc, icon } from '../ui.js';

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
          </select>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Begin shift</button>
      </form>
    </section>
  `;

  root.querySelector('#signin').addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(event.target);
    const guard = {
      name: data.get('fullname').trim(),
      id: data.get('id').trim().toUpperCase(),
      gate: data.get('gate'),
      signedInAt: new Date().toISOString()
    };
    if (!guard.name || !guard.id) return;
    await setMeta('guard', guard);
    ctx.guard = guard;
    ctx.navigate('gate');
  });
}
