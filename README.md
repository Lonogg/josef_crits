# WFRP4e - Josef Tham Expanded Criticals

This module implements all of the critical hit tables from Josef Tham's **Expanded Critical Hits for Warhammer Fantasy Roleplay 4e**.
Each damage type and hit location combination is provided as its own JSON table and is automatically converted into a Foundry RollTable.

In addition to manual rolling, the module can integrate these tables into the normal WFRP4e combat flow.  When enabled, the module listens for weapon tests that result in a critical hit, determines the appropriate Josef table based on the weapon used and the hit location, rolls a result and applies the conditions and injuries described.  You can configure how this integration behaves via module settings.

## Usage

- Install and enable the module in Foundry VTT.
- Configure your preferred ruleset (Core vs Up In Arms) under **Settings → Module Settings → WFRP4e Josef Crits**.
- Optionally override the ruleset on a per-user basis.
- Use the provided macros in the `macros/` folder or the token HUD button to roll a critical effect.

### Integration Modes

Under **Settings → Module Settings → WFRP4e Josef Crits** you will find the **Integration Mode** setting:

- **Off**: The module does not automatically intervene in combat.  Use the macros or HUD button to roll manually.
- **Side By Side**: When a crit occurs the module rolls the appropriate Josef table and posts the result to chat (and applies any conditions/injuries) while leaving the default WFRP4e crit in place.  Use this to compare results.
- **Replace Default**: After a crit the module attempts to remove any conditions or injuries applied by the default WFRP4e crit and instead applies Josef’s result.  This is experimental and may conflict with other modules.  Use with care.

### Dry Run Mode

Enable **Dry Run** in the module settings to simulate application of conditions and injuries without actually modifying any actors.  The chat message will list what would be applied.  This is useful for testing or if you are unsure how the integration will behave.

## Tables Included

The following damage types and hit locations are included:

```
Cutting, Crushing, Piercing, Bullets, Arrows & Bolts, Teeth & Claws,
Shrapnel & Shot, Sling, Flames & Energy, Unarmed
```
for each of the locations `Head`, `Arm`, `Body`, and `Leg`, and both the **Core** and **Up In Arms** rulesets.

## Development

The data tables are stored in the `data/` folder as JSON files and are generated from the original PDF.
If you wish to modify the entries, edit the appropriate JSON file and reload the module.


## Credits

This module would not exist without the work of **Josef Tham**, whose *Expanded Critical Hits for Warhammer Fantasy Roleplay 4e* is the entire foundation of what this module does. All critical hit tables are his original creation. If you get value out of this module, the credit belongs to him.

- **Original Content**: Josef Tham – *Expanded Critical Hits for WFRP4e*
- **Foundry Module**: Lonogg

https://www.windsofchaos.com/?page_id=19
