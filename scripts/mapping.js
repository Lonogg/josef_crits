/*
 * mapping.js
 *
 * This module contains helper functions for the WFRP4e Josef criticals
 * integration. It provides utilities to map Foundry item data to the
 * damageType categories used by the Josef tables, parse effect strings
 * into machine‑readable condition/injury instructions, and snapshot
 * actor state for later diffing. These helpers are imported by
 * integration.js and roller.js.
 */

/**
 * Attempt to infer a Josef damageType slug from a weapon item.
 *
 * The WFRP4e system does not expose a single canonical field for
 * damage type – depending on the version, this information may be
 * encoded in the weapon group, the qualities array, the item name
 * or other custom fields.  This function takes a conservative
 * approach: it checks multiple candidate properties on the item and
 * its system data and falls back to simple string matching.  If no
 * mapping can be determined the function returns null.
 *
 * @param {Item} item A WFRP4e weapon item
 * @returns {string|null} A damageType slug such as "cutting", "crushing",
 *                        "piercing", "bullets", "arrows", "flame",
 *                        "shrapnel-shot", "sling", "teeth-claws",
 *                        "unarmed", or null if unknown
 */
export function mapWeaponToDamageType(item) {
  if (!item) return null;
  // Allow explicit override via flags or item system fields.  Users
  // can set flags.wfrp4e-josef-crits.damageType on their weapon to
  // explicitly choose the Josef table used.  This enables custom
  // weapons or ambiguous items (e.g. swords used for cutting or
  // piercing) to be mapped accurately without modifying the module
  // code.  We also honour a `damageType` field on the system data if
  // present.  Both values should be lowercase slugs matching the
  // table names (e.g. 'cutting', 'crushing').
  const explicit = item?.flags?.['wfrp4e-josef-crits']?.damageType;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().toLowerCase();
  }
  const system = item.system || item.data?.data || {};
  const sysDt = system.damageType || system.damagetype;
  if (typeof sysDt === 'string' && sysDt.trim()) {
    const dtLower = sysDt.trim().toLowerCase();
    // Map common synonyms to our categories
    if (dtLower.includes('cut')) return 'cutting';
    if (dtLower.includes('crush') || dtLower.includes('blunt')) return 'crushing';
    if (dtLower.includes('pierce') || dtLower.includes('stab')) return 'piercing';
    if (dtLower.includes('bullet')) return 'bullets';
    if (dtLower.includes('arrow') || dtLower.includes('bolt') || dtLower.includes('javelin') || dtLower.includes('dart')) return 'arrows-bolts';
    if (dtLower.includes('claw') || dtLower.includes('bite') || dtLower.includes('horn')) return 'teeth-claws';
    if (dtLower.includes('shrapnel') || dtLower.includes('shot')) return 'shrapnel-shot';
    if (dtLower.includes('sling')) return 'sling';
    if (dtLower.includes('flame') || dtLower.includes('fire') || dtLower.includes('energy')) return 'flames-energy';
    if (dtLower.includes('unarmed') || dtLower.includes('brawl') || dtLower.includes('fist')) return 'unarmed';
    // If the system damageType is already one of our categories return it directly
    return dtLower;
  }
  // Normalise accessible data points
  const lowerName = (item.name || '').toLowerCase();
  // Ensure group/weaponGroup are coerced to strings before lower‑casing.  Some
  // WFRP4e versions may store these fields as objects instead of plain
  // strings, which would cause a TypeError when calling toLowerCase().
  const weaponGroupRaw = system.group ?? system.weaponGroup ?? '';
  const weaponGroup = String(weaponGroupRaw).toLowerCase();
  const qualities = (system.qualities || system.special || []);
  const lowerQuals = Array.isArray(qualities)
    ? qualities.map(q => (typeof q === 'string' ? q.toLowerCase() : (q.name || '').toLowerCase()))
    : [];

  // firearms / black powder
  if (weaponGroup.includes('blackpowder') || weaponGroup.includes('gun') || lowerName.includes('pistol') || lowerName.includes('handgun')) {
    return 'bullets';
  }
  // bows and crossbows
  if (weaponGroup.includes('bow') || weaponGroup.includes('crossbow') || lowerName.includes('bow') || lowerName.includes('crossbow')) {
    return 'arrows-bolts';
  }
  // slings
  if (weaponGroup.includes('sling') || lowerName.includes('sling')) {
    return 'sling';
  }
  // thrown weapons that hurl shot or shrapnel – we treat these as shrapnel & shot
  if (weaponGroup.includes('shot') || lowerName.includes('blunderbuss') || lowerName.includes('grenade')) {
    return 'shrapnel-shot';
  }
  // natural weapons
  if (lowerName.includes('bite') || lowerName.includes('claw') || lowerName.includes('gore')) {
    return 'teeth-claws';
  }
  // fire or magical flame weapons
  if (lowerName.includes('flame') || lowerName.includes('fire') || lowerQuals.includes('ablaze')) {
    return 'flames-energy';
  }
  // unarmed
  if (lowerName.includes('fist') || lowerName.includes('punch') || lowerName.includes('kick')) {
    return 'unarmed';
  }
  // melee heuristics by name
  if (/[\s\-](axe|sword|halberd|scythe|cleaver|sab(r|re)|sickle)/.test(lowerName)) {
    return 'cutting';
  }
  if (/[\s\-](mace|hammer|club|flail|staff|morning star)/.test(lowerName)) {
    return 'crushing';
  }
  if (/[\s\-](rapier|estoc|spear|lance|pike|stiletto|dagger)/.test(lowerName)) {
    return 'piercing';
  }
  // fallback: check a field `damageType` if present
  const dt = (system.damageType || system.damagetype || '').toLowerCase();
  if (dt.includes('cut')) return 'cutting';
  if (dt.includes('crush')) return 'crushing';
  if (dt.includes('pierce')) return 'piercing';
  // still nothing – return null
  return null;
}

