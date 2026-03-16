/*
 * integration.js
 *
 * Josef crit replace-default bridge.
 * We intercept WFRP4e at two points:
 *  1) The combat test hooks (rollWeaponTest / rollTest) to mirror or suppress
 *     vanilla crit effects.
 *  2) preCreateItem for embedded Items of type "critical". When integrationMode
 *     is set to replaceDefault we cancel the vanilla critical item and create
 *     a Josef-built critical item instead, rolling from this module's RollTable
 *     compendium and applying Josef effects. A flag is stamped so our own
 *     created item bypasses the cancellation logic. This avoids deprecated
 *     TableResult text interception and preserves the drag/drop UX.
 */

import { mapWeaponToDamageType, snapshotActorState, diffActorState, getInjuryMap } from './mapping.js';
import { rollJosefCrit, rollJosefCritFromPack } from './roller.js';

export function initIntegration() {
  const moduleId = 'wfrp4e-josef-crits';
  const getMode = () => game.settings.get(moduleId, 'integrationMode');
  const getDryRun = () => game.settings.get(moduleId, 'dryRunMode');
  const debug = () => game.settings.get(moduleId, 'debugMode');
  const getDefaultDamageType = () => game.settings.get(moduleId, 'defaultDamageType');

  const logDebug = (...args) => { if (debug()) console.log('JosefCrit:', ...args); };

  // Guard: multiple interceptors (rollWeaponTest hook, rollTable wrapper,
  // formatChatRoll wrapper) can all fire for a single critical hit.  Only
  // the first one to call this wrapper per crit should actually roll; the
  // others are silently dropped.  The flag resets 2 s later so subsequent
  // independent crits are handled normally.
  let _josefHandlingCrit = false;
  async function guardedJosefRoll(fn) {
    if (_josefHandlingCrit) {
      if (debug()) console.log('JosefCrit: duplicate roll intercepted, skipping');
      return null;
    }
    _josefHandlingCrit = true;
    setTimeout(() => { _josefHandlingCrit = false; }, 2000);
    return await fn();
  }

  // Helper: normalise hit location to our four categories
  function normaliseLocation(loc) {
    if (!loc) return null;
    // Coerce location to string to handle objects (e.g. location objects)
    let s;
    if (typeof loc === 'string') {
      s = loc.toLowerCase().trim();
    } else {
      // WFRP4e hitloc objects use .result for the key (e.g. "rArm", "lLeg", "body")
      // Fall back to .value / .name / .key for other object shapes
      const str = loc.result ?? loc.value ?? loc.name ?? loc.key ?? '';
      s = String(str || loc).toLowerCase().trim();
    }
    // Exact matches for WFRP4e's canonical hit location names
    if (s === 'head') return 'head';
    if (s === 'right arm' || s === 'left arm') return 'arm';
    if (s === 'torso') return 'body';
    if (s === 'right leg' || s === 'left leg') return 'leg';
    // Broader substring matches for partial or custom strings
    if (s.includes('head')) return 'head';
    if (s.includes('arm') || s.includes('shoulder') || s.includes('hand')) return 'arm';
    if (s.includes('leg') || s.includes('hip') || s.includes('foot')) return 'leg';
    if (s.includes('torso') || s.includes('body') || s.includes('chest') || s.includes('abdomen')) return 'body';
    // Unknown location — warn explicitly and fall back to "body"
    console.warn(`JosefCrit: Unrecognised hit location "${s}", defaulting to "body"`);
    return 'body';
  }

  /**
   * Apply the structured effects from a JosefCritResult to the given actor.
   * This helper interprets the effect list and delegates to WFRP4e
   * utilities such as actor.addCondition and actor.createEmbeddedDocuments.
   * Wounds and test modifiers are handled conservatively – wounds are
   * subtracted from the actor's current wounds if that data is
   * accessible; test modifiers are currently ignored (but listed in
   * chat).  When dryRun is true no actual modifications are made.  If
   * debug is enabled warnings are logged for unresolved injuries or
   * unexpected effect shapes.
   *
   * @param {Actor} actor The actor to modify
   * @param {Object} result The JosefCritResult returned by rollJosefCrit
   * @param {Object} options { dryRun: boolean, debug: boolean }
   */
  async function applyJosefEffectsToActor(actor, result, options = {}) {
    const { dryRun = false, debug = false } = options;
    if (!actor || !result || !Array.isArray(result.effects)) return;
    // Build injury map once if needed
    let injuryMap = null;
    let injuryKeys = null;
    for (const eff of result.effects) {
      const type = eff.type;
      if (type === 'condition') {
        const id = eff.id;
        const value = eff.value;
        if (id) {
          try {
            if (!dryRun) {
              // Prefer actor.addCondition if available.  Fallback to the
              // WFRP4e utility if the method is not present on the actor.
              if (typeof actor.addCondition === 'function') {
                await actor.addCondition(id, value);
              } else if (game.wfrp4e?.utility?.addCondition) {
                await game.wfrp4e.utility.addCondition(id, value, actor);
              } else if (game.wfrp4e?.utility?.applyCondition) {
                await game.wfrp4e.utility.applyCondition(id, actor, value);
              }
            }
          } catch (e) {
            if (debug) console.warn('JosefCrit: Failed to add condition', eff, e);
          }
        }
      } else if (type === 'injury') {
        // Lookup injury UUID by name if necessary
        let uuid = eff.uuid;
        const severity = (eff.severity || (eff.itemName && eff.itemName.toLowerCase().includes('minor') ? 'minor' : (eff.itemName && eff.itemName.toLowerCase().includes('major') ? 'major' : null)))?.toLowerCase?.();
        if (!uuid && eff.itemName) {
          if (!injuryMap) injuryMap = await getInjuryMap();
          if (!injuryKeys) injuryKeys = injuryMap instanceof Map ? Array.from(injuryMap.entries()).map(([k, v]) => ({ key: k, uuid: v })) : [];
          const key = eff.itemName.toLowerCase();
          // exact match first
          uuid = injuryMap.get(key);
          // Exact with severity filter
          if (!uuid && severity) {
            const exact = injuryKeys.find(e => e.key === key && e.key.includes(severity));
            if (exact) uuid = exact.uuid;
          }
          // Try loose match respecting severity
          if (!uuid && injuryKeys) {
            for (const entry of injuryKeys) {
              if (severity && !entry.key.includes(severity)) continue;
              if (key.includes(entry.key) || entry.key.includes(key)) {
                uuid = entry.uuid;
                break;
              }
            }
          }
          // Fallback: any broken bone with matching severity
          if (!uuid && key.includes('broken')) {
            const fallback = injuryKeys.find(e => e.key.includes('broken bone') && (!severity || e.key.includes(severity)));
            if (fallback) uuid = fallback.uuid;
          }
        }
        if (uuid) {
          try {
            if (!dryRun) {
              const doc = await fromUuid(uuid);
              if (doc) {
                const data = doc.toObject();
                if (eff.location) {
                  data.system = data.system || {};
                  data.system.location = eff.location;
                }
                await actor.createEmbeddedDocuments('Item', [data]);
              }
            }
          } catch (e) {
            if (debug) console.warn('JosefCrit: Failed to add injury', eff, e);
          }
        } else {
          // Fallback: create a simple injury item if we couldn't resolve UUID
          try {
            if (!dryRun && eff.itemName) {
              const injuryData = {
                name: eff.itemName,
                type: 'injury',
                system: { location: eff.location || '', source: 'JosefCrit' }
              };
              await actor.createEmbeddedDocuments('Item', [injuryData]);
            }
          } catch (e) {
            if (debug) console.warn('JosefCrit: Unknown injury and failed to create fallback', eff, e);
          }
        }
      } else if (type === 'wounds') {
        const delta = eff.value;
        if (typeof delta === 'number' && delta > 0) {
          try {
            // Attempt to read the actor's current wounds.  Different
            // versions of WFRP4e store this in slightly different
            // locations.  Try common paths in order.  We avoid
            // getProperty here to reduce dependencies on Foundry
            // utilities.
            let current = undefined;
            if (actor?.system?.wounds?.value != null) {
              current = actor.system.wounds.value;
            } else if (actor?.system?.characteristics?.wounds?.value != null) {
              current = actor.system.characteristics.wounds.value;
            } else if (actor?.system?.characteristics?.wnds?.value != null) {
              current = actor.system.characteristics.wnds.value;
            }
            if (typeof current === 'number') {
              const newValue = Math.max(current - delta, 0);
              if (!dryRun) await actor.update({ 'system.wounds.value': newValue });
            }
          } catch (e) {
            if (debug) console.warn('JosefCrit: Failed to apply wounds effect', eff, e);
          }
        }
      } else if (type === 'test-modifier') {
        // Currently not applied automatically – these modifiers may
        // require temporary effects or manual adjudication.  They are
        // displayed on the chat card instead.  Left here for future
        // expansion.
        if (debug) console.log('JosefCrit: Test modifier effect ignored for actor', eff);
      } else if (type === 'note') {
        // Notes do not modify actor state; nothing to do, move on to next effect
      } else {
        if (debug) console.warn('JosefCrit: Unhandled effect type', eff);
      }
    }
  }

  // Expose helper functions on the module API so other parts of the module
  // (e.g. chat handlers) can reuse them.  This assignment must occur
  // inside initIntegration so that applyJosefEffectsToActor is in
  // scope.  We also expose getInjuryMap to support injury lookups.
  {
    const mod = game.modules.get(moduleId);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.applyJosefEffectsToActor = applyJosefEffectsToActor;
      mod.api.getInjuryMap = getInjuryMap;
    }
  }

  const handledKey = Symbol('josefWeaponHandled');

  async function handleWeaponTest(test, context) {
    if (!test || test[handledKey]) return;
    const mode = getMode();
    if (!mode || mode === 'off') return;
    try {
      // Determine if the test resulted in a critical hit
      const result = test?.data?.result || test?.result || {};
      const isCrit = !!(result.critical || result.crit || result.criticalHit);
      if (!isCrit) return;

      // Determine damage type from the weapon
      const weapon = test.weapon || test.data?.weapon || test.attacker?.weapon || test.item || test.data?.item;
      const damageType = mapWeaponToDamageType(weapon);
      if (!damageType) {
        if (debug()) console.warn('JosefCrit: Could not infer damage type for weapon', weapon);
        return;
      }
      // Determine hit location from result.
      // Prefer a called shot (preData.selectedHitLocation) so the targeted body part is always honoured.
      // WFRP4e hitloc is an object with .result holding the key string (e.g. "rArm"); unwrap it.
      const preData = test?.preData || test?.data?.preData || {};
      const selectedHitLoc = preData?.selectedHitLocation;
      let locRaw;
      if (selectedHitLoc && selectedHitLoc !== 'roll' && selectedHitLoc !== 'none') {
        locRaw = selectedHitLoc;
      } else {
        const hitlocObj = result.hitloc || result.hitLocation || result.location || test.hitloc || test.location;
        locRaw = (hitlocObj && typeof hitlocObj === 'object') ? (hitlocObj.result ?? hitlocObj.value ?? hitlocObj.key ?? hitlocObj.name) : hitlocObj;
      }
      const location = normaliseLocation(locRaw);
      if (!location) {
        if (debug()) console.warn('JosefCrit: Could not determine hit location from', result);
        return;
      }
      // Actor references
      const attacker = test.actor || test.data?.actor;
      const defender = test.target || test.defender || test.data?.target || test.data?.defender;

      // Integration behaviour differs based on mode.  In replaceDefault we
      // preempt the system by clearing the critical flags and immediately
      // rolling the Josef crit; in sideBySide we let the system apply
      // first and then roll ours.
      const dryRun = getDryRun();
      if (mode === 'replaceDefault') {
        // Prevent the system from applying its critical by clearing flags.
        // We no longer roll here; the critical flow is intercepted at the table/chat layer.
        if (result.critical) result.critical = false;
        if (result.crit) result.crit = false;
        if (result.criticalHit) result.criticalHit = false;
        // Roll Josef once here so automatic crits produce a card/effects even without table clicks.
        const defenderActor = defender?.actor ?? defender;
        const r = await guardedJosefRoll(() => rollJosefCritFromPack({ damageType, location, actor: defenderActor, postChat: true }));
        const josef = r?.josefResult;
        if (josef && defenderActor) {
          await applyJosefEffectsToActor(defenderActor, josef, { dryRun, debug: debug() });
        }
        test[handledKey] = true;
        return;
      } else if (mode === 'sideBySide') {
        // Side by side: wait for the system to finish then roll Josef
        await new Promise(resolve => setTimeout(resolve, 0));
        const defenderActor = defender?.actor ?? defender;
        const r = await guardedJosefRoll(() => rollJosefCrit({ damageType, location, actor: defenderActor }));
        const josef = r?.josefResult;
        if (josef && defenderActor) {
          await applyJosefEffectsToActor(defenderActor, josef, { dryRun, debug: debug() });
        }
        test[handledKey] = true;
        return;
      }
    } catch (err) {
      console.error('JosefCrit integration error', err);
    }
  }

  Hooks.on('wfrp4e:rollWeaponTest', handleWeaponTest);

  // Fallback for systems that emit only rollTest with an item instead of rollWeaponTest
  Hooks.on('wfrp4e:rollTest', async (test, context) => {
    const item = test?.item || test?.data?.item;
    if (!item) return;
    const type = (item.type || item?.data?.type || '').toLowerCase();
    if (type === 'weapon' || type.includes('weapon')) {
      await handleWeaponTest(test, context);
    }
  });

  // Patch the WFRP4e internal critical application helper if available.  When
  // present, this allows us to avoid the snapshot/diff logic and cleanly
  // suppress or coexist with the system's own crit effects.  We perform
  // this patch once on the ready hook to ensure the system has been
  // initialised.  The patched function will call the original helper in
  // side‑by‑side mode but skip it entirely in replaceDefault mode.
  Hooks.once('ready', () => {
    try {
      const util = game?.wfrp4e?.utility;
      const orig = util?.applyCriticalEffect;
      if (orig && typeof orig === 'function' && !orig.__josefPatched) {
        util.applyCriticalEffect = async function (...args) {
          const mode = getMode();
          // Off mode: fully delegate
          if (!mode || mode === 'off') {
            return await orig.apply(this, args);
          }
          // In replaceDefault we suppress the system effect and do not roll here;
          // the chat/table interception will handle the Josef roll.
          if (mode === 'replaceDefault') {
            return;
          }
          // In side‑by‑side mode allow the system to apply its crit first and
          // preserve the original return value so callers receive the expected result.
          let origResult;
          if (mode === 'sideBySide') {
            origResult = await orig.apply(this, args);
          }
          // Wrap Josef-specific logic in try/catch so any error is logged and
          // the original result is still returned to the caller.
          try {
            // Extract test and result arguments.  WFRP4e typically passes the
            // weapon test object and its result into this helper but we do
            // not assume exact positions; we simply take the first two
            // arguments if present.
            const testArg = args[0] || {};
            const resultArg = args[1] || {};
            // Determine weapon and defender from the test object
            const weapon = testArg?.weapon || testArg?.data?.weapon || testArg?.attacker?.weapon;
            const damageType = mapWeaponToDamageType(weapon);
            // Attempt to find a hit location from either the result or the test.
            // Prefer a called shot; unwrap WFRP4e hitloc objects (.result holds the key string).
            const preDataArg = testArg?.preData || testArg?.data?.preData || {};
            const selectedHitLocArg = preDataArg?.selectedHitLocation;
            let locRaw;
            if (selectedHitLocArg && selectedHitLocArg !== 'roll' && selectedHitLocArg !== 'none') {
              locRaw = selectedHitLocArg;
            } else {
              const hitlocObj = resultArg?.hitloc || resultArg?.hitLocation || resultArg?.location || testArg?.result?.hitloc || testArg?.result?.hitLocation || testArg?.result?.location;
              locRaw = (hitlocObj && typeof hitlocObj === 'object') ? (hitlocObj.result ?? hitlocObj.value ?? hitlocObj.key ?? hitlocObj.name) : hitlocObj;
            }
            const location = normaliseLocation(locRaw);
            if (damageType && location) {
              // Use the defender's actor (or defender if already an actor) so
              // that the actorId can be stored on the message and proper
              // methods are available.  Without this tokens may lack
              // addCondition, causing errors when applying effects.
              const defender = testArg?.target || testArg?.defender || testArg?.data?.target || testArg?.data?.defender;
              const defenderActor = defender?.actor ?? defender;
              const res = await guardedJosefRoll(() => rollJosefCrit({ damageType, location, actor: defenderActor }));
              const josef = res?.josefResult;
              if (josef && defenderActor) {
                const dryRun = getDryRun();
                await applyJosefEffectsToActor(defenderActor, josef, { dryRun, debug: debug() });
              }
            } else {
              if (debug()) {
                if (!damageType) console.warn('JosefCrit: Could not infer damage type in patched applyCriticalEffect', weapon);
                if (!location) console.warn('JosefCrit: Could not determine hit location in patched applyCriticalEffect', locRaw);
              }
            }
          } catch (err) {
            console.error('JosefCrit: Error in patched applyCriticalEffect; Josef effects not applied', err);
          }
          return origResult;
        };
        util.applyCriticalEffect.__josefPatched = true;
      }
    } catch (err) {
      console.error('JosefCrit: Failed to patch applyCriticalEffect', err);
    }
  });

  // Infer damage type for an incoming vanilla critical item
  function inferDamageTypeFromCriticalData(data) {
    const flagDt = data?.flags?.[moduleId]?.damageType || data?.flags?.['wfrp4e-josef-crits']?.damageType;
    if (flagDt) return String(flagDt).toLowerCase();
    const sysDt = data?.system?.damageType || data?.system?.damagetype;
    if (typeof sysDt === 'string' && sysDt.trim()) return sysDt.toLowerCase();
    const name = (data?.name || '').toLowerCase();
    const guess = (str) => {
      if (str.includes('cut')) return 'cutting';
      if (str.includes('crush') || str.includes('blunt')) return 'crushing';
      if (str.includes('pierc') || str.includes('stab')) return 'piercing';
      if (str.includes('bullet') || str.includes('shot')) return 'bullets';
      if (str.includes('arrow') || str.includes('bolt')) return 'arrows-bolts';
      if (str.includes('claw') || str.includes('bite') || str.includes('fang')) return 'teeth-claws';
      if (str.includes('sling')) return 'sling';
      if (str.includes('flame') || str.includes('fire') || str.includes('energy')) return 'flames-energy';
      if (str.includes('unarmed') || str.includes('brawl') || str.includes('fist')) return 'unarmed';
      return null;
    };
    return guess(sysDt || '') || guess(name);
  }

  function inferLocationFromCriticalData(data) {
    const locField = data?.system?.location ?? data?.system?.hitLocation ?? data?.system?.hitloc;
    const locValue = (locField && typeof locField === 'object') ? (locField.value || locField.key || locField.name) : locField;
    const norm = normaliseLocation(locValue);
    if (norm) return norm;
    const name = (data?.name || '').toLowerCase();
    if (name.includes('head')) return 'head';
    if (name.includes('arm')) return 'arm';
    if (name.includes('leg')) return 'leg';
    return null;
  }

  async function deleteRecentDefaultCriticalMessages() {
    try {
      await new Promise((res) => setTimeout(res, 0));
      const recent = game.messages?.contents?.slice?.(-6) || [];
      for (const msg of recent) {
        const hasJosefFlag = msg?.getFlag?.(moduleId, 'josefCrit');
        const isSysCrit = msg?.flags?.wfrp4e?.crit || msg?.flags?.wfrp4e?.critical;
        if (!hasJosefFlag && isSysCrit) {
          await msg.delete();
        }
      }
    } catch (e) {
      if (debug()) console.warn('JosefCrit: Failed to remove default critical chat messages', e);
    }
  }

  async function createJosefCriticalReplacement(actor, { damageType, location, sourceData = {}, options = {} } = {}) {
    const res = await rollJosefCritFromPack({ damageType, location, actor, postChat: true });
    const josef = res?.josefResult;
    if (!josef) return false;

    const tableUuid = res?.compendium?.tableUuid || null;
    const resultUuid = res?.compendium?.resultUuid || null;
    const system = {
      wounds: { value: String(josef.wounds ?? sourceData?.system?.wounds?.value ?? '1') },
      modifier: { value: sourceData?.system?.modifier?.value || '' },
      location: { value: location },
      penalty: { value: sourceData?.system?.penalty?.value || '' },
      duration: { value: sourceData?.system?.duration?.value || '' },
      injury: { value: josef.description || josef.name }
    };

    const docData = {
      name: josef.name,
      type: 'critical',
      img: sourceData?.img || 'systems/wfrp4e/icons/blank.png',
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
          roll: res?.roll ?? null
        }
      }
    };

    const created = await actor.createEmbeddedDocuments('Item', [docData], { [moduleId]: { josefCreated: true } });
    const createdItem = created?.[0];
    await applyJosefEffectsToActor(actor, josef, { dryRun: getDryRun(), debug: debug() });
    await deleteRecentDefaultCriticalMessages();
    if (debug()) logDebug('Replaced vanilla critical with Josef', { actor: actor.name, damageType, location, tableUuid, resultUuid });
    return !!createdItem;
  }

  // Intercept WFRP critical table chat rolls to replace vanilla crits at the source.
  Hooks.once('ready', () => {
    try {
      const tables = game.wfrp4e?.tables;
      if (!tables || tables.formatChatRoll?.__josefWrapped) return;
      const original = tables.formatChatRoll;
      tables.formatChatRoll = async function (table, options = {}, column = null) {
        const mode = getMode();
        const key = String(table || '').toLowerCase();
        const isCrit = key.startsWith('crit');
        if (!isCrit || mode !== 'replaceDefault') {
          return await original.call(this, table, options, column);
        }
        const locRaw = key.replace(/^crit/, '');
        const location = normaliseLocation(locRaw) || 'body';
        const damageType = getDefaultDamageType();
        const actorId = options?.actorId || null;
        const actor = actorId ? game.actors?.get(actorId) : null;
        await guardedJosefRoll(() => rollJosefCritFromPack({ damageType, location, actor, postChat: true }));
        return '';
      };
      tables.formatChatRoll.__josefWrapped = true;
    } catch (err) {
      console.error('JosefCrit: failed to wrap formatChatRoll', err);
    }
  });

  // Intercept rollTable itself so any programmatic critical roll routes to Josef.
  Hooks.once('ready', () => {
    try {
      const tables = game.wfrp4e?.tables;
      if (!tables || tables.rollTable?.__josefWrapped) return;
      const original = tables.rollTable;
      const wrapper = async function (tableKey, options = {}, column = null) {
        const mode = getMode();
        const key = String(tableKey || '').toLowerCase();
        if (mode === 'replaceDefault' && key.startsWith('crit')) {
          const locRaw = key.replace(/^crit/, '');
          const location = normaliseLocation(locRaw) || 'body';
          const damageType = getDefaultDamageType();
          const r = await guardedJosefRoll(() => rollJosefCritFromPack({ damageType, location, actor: null, postChat: true }));
          // Return a minimal result to satisfy callers expecting rollTable shape.
          return {
            result: '',
            roll: r?.roll ?? null,
            total: r?.roll ?? null,
            object: null,
            results: []
          };
        }
        return await original.call(this, tableKey, options, column);
      };
      tables.rollTable = wrapper;
      tables.rollTable.__josefWrapped = true;
    } catch (err) {
      console.error('JosefCrit: failed to wrap rollTable', err);
    }
  });

  // Earlier interception: wrap handleTableClick so critical table clicks never reach the native formatter.
  Hooks.once('ready', () => {
    try {
      const util = game.wfrp4e?.utility;
      if (!util?.handleTableClick) return;
      const wrap = async function (wrapped, event, target) {
        const mode = getMode();
        if (mode === 'replaceDefault') {
          const tableKey = String(target?.dataset?.table || '').toLowerCase();
          if (tableKey.startsWith('crit')) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            const locRaw = tableKey.replace(/^crit/, '');
            const location = normaliseLocation(locRaw) || 'body';
            const damageType = getDefaultDamageType();
            await guardedJosefRoll(() => rollJosefCritFromPack({ damageType, location, actor: null, postChat: true }));
            return;
          }
        }
        return wrapped(event, target);
      };
      if (globalThis.libWrapper) {
        libWrapper.register(moduleId, 'game.wfrp4e.utility.handleTableClick', wrap, 'MIXED');
      } else {
        const orig = util.handleTableClick;
        util.handleTableClick = function (...args) { return wrap(orig.bind(util), ...args); };
      }
    } catch (err) {
      console.error('JosefCrit: failed to wrap handleTableClick', err);
    }
  });

  // Test plan (manual):
  // - replaceDefault: trigger vanilla crit, no vanilla critical item is created; Josef critical item appears on actor, effects apply, chat is Josef-only.
  // - off: vanilla behaviour unchanged, no Josef item/chat.
  // - sideBySide: vanilla behaviour plus Josef chat/effects without suppression.
}

// initIntegration is called by main.js inside its own ready hook.
// Do NOT add a second Hooks.once('ready', initIntegration) here — doing so
// registers every hook twice (double rolls, double patches).
