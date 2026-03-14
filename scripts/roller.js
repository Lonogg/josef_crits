
import { loadTable } from './loader.js';
import { parseJosefEffects, KNOWN_CONDITIONS } from './mapping.js';

const moduleId = 'wfrp4e-josef-crits';
const PACK_ID = `${moduleId}.josef-crits-tables`;

const tableIndexCache = new Map();

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildTableKey(damageType, location, ruleset) {
  return slugify(`${damageType}-${location}-${ruleset}`);
}

async function findJosefTableEntry(damageType, location, ruleset) {
  const pack = game.packs?.get?.(PACK_ID);
  if (!pack) return null;
  if (!tableIndexCache.has(pack)) {
    await pack.getIndex();
    tableIndexCache.set(pack, Array.from(pack.index));
  }
  const index = tableIndexCache.get(pack) || [];
  const desired = buildTableKey(damageType, location, ruleset);
  let entry = index.find((e) => slugify(e.name) === desired);
  if (!entry) {
    const partial = slugify(`${damageType}-${location}`);
    entry = index.find((e) => slugify(e.name).startsWith(partial) && e.name.toLowerCase().includes(ruleset));
  }
  if (!entry) entry = index.find((e) => slugify(e.name).includes(slugify(location)) && e.name.toLowerCase().includes(damageType));
  if (!entry) return null;
  return { pack, entry };
}

async function rollFromCompendium(damageType, location, ruleset, { debug = false } = {}) {
  try {
    const found = await findJosefTableEntry(damageType, location, ruleset);
    if (!found) {
      ui.notifications?.warn?.(`Josef Crits: No roll table found for "${damageType} / ${location} / ${ruleset}". Check that the compendium pack "${PACK_ID}" is installed and contains the expected table.`);
      return null;
    }
    const { pack, entry } = found;
    const table = (await pack.getDocument(entry._id || entry.id)) || (entry.uuid ? await fromUuid(entry.uuid) : null);
    if (!table) return null;
    const draw = await table.draw({ displayChat: false, recursive: false });
    const rollTotal = draw?.roll?.total ?? draw?.results?.[0]?.range?.[0] ?? null;
    const resultDoc = draw?.results?.[0];
    const tableUuid = table.uuid || `Compendium.${PACK_ID}.${table.id || table._id}`;
    const resultUuid = resultDoc?.uuid || (resultDoc ? `${tableUuid}.Result.${resultDoc.id || resultDoc._id}` : null);
    return { rollTotal, tableUuid, resultUuid, draw };
  } catch (err) {
    if (debug) console.warn('JosefCrit: Compendium roll failed', err);
    return null;
  }
}

function resolveRuleset(ruleset) {
  const VALID_RULESETS = ['core', 'uia'];
  let rs = ruleset;
  if (!rs || rs === 'inherit') {
    const override = game.settings.get(moduleId, 'userOverrideRuleset');
    if (override && override !== 'inherit') rs = override;
    else rs = game.settings.get(moduleId, 'defaultRuleset') || 'core';
  }
  if (!VALID_RULESETS.includes(rs)) {
    console.warn(`JosefCrit: Invalid ruleset "${rs}", defaulting to "core".`);
    return 'core';
  }
  return rs;
}

/**
 * Return a copy of a template context object with human-readable display
 * versions of damageType, location, and ruleset added.
 *   "cutting"      → displayDamageType: "Cutting"
 *   "arrows-bolts" → displayDamageType: "Arrows-Bolts"
 *   "body"         → displayLocation:   "Body"
 *   "uia"          → displayRuleset:    "UIA"
 *   "core"         → displayRuleset:    "Core"
 */
function addDisplayFields(ctx) {
  const titleCase = (s) =>
    String(s || '').replace(/(^|[-\s])(\w)/g, (_, sep, c) => sep + c.toUpperCase());
  const formatRuleset = (rs) => {
    if (!rs) return rs;
    if (rs.toLowerCase() === 'uia') return 'UIA';
    return titleCase(rs);
  };
  return {
    ...ctx,
    displayDamageType: titleCase(ctx.damageType),
    displayLocation: titleCase(ctx.location),
    displayRuleset: formatRuleset(ctx.ruleset)
  };
}

function buildCriticalItemData(josef, { damageType, location, tableUuid = null, resultUuid = null } = {}) {
  const system = {
    wounds: { value: String(josef.wounds ?? 1) },
    modifier: { value: '' },
    location: { value: location },
    injury: { value: josef.description || josef.name || '' },
    penalty: { value: '' },
    duration: { value: '' }
  };
  return {
    name: josef.name || 'Critical Injury',
    type: 'critical',
    img: 'icons/svg/critical.svg',
    system,
    flags: {
      [moduleId]: {
        josefCreated: true,
        tableUuid,
        resultUuid,
        damageType,
        location,
        replacedVanilla: true,
        createdAt: Date.now(),
        roll: josef.roll ?? null
      }
    }
  };
}