// Internal cache for injury name → UUID mapping.
let injuryMap = null;
let injuryKeys = null;

/**
 * Build (or return) a mapping of injury names to their compendium UUIDs.
 *
 * The map is built the first time this function is called by scanning
 * the `wfrp4e-core.items` compendium for items of type `injury`.  If the
 * compendium or items are not found, the map will be empty.  Name
 * keys are normalised to lower case for case‑insensitive matching.
 *
 * @returns {Promise<Map<string,string>>} Map of lower case injury name → UUID
 */
export async function getInjuryMap() {
  if (injuryMap && injuryKeys) return injuryMap;
  injuryMap = new Map();
  injuryKeys = [];
  const packId = 'wfrp4e-core.items';
  const pack = game.packs.get(packId);
  if (!pack) return injuryMap;
  // Ensure index is loaded
  await pack.getIndex();
  for (const entry of pack.index) {
    // Some WFRP4e versions store type on entry.type, others under entry.system?.type
    const type = entry.type || entry.system?.type;
    if (typeof type === 'string' && type.toLowerCase().includes('injury')) {
      const key = entry.name.toLowerCase();
      injuryMap.set(key, entry.uuid);
      injuryKeys.push({ key, uuid: entry.uuid });
    }
  }
  return injuryMap;
}

// Base list of known condition IDs used as a fallback when the game
// system has not yet registered its status effects.
const BASE_CONDITIONS = [
  'bleeding', 'poisoned', 'ablaze', 'deafened', 'stunned',
  'entangled', 'fatigued', 'blinded', 'broken', 'prone',
  'surprised', 'unconscious', 'grappling', 'engaged', 'dead'
];

/**
 * Build a deduplicated array of known condition IDs by combining the
 * hardcoded base list with any conditions registered on CONFIG.statusEffects
 * and game.wfrp4e.config.statusEffects at the time of the call.  Called
 * lazily inside functions that run after Foundry and WFRP4e are ready.
 *
 * @returns {string[]} Lower-cased condition id strings
 */
function getKnownConditions() {
  const ids = new Set(BASE_CONDITIONS);
  try {
    const se = CONFIG?.statusEffects;
    if (Array.isArray(se)) {
      for (const e of se) { const id = e.id || e.name; if (id) ids.add(id.toLowerCase()); }
    } else if (se && typeof se === 'object') {
      for (const k of Object.keys(se)) ids.add(k.toLowerCase());
    }
  } catch (e) { /* CONFIG may not be ready */ }
  try {
    const wse = game?.wfrp4e?.config?.statusEffects;
    if (Array.isArray(wse)) {
      for (const e of wse) { const id = e.id || e.name; if (id) ids.add(id.toLowerCase()); }
    } else if (wse && typeof wse === 'object') {
      for (const k of Object.keys(wse)) ids.add(k.toLowerCase());
    }
  } catch (e) { /* game.wfrp4e may not be ready */ }
  return Array.from(ids);
}

// Exported for backwards-compat with callers that import KNOWN_CONDITIONS by
// name.  Prefer calling getKnownConditions() inside functions that run after
// the game is ready so that dynamic conditions are included.
export const KNOWN_CONDITIONS = BASE_CONDITIONS;

/**
 * Parse a Josef crit description and effects array into structured
 * conditions and injuries.  This function operates on text – it does
 * not modify the original row data.  It returns an object with
 * `conditions`, `injuries` and `notes` arrays.
 *
 * Conditions are recognised by keyword and optional numeric value
 * within parentheses.  Injuries are recognised by matching names
 * against the injury map built via `getInjuryMap()`.  Any text that
 * mentions a keyword but cannot be resolved into a recognised
 * condition or injury will be placed into the `notes` array to
 * display to the GM.
 *
 * @param {Object} row The row from a Josef JSON table
 * @returns {Promise<{conditions: Array, injuries: Array, notes: Array}>}
 */
