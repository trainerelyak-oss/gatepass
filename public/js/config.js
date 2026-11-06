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
