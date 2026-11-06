import { getMeta, setMeta } from './db.js';

const EMPTY = {
  site: { id: 'SITE', name: 'Unconfigured site' },
  checkpoints: [],
  checklists: [],
  incidentCategories: ['Other']
};

export async function loadConfig() {
  try {
    const res = await fetch('/data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Config request failed (${res.status})`);
    const config = await res.json();
    await setMeta('config', config);
    return config;
  } catch {
    return (await getMeta('config')) || EMPTY;
  }
}