export async function parseJosefEffects(row, hitLocation = null) {
  const out = { conditions: [], injuries: [], notes: [] };
  if (!row) return out;
  // Combine description and explicit effects into one string array
  const segments = [];
  if (row.description) segments.push(row.description);
  if (Array.isArray(row.effects)) segments.push(...row.effects);
  const text = segments.join(' ').toLowerCase();
  // Build injury map once
  const map = await getInjuryMap();
  // Parse conditions — computed dynamically so newly registered effects are included
  for (const cond of getKnownConditions()) {
    const idx = text.indexOf(cond);
    if (idx >= 0) {
      // Avoid false positives for "broken bone" (injury, not the frightened "broken" condition)
      if (cond === 'broken' && /broken\s+bone/.test(text)) continue;
      // Try to extract a number in parentheses immediately after the condition name
      // e.g. "bleeding (2)" or "bleeding(2)"
      const regex = new RegExp(`${cond}\\s*\\((\\d+)\\)`);
      const match = text.match(regex);
      const value = match ? parseInt(match[1], 10) : 1;
      out.conditions.push({ id: cond, value });
    }
  }
  // Parse injuries
  // Attempt to match the longest injury names first
  const injuryNames = Array.from(map.keys()).sort((a, b) => b.length - a.length);
  for (const name of injuryNames) {
    if (text.includes(name)) {
      const sev = name.includes('(minor)') ? 'minor' : name.includes('(major)') ? 'major' : null;
      out.injuries.push({ name, uuid: map.get(name), location: hitLocation, severity: sev });
    }
  }
  // Heuristic: treat "broken bone (minor/major)" phrases as specific injuries even if not exactly named
  if (/broken\s+bones?/.test(text)) {
    const sevMatch = text.match(/broken\s+bones?\s*\((minor|major)\)/);
    const sev = sevMatch ? sevMatch[1] : null;
    const injuryName = sev ? `Broken Bone (${sev.charAt(0).toUpperCase()}${sev.slice(1)})` : 'Broken Bone (Minor)';
    const lowerNames = out.injuries.map(i => i.name.toLowerCase());
    if (!lowerNames.includes(injuryName.toLowerCase())) {
      out.injuries.push({ name: injuryName, uuid: map.get(injuryName.toLowerCase()), location: hitLocation, severity: sev || 'minor' });
    }
  }
  // Generic fallback: if we still have no injuries but see a "broken" phrase, add a Broken Bone injury (Minor/Major guess)
  if (!out.injuries.length && /broken/.test(text)) {
    const sevMatch = /\bmajor\b/.test(text) ? 'Major' : (/\bminor\b/.test(text) ? 'Minor' : 'Minor');
    const injuryName = `Broken Bone (${sevMatch})`;
    out.injuries.push({ name: injuryName, uuid: map.get(injuryName.toLowerCase()), location: hitLocation, severity: sevMatch.toLowerCase() });
  }
  // If no conditions or injuries were parsed, treat the entire row as a note
  if (!out.conditions.length && !out.injuries.length) {
    out.notes.push(row.description || '');
  }
  return out;
}

/**
 * Capture a snapshot of an actor's injuries and conditions.
 * Returns an object with arrays of item ids and condition ids.  Only
 * injuries (items where type includes 'injury') and known conditions
 * are captured.  Used before and after WFRP4e applies a critical to
 * determine what changed.
 *
 * @param {Actor} actor The actor to snapshot
 * @returns {Object} { injuries: Array<string>, conditions: Array<string> }
 */
export function snapshotActorState(actor) {
  const injuries = [];
  const conditions = [];
  if (!actor) return { injuries, conditions };
  // Collect embedded items of type injury
  for (const item of actor.items.contents) {
    const type = item.type || item.system?.type;
    if (typeof type === 'string' && type.toLowerCase().includes('injury')) {
      injuries.push(item.id);
    }
  }
  // Collect applied conditions (status effects)
  // In WFRP4e, conditions are stored on actor.effects with a flag key
  const knownConds = getKnownConditions();
  for (const effect of actor.effects) {
    if (effect?.getFlag && effect.getFlag('core', 'statusId')) {
      const id = effect.getFlag('core', 'statusId');
      if (knownConds.includes(id)) conditions.push(id);
    }
  }
  return { injuries, conditions };
}

/**
 * Compute the difference between two actor state snapshots.  Returns
 * arrays of injury item ids and condition ids that were added.
 *
 * @param {Object} before Snapshot before modifications
 * @param {Object} after Snapshot after modifications
 * @returns {Object} { newInjuries: Array<string>, newConditions: Array<string> }
 */
export function diffActorState(before, after) {
  const newInjuries = after.injuries.filter(id => !before.injuries.includes(id));
  const newConditions = after.conditions.filter(id => !before.conditions.includes(id));
  return { newInjuries, newConditions };
}