/*
 * Define the structure of the return payload for a Josef critical roll.
 * This is purely for documentation purposes – Foundry does not enforce
 * TypeScript interfaces.  A JosefCritResult consists of the roll that
 * generated the entry, the name extracted from the description, the
 * ruleset/damageType/location that were used to select the table,
 * the full narrative description, an optional numeric wounds value, and
 * a list of structured effects.  Each effect is one of the following
 * shapes:
 *
 *  { type: "condition", id: string, value?: number, note?: string }
 *  { type: "injury", itemName: string, uuid?: string, location?: string }
 *  { type: "wounds", value: number, location?: string }
 *  { type: "test-modifier", value: number, scope: string, duration?: string }
 *  { type: "note", text: string }
 */

/**
 * Build a JosefCritResult from a raw row returned from the data file.
 *
 * @param {Object} row The selected row from the critical table
 * @param {number} total The die roll result that selected the row
 * @param {string} damageType The damage type slug used to select the table
 * @param {string} location The hit location slug used to select the table
 * @param {string} ruleset The ruleset used to select the table
 * @returns {Promise<Object>} A structured JosefCritResult
 */
async function buildJosefCritResult(row, total, damageType, location, ruleset) {
  // Extract a name from the row description.  Many entries begin with
  // "Name. Further description...".  Use the first sentence as the
  // name.  Fallback to a generic placeholder if no sentence delimiter is
  // found.
  let name = 'Critical Hit';
  let description = '';
  let wounds = undefined;
  let woundsIsTB = false;
  if (row) {
    description = String(row.description || '').trim();
    const dot = description.indexOf('.');
    if (dot > 0) {
      name = description.substring(0, dot).trim();
    } else if (description) {
      name = description.split(/\n|;/)[0].trim();
    }
    // Parse wounds – the JSON stores wounds as a string.  "T" means the
    // target's Toughness Bonus; flag it for display but do not auto-apply.
    const w = row.wounds;
    if (typeof w === 'string' && w.trim().toUpperCase() === 'T') {
      woundsIsTB = true;
    } else {
      const parsed = parseInt(w, 10);
      if (!isNaN(parsed)) wounds = parsed;
    }
  }
  // Use parseJosefEffects to extract conditions/injuries/notes from the
  // row.  Then convert them into a unified effects array.  Additional
  // explicit effect strings on the row are appended as notes.  In the
  // future these could be parsed into modifiers but for now they are
  // treated as free‑form text.
  let parsedEffects = { conditions: [], injuries: [], notes: [] };
  if (row) {
    parsedEffects = await parseJosefEffects(row, location);
    // Include any explicit effect strings as notes if they were not
    // captured by parseJosefEffects.  parseJosefEffects already
    // considers row.effects alongside the description, so this is
    // normally redundant but kept for clarity.
    if (Array.isArray(row.effects)) {
      for (const eff of row.effects) {
        const text = String(eff).trim();
        if (text) parsedEffects.notes.push(text);
      }
    }
  }
  const effects = [];
  // Conditions → effect objects
  for (const cond of parsedEffects.conditions) {
    effects.push({ type: 'condition', id: cond.id, value: cond.value });
  }
  // Injuries → effect objects
  for (const inj of parsedEffects.injuries) {
    const sev = inj.severity || (inj.name && inj.name.toLowerCase().includes('minor') ? 'minor' : (inj.name && inj.name.toLowerCase().includes('major') ? 'major' : null));
    effects.push({ type: 'injury', itemName: inj.name, uuid: inj.uuid, location: inj.location || location, severity: sev });
  }
  // Notes → note effects
  for (const note of parsedEffects.notes) {
    effects.push({ type: 'note', text: note });
  }
  // If wounds are defined and positive, include a wounds effect.
  // If wounds is "T" (Toughness Bonus) add a note instead — it cannot be auto-applied.
  if (woundsIsTB) {
    effects.push({ type: 'note', text: 'Wounds equal to Toughness Bonus (TB) — must be applied manually.' });
  } else if (wounds && wounds > 0) {
    effects.push({ type: 'wounds', value: wounds });
  }
  return {
    roll: total,
    name,
    ruleset,
    damageType,
    location,
    description,
    wounds,
    woundsIsTB,
    effects
  };
}

