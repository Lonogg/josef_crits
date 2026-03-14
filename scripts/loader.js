
export async function loadJson(file) {
  const path = `modules/wfrp4e-josef-crits/data/${file}`;
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to load ${file}: ${resp.status}`);
  return await resp.json();
}

export async function loadTable(damageType, location, ruleset) {
  const file = `${damageType}-${location}-${ruleset}.json`;
  return await loadJson(file);
}

export async function loadRegistry() {
  return await loadJson('registry.json');
}
