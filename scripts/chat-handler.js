/*
 * chat-handler.js
 *
 * This module adds interactivity to Josef critical chat cards.  When
 * a chat message flagged with the josefCrit flag is rendered, it
 * attaches click handlers to buttons embedded in the card.  These
 * handlers perform the appropriate actor updates: applying conditions
 * or injuries, subtracting wounds, or rolling secondary tests and
 * duration dice.  The actor id is retrieved from the chat message
 * flags; if absent no updates are performed.  Fallback behaviour is
 * conservative – if the WFRP4e test APIs are unavailable the module
 * will instead perform a simple d100 roll and display the result.
 */

function handleJosefChatCard(message, html) {
  // Only process Josef crit messages
  const flag = message?.getFlag?.('wfrp4e-josef-crits', 'josefCrit');
  if (!flag) return;
  // Support both deprecated jQuery html object and new HTMLElement
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  // Avoid double binding when both hooks fire
  if (root.dataset?.josefChatBound) return;
  root.dataset.josefChatBound = 'true';
  const actorId = message.getFlag('wfrp4e-josef-crits', 'actorId');
  const actor = actorId ? game.actors?.get(actorId) : null;
  // Attach a single delegated click handler to this card
  root.querySelectorAll('.chat-button').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const btn = ev.currentTarget;
      const action = btn.dataset.action;
      if (!actor) {
        ui.notifications?.warn?.('No actor associated with this critical.');
        return;
      }
      try {
        if (action === 'apply-condition' || action === 'apply-injury' || action === 'apply-wounds') {
          if (!(game.user.isGM || actor.isOwner)) {
            ui.notifications?.warn?.('You do not have permission to apply effects to this actor.');
            return;
          }
        }
        if (action === 'apply-condition') {
          const condId = btn.dataset.condId;
          const val = btn.dataset.condValue;
          const value = val ? parseInt(val, 10) : undefined;
          if (condId && actor?.addCondition) {
            await actor.addCondition(condId, value);
          }
        } else if (action === 'apply-injury') {
          let uuid = btn.dataset.injuryUuid;
          const name = btn.dataset.injuryName;
          if (!uuid && name) {
            // Try to find the injury in the core items compendium
            const pack = game.packs?.get?.('wfrp4e-core.items');
            if (pack) {
              await pack.getIndex();
              const entry = pack.index.find((e) => e.name?.toLowerCase?.() === name.toLowerCase());
              if (entry) uuid = entry.uuid;
            }
          }
          if (uuid) {
            const doc = await fromUuid(uuid);
            if (doc) {
              await actor.createEmbeddedDocuments('Item', [doc.toObject()]);
            }
          } else {
            ui.notifications?.warn?.(`Injury ${name || uuid} not found.`);
          }
        } else if (action === 'apply-wounds') {
          const wounds = parseInt(btn.dataset.wounds || '0', 10);
          if (wounds > 0) {
            // Attempt to access current wounds value across versions
            let current = undefined;
            if (actor?.system?.wounds?.value != null) {
              current = actor.system.wounds.value;
            } else if (actor?.system?.characteristics?.wounds?.value != null) {
              current = actor.system.characteristics.wounds.value;
            } else if (actor?.system?.characteristics?.wnds?.value != null) {
              current = actor.system.characteristics.wnds.value;
            }
            if (typeof current === 'number') {
              const newValue = Math.max(current - wounds, 0);
              await actor.update({ 'system.wounds.value': newValue });
            }
          }
        } else if (action === 'roll-test') {
          const skill = btn.dataset.skill;
          const characteristic = btn.dataset.char;
          const diffStr = btn.dataset.diff;
          const diff = diffStr ? parseInt(diffStr, 10) : 0;
          let rolled = false;
          // If a skill name is provided attempt to find the matching skill item
          if (skill) {
            const item = actor.items?.find((i) => i.name?.toLowerCase?.() === skill.toLowerCase() && i.type === 'skill');
            if (item && typeof actor.setupSkillTest === 'function') {
              const test = await actor.setupSkillTest(item, { difficulty: diff });
              if (test?.roll) {
                await test.roll();
                rolled = true;
              }
            }
          }
          // If not rolled and characteristic key is provided use characteristic test
          if (!rolled && characteristic && typeof actor.setupCharacteristicTest === 'function') {
            const test = await actor.setupCharacteristicTest(characteristic, { difficulty: diff });
            if (test?.roll) {
              await test.roll();
              rolled = true;
            }
          }
          // Fallback: simple d100 roll with message
          if (!rolled) {
            const r = new Roll('1d100');
            await r.evaluate();
            const label = skill || characteristic || 'Test';
            ChatMessage.create({ content: `Rolled ${r.total} for ${label} (Diff ${diff >= 0 ? '+' : ''}${diff}).`, speaker: ChatMessage.getSpeaker({ actor }) });
          }
        } else if (action === 'roll-duration') {
          const formula = btn.dataset.formula;
          if (formula) {
            const r = new Roll(formula);
            await r.evaluate();
            const total = r.total;
            ChatMessage.create({ content: `Movement is halved for ${total} rounds.`, speaker: ChatMessage.getSpeaker({ actor }) });
          }
        }
      } catch (err) {
        console.error('JosefCrit chat-handler error', err);
      }
    });
  });
}

Hooks.on('renderChatMessageHTML', handleJosefChatCard);
