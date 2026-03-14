
import { loadRegistry, loadJson } from './loader.js';

export async function validateJosefTables() {
  const registry = await loadRegistry();
  const missing = [];
  for (const [dt, info] of Object.entries(registry.damageTypes)) {
    for (const loc of info.locations) {
      for (const rs of info.rulesets) {
        const file = `${dt}-${loc}-${rs}.json`;
        try {
          await loadJson(file);
        } catch (err) {
          missing.push(file);
        }
      }
    }
  }
  if (missing.length) {
    ui.notifications.error(`Missing Josef Crit tables: ${missing.join(', ')}`);
  } else {
    ui.notifications.info('All Josef Crit tables validated successfully.');
  }
}

Hooks.once('init', () => {
  const mod = game.modules.get('wfrp4e-josef-crits');
  if (mod) {
    mod.api = mod.api || {};
    mod.api.validateJosefTables = validateJosefTables;
  }
});
