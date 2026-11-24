_ = require 'underscore'
RSX = require 'app/data/resources'
CardType = require 'app/sdk/cards/cardType'
Factions = require 'app/sdk/cards/factionsLookup'
Rarity = require 'app/sdk/cards/rarityLookup'
CardSet = require 'app/sdk/cards/cardSetLookup'
Unit = require 'app/sdk/entities/unit'
Artifact = require 'app/sdk/artifacts/artifact'
Spell = require 'app/sdk/spells/spell'
SpellFilterType = require 'app/sdk/spells/spellFilterType'
SpellDamage = require 'app/sdk/spells/spellDamage'
SpellHeal = require 'app/sdk/spells/spellHeal'
SpellSilence = require 'app/sdk/spells/spellSilence'
SpellApplyModifiers = require 'app/sdk/spells/spellApplyModifiers'

Modifier = require 'app/sdk/modifiers/modifier'
ModifierProvoke = require 'app/sdk/modifiers/modifierProvoke'
ModifierFirstBlood = require 'app/sdk/modifiers/modifierFirstBlood'
ModifierFlying = require 'app/sdk/modifiers/modifierFlying'
ModifierRanged = require 'app/sdk/modifiers/modifierRanged'
ModifierAirdrop = require 'app/sdk/modifiers/modifierAirdrop'
ModifierTranscendance = require 'app/sdk/modifiers/modifierTranscendance'
ModifierFrenzy = require 'app/sdk/modifiers/modifierFrenzy'
ModifierBlastAttack = require 'app/sdk/modifiers/modifierBlastAttack'
ModifierForcefield = require 'app/sdk/modifiers/modifierForcefield'
ModifierBanding = require 'app/sdk/modifiers/modifierBanding'
ModifierBackstab = require 'app/sdk/modifiers/modifierBackstab'
ModifierRebirth = require 'app/sdk/modifiers/modifierRebirth'
ModifierUntargetable = require 'app/sdk/modifiers/modifierUntargetable'

i18next = require 'i18next'
if i18next.t() is undefined
  i18next.t = (text) ->
    return text

customCardsData = require './custom_cards.json'

KEYWORD_MAP =
  provoke: () -> ModifierProvoke.createContextObject()
  rush: () -> ModifierFirstBlood.createContextObject()
  flying: () -> ModifierFlying.createContextObject()
  ranged: () -> ModifierRanged.createContextObject()
  airdrop: () -> ModifierAirdrop.createContextObject()
  celerity: () -> ModifierTranscendance.createContextObject()
  frenzy: () -> ModifierFrenzy.createContextObject()
  blast: () -> ModifierBlastAttack.createContextObject()
  forcefield: () -> ModifierForcefield.createContextObject()
  zeal: () -> ModifierBanding.createContextObject()
  backstab: () -> ModifierBackstab.createContextObject(2)
  rebirth: () -> ModifierRebirth.createContextObject()
  elusive: () -> ModifierUntargetable.createContextObject()

