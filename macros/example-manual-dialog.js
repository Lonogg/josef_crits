// Macro to open a dialog that lets the GM manually roll a Josef crit.
// The dialog allows selection of damage type, location and ruleset.
// When the Roll button is pressed it calls the module API rollJosefCrit.

async function rollJosefDialog() {
  const mod = game.modules.get('wfrp4e-josef-crits');
  if (!mod) {
    ui.notifications.error('Josef Crits module is not enabled');
    return;
  }
  const api = mod.api || {};
  if (!api.rollJosefCrit) {
    ui.notifications.error('Josef Crits API is not available');
    return;
  }
  const registry = await fetch('modules/wfrp4e-josef-crits/data/registry.json').then(r => r.json());
  const dts = Object.keys(registry.damageTypes);
  const dtOptions = dts.map(dt => `<option value='${dt}'>${dt}</option>`).join('');
  const defaultLocs = registry.damageTypes[dts[0]].locations;
  const locOptions = defaultLocs.map(loc => `<option value='${loc}'>${loc}</option>`).join('');
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
          await api.rollJosefCrit({ damageType: dt, location: loc, ruleset: rs });
        }
      },
      cancel: { label: 'Cancel' }
    },
    default: 'roll'
  }).render(true);
}

rollJosefDialog();