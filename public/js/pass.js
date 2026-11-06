import { decodePass } from './verify.js';
import { qrSvg } from './qr.js';
import { esc, icon } from './ui.js';

async function render() {
  const root = document.getElementById('pass');
  const token = decodeURIComponent(location.hash.slice(1));
  const decoded = decodePass(token);

  if (!decoded) {
    root.innerHTML = `<section class="pass-card"><h1>Pass not found</h1><p class="muted">This link is incomplete. Ask your host to send it again.</p></section>`;
    return;
  }

  let siteName = decoded.pass.siteId;
  try {
    siteName = (await (await fetch('/data/site.json')).json()).site.name;
  } catch {}

  const { pass } = decoded;
  const from = new Date(pass.validFrom);
  const to = new Date(pass.validTo);
  const sameDay = from.toDateString() === to.toDateString();
  const day = d => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  root.innerHTML = `
    <section class="pass-card">
      <header class="pass-head">
        <span class="brand-mark">${icon('shield')}</span>
        <div>
          <span class="eyebrow">Visitor pass</span>
          <strong>${esc(siteName)}</strong>
        </div>
      </header>
      <div class="pass-qr">${qrSvg(token)}</div>
      <p class="pass-code">${esc(pass.id)}</p>
      <h1>${esc(pass.name)}</h1>
      <dl class="facts">
        ${pass.company ? `<div><dt>Company</dt><dd>${esc(pass.company)}</dd></div>` : ''}
        <div><dt>Visiting</dt><dd>${esc(pass.host)}</dd></div>
        <div><dt>Date</dt><dd>${sameDay ? day(from) : `${day(from)} – ${day(to)}`}</dd></div>
        <div><dt>Time</dt><dd>${time(from)} – ${time(to)}</dd></div>
        <div><dt>Entry</dt><dd>${pass.multiEntry ? 'Multiple entries' : 'Single entry'}</dd></div>
      </dl>
      <p class="pass-tip">Show this QR code at the security post together with your photo ID. Take a screenshot in case there's no signal at the gate.</p>
    </section>
  `;
}

if (window.qrcode) render();
else window.addEventListener('load', render);
