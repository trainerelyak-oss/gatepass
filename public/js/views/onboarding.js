import { setMeta, getMeta } from '../db.js';
import { signIn } from '../session.js';
import { syncNow } from '../sync.js';
import { esc, icon, toast } from '../ui.js';

export default async function onboarding(root, ctx) {
  const last = (await getMeta('lastPost')) || {};
  root.innerHTML = `
    <section class="onboarding">
      <div class="onboarding-mark">${icon('shield')}</div>
      <h1>${ctx.reauth ? 'Sign in again' : 'Start your shift'}</h1>
      <p class="muted">${ctx.reauth
        ? 'Your session ended. Sign in to keep uploading. Nothing on this device has been lost.'
        : `<strong>${esc(ctx.config.site.name)}</strong>. Sign in with the account your supervisor gave you.`}</p>
      <form class="stack" id="signin">
        <label class="field">
          <span>Username</span>
          <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(ctx.reauth ? ctx.guard?.id || '' : last.username || '')}">
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" required autocomplete="current-password">
        </label>
        ${ctx.reauth ? '' : `
          <label class="field">
            <span>Your post</span>
            <select name="gate" required>
              ${ctx.config.gates.map(g => `<option value="${esc(g.id)}" ${g.id === last.gate ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
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
          </div>`}
        <button class="btn btn-primary btn-block btn-large" type="submit">${ctx.reauth ? 'Sign in' : 'Begin shift'}</button>
        <p class="muted small center">Signed in here before? You can sign in again with no connection.</p>
      </form>
    </section>
  `;

  const form = root.querySelector('#signin');
  form.gate?.addEventListener('change', () => {
    form.querySelector('[data-temp]').hidden = form.gate.value !== '__temp';
  });
  form.username.value ? form.password.focus() : form.username.focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    const data = new FormData(form);
    let post = null;
    let gate = ctx.guard?.gate;

    if (!ctx.reauth) {
      gate = data.get('gate');
      if (gate === '__temp') {
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
        gate = `T${pick()}${pick()}`;
        post = { id: gate, name: postName, temporary: true, until: end.toISOString() };
      }
    }

    button.disabled = true;
    try {
      const session = await signIn(data.get('username'), data.get('password'));
      const guard = ctx.reauth
        ? { ...ctx.guard, role: session.user.role, roleLabel: session.user.roleLabel }
        : {
            name: session.user.name,
            id: session.user.username,
            role: session.user.role,
            roleLabel: session.user.roleLabel,
            gate,
            post,
            signedInAt: new Date().toISOString()
          };
      await setMeta('guard', guard);
      await setMeta('lastPost', { username: session.user.username, gate: post ? last.gate : gate });
      ctx.guard = guard;
      ctx.reauth = false;
      if (session.offline) toast('Signed in offline. Uploads resume when the connection returns.', 'ok');
      syncNow(true);
      ctx.navigate('gate');
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      form.password.select();
    }
  });
}
