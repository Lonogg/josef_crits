import { initIntegration } from './integration.js';

Hooks.once('init', () => {
  const moduleId = 'wfrp4e-josef-crits';
  game.settings.register(moduleId, 'defaultRuleset', {
    name: game.i18n.localize('JOSEFCRITS.settings.defaultRuleset.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.defaultRuleset.hint'),
    scope: 'world',
    config: true,
    type: String,
    choices: { core: 'Core', uia: 'Up In Arms' },
    default: 'core'
  });
  game.settings.register(moduleId, 'userOverrideRuleset', {
    name: game.i18n.localize('JOSEFCRITS.settings.userOverrideRuleset.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.userOverrideRuleset.hint'),
    scope: 'client',
    config: true,
    type: String,
    choices: { inherit: 'Inherit', core: 'Core', uia: 'Up In Arms' },
    default: 'inherit'
  });
  game.settings.register(moduleId, 'integrationMode', {
    name: game.i18n.localize('JOSEFCRITS.settings.integrationMode.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.integrationMode.hint'),
    scope: 'world',
    config: true,
    type: String,
    choices: { off: 'Off', replaceDefault: 'Replace Default', sideBySide: 'Side By Side' },
    default: 'off'
  });
  game.settings.register(moduleId, 'debugMode', {
    name: game.i18n.localize('JOSEFCRITS.settings.debugMode.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.debugMode.hint'),
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(moduleId, 'defaultDamageType', {
    name: game.i18n.localize('JOSEFCRITS.settings.defaultDamageType.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.defaultDamageType.hint'),
    scope: 'world',
    config: true,
    type: String,
    choices: {
      cutting: 'Cutting',
      crushing: 'Crushing',
      piercing: 'Piercing',
      bullets: 'Bullets',
      'arrows-bolts': 'Arrows & Bolts',
      'teeth-claws': 'Teeth & Claws',
      'shrapnel-shot': 'Shrapnel & Shot',
      sling: 'Sling',
      'flames-energy': 'Flames & Energy',
      unarmed: 'Unarmed'
    },
    default: 'cutting'
  });

  // Dry run mode: when enabled no conditions or injuries are actually applied to actors.
  game.settings.register(moduleId, 'dryRunMode', {
    name: game.i18n.localize('JOSEFCRITS.settings.dryRunMode.name'),
    hint: game.i18n.localize('JOSEFCRITS.settings.dryRunMode.hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once('ready', () => {
  initIntegration();

  const moduleId = 'wfrp4e-josef-crits';
  const debug = () => game.settings.get(moduleId, 'debugMode');
  const dryRunSetting = () => game.settings.get(moduleId, 'dryRunMode');

  function buildCriticalItemData(result) {
    if (!result) return null;
    return {
      name: result.name || 'Critical Injury',
      type: 'critical',
      img: 'systems/wfrp4e/icons/blank.png',
      system: {
        wounds: { value: String(result.wounds ?? 1) },
        modifier: { value: '' },
        location: { value: result.location || '' },
        injury: { value: result.description || result.name || '' },
        penalty: { value: '' },
        duration: { value: '' }
      },
      flags: {
        [moduleId]: {
          josefCreated: true,
          damageType: result.damageType,
          location: result.location,
          roll: result.roll ?? null
        }
      }
    };
  }

  function attachDragSource(el, message) {
    if (!el || !message) return;
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', ev => {
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
      const result = message.getFlag(moduleId, 'result');
      const payload = {
        type: 'josefCrit',
        messageId: message.id,
        module: moduleId,
        result
      };
      ev.dataTransfer?.setData('text/plain', JSON.stringify(payload));
      if (ev.dataTransfer && ev.currentTarget instanceof HTMLElement) {
        ev.dataTransfer.setDragImage(ev.currentTarget, ev.currentTarget.offsetWidth / 2, ev.currentTarget.offsetHeight / 2);
      }
      if (debug()) console.log('JosefCrit: Drag start payload', payload);
    });
  }

  function getTokenAtDrop(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    const tokens = canvas?.tokens?.placeables || [];
    // Iterate in reverse so tokens drawn on top are checked first.
    // Use token.bounds (a PIXI Rectangle in canvas world-space) which is the
    // canonical way to hit-test in Foundry v12+.  Avoid the document.width/height
    // fallback — those values are in grid units, not pixels, so they break on
    // any grid size other than 1.
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i]?.bounds?.contains?.(x, y)) return tokens[i];
    }
    return null;
  }

  async function applyJosefToToken(target, josefResult, opts = {}) {
    if (!target || !josefResult) return;
    const actor = (target instanceof Actor) ? target : (target.document?.actor || target.actor || (target.prototypeToken ? target : null));
    if (!actor) return;
    const mod = game.modules.get(moduleId);
    const apply = mod?.api?.applyJosefEffectsToActor;
    if (typeof apply !== 'function') return;
    const dryRun = opts.dryRun ?? dryRunSetting();
    const dbg = opts.debug ?? debug();
    if (dbg) console.log('JosefCrit: Applying to actor', actor.name);
    if (opts.createItem) {
      const itemData = buildCriticalItemData(josefResult);
      if (itemData) {
        await actor.createEmbeddedDocuments('Item', [itemData]);
      }
    }
    await apply(actor, josefResult, { dryRun, debug: dbg });
  }

  function resolveActorsForApply(message) {
    const actors = [];
    const actorId = message?.getFlag?.(moduleId, 'actorId');
    if (actorId) {
      const a = game.actors?.get(actorId);
      if (a) actors.push(a);
    }
    if (!actors.length && game.user?.targets?.size) {
      for (const t of game.user.targets) {
        if (t?.actor) actors.push(t.actor);
      }
    }
    if (!actors.length && canvas?.tokens?.controlled?.length) {
      for (const t of canvas.tokens.controlled) {
        if (t?.actor) actors.push(t.actor);
      }
    }
    return actors;
  }

  // Mark Josef crit cards draggable and wire apply button.
  const handleRender = (message, html) => {
    if (!message?.getFlag || !message.getFlag(moduleId, 'josefCrit')) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    if (root.dataset?.josefBound) return;
    root.dataset.josefBound = 'true';
    // Attach dragstart to the root chat message element so any drag on the
    // Josef card (or its outer Foundry wrapper) sends our payload.
    attachDragSource(root, message);
    // Also attach to the explicit drag handle so it works as a dedicated target.
    // The handle's dragstart calls stopPropagation so root won't double-fire.
    const handle = root.querySelector('.josef-drag-handle');
    if (handle) attachDragSource(handle, message);
    // Apply button
    const applyBtn = root.querySelector('.josef-apply-all');
    if (applyBtn) {
      applyBtn.addEventListener('click', async ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const josef = message.getFlag(moduleId, 'result');
        const actors = resolveActorsForApply(message);
        if (!actors.length) {
          ui.notifications?.warn?.('Select a token to apply this Josef crit.');
          return;
        }
        for (const actor of actors) {
          try {
            await applyJosefToToken(actor, josef, { dryRun: dryRunSetting(), debug: debug(), createItem: true });
          } catch (err) {
            console.warn('JosefCrit: Failed to apply via button', err);
          }
        }
      });
    }
  };

  Hooks.on('renderChatMessageHTML', handleRender);

  function safeParseJosefData(data) {
    if (!data) return null;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch (e) {
        console.warn('JosefCrit: Failed to parse drag data', e);
        return null;
      }
    }
    return data;
  }

  async function resolveJosefResultFromPayload(payload) {
    if (!payload) return null;
    if (payload.result) return payload.result;
    if (payload.messageId) {
      const msg = game.messages?.get(payload.messageId);
      if (msg instanceof ChatMessage) return msg.getFlag(moduleId, 'result');
    }
    return null;
  }

  Hooks.on('dropCanvasData', async (canvas, data) => {
    const payload = safeParseJosefData(data?.data ?? data);
    if (!payload || payload.type !== 'josefCrit' || payload.module !== moduleId) return;
    if (debug()) console.log('JosefCrit: dropCanvasData payload', payload);
    if (!game.user?.isGM) {
      ui.notifications?.warn?.('Only the GM can apply Josef crits via drag-and-drop.');
      return false;
    }
    const josef = await resolveJosefResultFromPayload(payload);
    if (!josef) return;
    const coords = {
      x: typeof payload.x === 'number' ? payload.x : (typeof data?.x === 'number' ? data.x : undefined),
      y: typeof payload.y === 'number' ? payload.y : (typeof data?.y === 'number' ? data.y : undefined)
    };
    if (coords.x == null || coords.y == null) {
      const pointer = canvas?.app?.renderer?.events?.pointer;
      if (pointer?.global) {
        const pt = canvas.stage?.toLocal?.(pointer.global);
        coords.x = coords.x ?? pt?.x;
        coords.y = coords.y ?? pt?.y;
      }
    }
    const token = getTokenAtDrop(coords.x, coords.y);
    if (!token) {
      ui.notifications?.warn?.('Drop the Josef crit onto a token to apply it.');
      return false;
    }
    try {
      await applyJosefToToken(token, josef, { dryRun: dryRunSetting(), debug: debug(), createItem: true });
    } catch (err) {
      console.warn('JosefCrit: Failed to apply dropped critical', err);
    }
    return false;
  });

  Hooks.on('dropActorSheetData', async (actor, sheet, data) => {
    const payload = safeParseJosefData(data?.data ?? data);
    if (!payload || payload.type !== 'josefCrit' || payload.module !== moduleId) return;
    if (debug()) console.log('JosefCrit: dropActorSheetData payload', payload);
    if (!game.user?.isGM) {
      ui.notifications?.warn?.('Only the GM can apply Josef crits via drag-and-drop.');
      return false;
    }
    const josef = await resolveJosefResultFromPayload(payload);
    if (!josef || !actor) return false;
    try {
      await applyJosefToToken(actor, josef, { dryRun: dryRunSetting(), debug: debug(), createItem: true });
    } catch (err) {
      console.warn('JosefCrit: Failed to apply dropped critical to actor sheet', err);
    }
    return false;
  });
});