class CustomCardFactory

  @isDisabled: (identifier) ->
    disabled = customCardsData.disabledCards || []
    return _.contains(disabled, identifier)

  @getOverride: (identifier) ->
    overrides = customCardsData.overrides || {}
    return overrides[String(identifier)] || null

  @applyOverride: (card, identifier) ->
    ov = @getOverride(identifier)
    if !ov? or !card?
      return card
    if ov.manaCost? then card.manaCost = Number(ov.manaCost)
    if ov.atk? and card.atk? then card.atk = Number(ov.atk)
    if ov.maxHP? and card.maxHP? then card.maxHP = Number(ov.maxHP)
    if ov.factionId? then card.factionId = Number(ov.factionId)
    if ov.rarityId? then card.rarityId = Number(ov.rarityId)
    if ov.cardSetId? then card.cardSetId = Number(ov.cardSetId)
    if ov.isHiddenInCollection? then card.setIsHiddenInCollection(Boolean(ov.isHiddenInCollection))
    if ov.isAvailable? then card.setIsAvailable(Boolean(ov.isAvailable))
    if ov.nameKey?
      card.name = i18next.t(ov.nameKey)
    else if ov.name?
      card.name = ov.name
    if ov.descriptionKey?
      card.setDescription(i18next.t(ov.descriptionKey))
    else if ov.description?
      card.setDescription(ov.description)
    return card

  @cardForIdentifier: (identifier, gameSession) ->
    list = customCardsData.cards || []
    def = _.find(list, (c) -> Number(c.id) == Number(identifier))
    if !def?
      return null

    card = null
    type = def.type || 'Unit'

    if type == 'Spell'
      tpl = def.spellTemplate || 'damage'
      if tpl == 'heal'
        card = new SpellHeal(gameSession)
        card.healModifier = Number(def.spellValue ? 3)
        card.spellFilterType = SpellFilterType.AllyIndirect
      else if tpl == 'silence'
        card = new SpellSilence(gameSession)
        card.spellFilterType = SpellFilterType.NeutralDirect
      else if tpl == 'buff'
        card = new SpellApplyModifiers(gameSession)
        card.spellFilterType = SpellFilterType.AllyDirect
        buffAtk = Number(def.spellBuffAtk ? 2)
        buffHp = Number(def.spellBuffHp ? 2)
        statCtx = Modifier.createContextObjectWithAttributeBuffs(buffAtk, buffHp)
        statCtx.appliedName = def.name || 'Custom Buff'
        card.setTargetModifiersContextObjects([statCtx])
      else
        card = new SpellDamage(gameSession)
        card.damageAmount = Number(def.spellValue ? 2)
        card.spellFilterType = SpellFilterType.EnemyDirect
    else if type == 'Artifact'
      card = new Artifact(gameSession)
      atkBonus = Number(def.artifactAtk ? 2)
      if atkBonus != 0
        card.setTargetModifiersContextObjects([
          Modifier.createContextObjectWithAttributeBuffs(atkBonus, 0, {
            name: def.name || 'Custom Artifact'
            description: def.description || ''
          })
        ])
    else
      card = new Unit(gameSession)
      if def.isGeneral
        card.setIsGeneral(true)
      card.atk = Number(def.atk ? 2)
      card.maxHP = Number(def.maxHP ? 3)
      if def.raceId? and Number(def.raceId) > 0
        card.raceId = Number(def.raceId)
      if def.keywords? and def.keywords.length > 0
        mods = []
        for kw in def.keywords
          fn = KEYWORD_MAP[kw]
          if fn?
            mods.push(fn())
        if mods.length > 0
          card.setInherentModifiersContextObjects(mods)

    card.factionId = Number(def.factionId ? Factions.Neutral)
    card.rarityId = Number(def.rarityId ? Rarity.Common)
    card.cardSetId = Number(def.cardSetId ? CardSet.Core)
    card.manaCost = Number(def.manaCost ? 2)

    if def.nameKey?
      card.name = i18next.t(def.nameKey)
    else
      card.name = def.name || "Custom Card #{def.id}"

    if def.descriptionKey?
      card.setDescription(i18next.t(def.descriptionKey))
    else if def.description?
      card.setDescription(def.description)

    if def.isHiddenInCollection
      card.setIsHiddenInCollection(true)
    if def.isAvailable? and !def.isAvailable
      card.setIsAvailable(false)

    # 复用动画/图标资源
    if def.animResource? and _.isObject(def.animResource)
      card.setBaseAnimResource(def.animResource)
    else if def.spriteKey? and RSX[def.spriteKey]?
      if type == 'Unit'
        card.setBaseAnimResource(
          breathing: RSX[def.spriteKey].name
          idle: RSX[def.spriteKey].name
          walk: RSX[def.spriteKey].name
          attack: RSX[def.spriteKey].name
          damage: RSX[def.spriteKey].name
          death: RSX[def.spriteKey].name
        )
      else
        card.setBaseAnimResource(
          idle: RSX[def.spriteKey].name
          active: RSX[def.spriteKey].name
        )
    else
      if type == 'Unit'
        card.setBaseAnimResource(
          breathing: RSX.f1SilverguardSquireBreathing.name
          idle: RSX.f1SilverguardSquireIdle.name
          walk: RSX.f1SilverguardSquireRun.name
          attack: RSX.f1SilverguardSquireAttack.name
          damage: RSX.f1SilverguardSquireDamage.name
          death: RSX.f1SilverguardSquireDeath.name
        )
      else if type == 'Artifact'
        card.setBaseAnimResource(
          idle: RSX.iconSunstoneBracers.name
          active: RSX.iconSunstoneBracersActive.name
        )
      else
        card.setBaseAnimResource(
          idle: RSX.iconTrueStrike.name
          active: RSX.iconTrueStrikeActive.name
        )

    return card

module.exports = CustomCardFactory
