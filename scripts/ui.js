
import { loadRegistry } from './loader.js';
import { rollJosefCrit } from './roller.js';

Hooks.on('renderTokenHUD', async (hud, html, data) => {
  const mod = game.modules.get('wfrp4e-josef-crits');
  if (!mod) return;
  const btn = $(`<div class='control-icon' title='Josef Crit'><i class='fas fa-skull-crossbones'></i></div>`);
  btn.on('click', async () => {
    const registry = await loadRegistry();
    const dtOptions = Object.keys(registry.damageTypes).map(dt => `<option value='${dt}'>${dt}</option>`).join('');
    const locOptions = registry.damageTypes[Object.keys(registry.damageTypes)[0]].locations.map(loc => `<option value='${loc}'>${loc}</option>`).join('');
    const content = `<form>` +
      `<div class='form-group'><label>Damage Type</label><select name='dt'>${dtOptions}</select></div>` +
      `<div class='form-group'><label>Location</label><select name='loc'>${locOptions}</select></div>` +
      `<div class='form-group'><label>Ruleset</label><select name='ruleset'><option value='inherit'>Inherit</option><option value='core'>Core</option><option value='uia'>Up In Arms</option></select></div>` +
      `</form>`;
    new Dialog({
      title: 'Roll Josef Crit',
      content: content,
      buttons: {
        roll: {
          label: 'Roll',
          callback: async (html) => {
            const dt = html.find("select[name='dt']").val();
            const loc = html.find("select[name='loc']").val();
            const rs = html.find("select[name='ruleset']").val();
            await rollJosefCrit({ damageType: dt, location: loc, ruleset: rs });
          }
        },
        cancel: { label: 'Cancel' }
      },
      default: 'roll'
    }).render(true);
  });
  html.find('.left').append(btn);
});
