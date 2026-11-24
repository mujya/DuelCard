class Factions

  @Faction1:   1
  @Faction2:   2
  @Faction3:   3
  @Faction4:   4
  @Faction5:   5
  @Faction6:   6
  @Neutral:  100
  @Tutorial: 200
  @Boss: 300

  # by name

  @Lyonar:     1
  @Songhai:   2
  @Vetruvian: 3
  @Abyssian:  4
  @Magmar:     5
  @Vanar:     6

# Inject custom factions registered via Duelyst Studio
customFactionsData = require './custom/custom_factions.json'
if customFactionsData?.factions?
  for cf in customFactionsData.factions
    if cf.id? and cf.key?
      Factions[cf.key] = Number(cf.id)

module.exports = Factions
