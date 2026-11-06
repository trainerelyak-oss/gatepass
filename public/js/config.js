import { getMeta, setMeta } from './db.js';

const EMPTY = {
  site: { id: 'SITE', name: 'Unconfigured site' },
  gates: [{ id: 'A', name: 'Gate A' }],
  visitorTypes: [{ id: 'visitor', label: 'Visitor' }],
  induction: [],
  assemblyPoint: 'Assembly point'
};

export async function loadConfig() {
  try {
    const res = await fetch('/data/site.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Config request failed (${res.status})`);
    const config = await res.json();
    await setMeta('config', config);
    return config;
  } catch {
    return (await getMeta('config')) || EMPTY;
  }
}

export function typeLabel(config, id) {
  return config.visitorTypes.find(t => t.id === id)?.label || id || 'Visitor';
}

export function gateName(config, id) {
  return config.gates.find(g => g.id === id)?.name || `Gate ${id}`;
}

export function zoneName(config, id) {
  return config.zones?.find(z => z.id === id)?.name || id;
}

export function zoneList(config, ids) {
  return (ids || []).map(id => zoneName(config, id)).join(', ') || 'No zones';
}

export function isRestricted(config, id) {
  return Boolean(config.zones?.find(z => z.id === id)?.restricted);
}

export function postLabel(config, guard) {
  if (guard?.post?.temporary) return `${guard.post.name} (temporary)`;
  return gateName(config, guard?.gate);
}

export function zonePicker(config, selected, name = 'zones') {
  return `
    <div class="zone-picker">
      ${(config.zones || []).map(z => `
        <label class="${z.restricted ? 'is-restricted' : ''}">
          <input type="checkbox" name="${name}" value="${z.id}" ${selected.includes(z.id) ? 'checked' : ''}>
          <span>${z.name}${z.restricted ? ' <b>restricted</b>' : ''}</span>
        </label>`).join('')}
    </div>`;
}