export async function rollJosefCrit({ damageType, location, ruleset = null, actor = null } = {}) {
  const rs = resolveRuleset(ruleset);
  const data = await loadTable(damageType, location, rs);
  // Foundry v13 deprecates Roll#roll({ async: true }).  Use the
  // recommended evaluate() method instead.  If the consuming
  // environment requires synchronous evaluation use evaluateSync().
  const roll = new Roll(data.die);
  await roll.evaluate();
  const total = roll.total;
  const result = data.rows.find(r => total >= r.min && total <= r.max);
  // Construct a structured JosefCritResult.  If no result matched,
  // build an empty result to still display the roll.
  const josef = await buildJosefCritResult(result || {}, total, damageType, location, rs);
  // Render a chat card using our Handlebars template.  We set a flag
  // so other parts of the module can identify Josef crit messages.
  const templatePath = 'modules/wfrp4e-josef-crits/templates/chat/josef-crit-card.hbs';
  const render = foundry?.applications?.handlebars?.renderTemplate || renderTemplate;
  const html = await render(templatePath, addDisplayFields(josef));
  const chatData = {
    content: html,
    speaker: ChatMessage.getSpeaker(),
    flags: {
      'wfrp4e-josef-crits': {
        josefCrit: true,
        result: josef,
        // Persist the associated actor ID so that chat handlers can apply
        // effects to the original defender when no token is selected.  We
        // store the id here rather than a reference as chat flags must be
        // serialisable.
        actorId: actor && actor.id ? actor.id : null
      }
    }
  };
  await ChatMessage.create(chatData);
  if (game.settings.get(moduleId, 'debugMode')) {
    console.log('Josef Crit Roll', { damageType, location, ruleset: rs, total, result, josef });
  }
  // Return both the new structured result and the legacy result/parsed
  // fields for backward compatibility.
  let legacyParsed = { conditions: [], injuries: [], notes: [] };
  if (result) legacyParsed = await parseJosefEffects(result, location);
  return { roll: total, result, parsed: legacyParsed, josefResult: josef };
}

/**
 * Roll a Josef critical using the module's RollTable compendium so that the
 * Foundry workflow (draw + UUIDs) is honoured. Structured effects are still
 * parsed from the JSON data to retain the existing automation.
 */
export async function rollJosefCritFromPack({ damageType, location, ruleset = null, actor = null, postChat = true, rollTotal = null } = {}) {
  const rs = resolveRuleset(ruleset);
  const dbg = game.settings.get(moduleId, 'debugMode');

  // Roll on the compendium table. If we already have a roll total (e.g. from an upstream draw)
  // skip drawing again and use that number.
  let comp = null;
  if (rollTotal == null) {
    comp = await rollFromCompendium(damageType, location, rs, { debug: dbg });
    if (!comp && dbg) console.warn('JosefCrit: No compendium table found for', damageType, location, rs);
  }

  const data = await loadTable(damageType, location, rs);
  let total = rollTotal;
  if (total == null) {
    if (comp?.rollTotal != null) total = comp.rollTotal;
    else {
      const roll = new Roll(data.die);
      await roll.evaluate();
      total = roll.total;
    }
  }

  const result = data.rows.find((r) => total >= r.min && total <= r.max);
  const josef = await buildJosefCritResult(result || {}, total, damageType, location, rs);
  const itemData = buildCriticalItemData(josef, { damageType, location, tableUuid: comp?.tableUuid, resultUuid: comp?.resultUuid });

  let chatMessage = null;
  if (postChat) {
    const templatePath = 'modules/wfrp4e-josef-crits/templates/chat/josef-crit-card.hbs';
    const render = foundry?.applications?.handlebars?.renderTemplate || renderTemplate;
    const html = await render(templatePath, addDisplayFields({ ...josef, itemData }));
    chatMessage = await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker(),
      flags: {
        [moduleId]: {
          josefCrit: true,
          result: josef,
          actorId: actor && actor.id ? actor.id : null,
          itemData,
          tableUuid: comp?.tableUuid || null,
          resultUuid: comp?.resultUuid || null
        }
      }
    });
  }

  if (dbg) console.log('Josef Crit Roll (pack)', { damageType, location, ruleset: rs, total, result, josef, comp });

  return {
    roll: total,
    result,
    josefResult: josef,
    itemData,
    compendium: comp,
    chatMessage
  };
}

Hooks.once('init', () => {
  const mod = game.modules.get('wfrp4e-josef-crits');
  if (mod) {
    mod.api = mod.api || {};
    mod.api.rollJosefCrit = rollJosefCrit;
    mod.api.rollJosefCritFromPack = rollJosefCritFromPack;
  }
});
