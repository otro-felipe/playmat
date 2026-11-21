import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archetypesFor, classifyArchetype, verifiedListArchetype } from './deck-performance-identity.mjs'

test('Pioneer library imports resolve tournament nicknames and color abbreviations before generic strategies', () => {
  const names = {
    'Jund Aggro': 'Jund Aggro',
    'Devotion to Green': 'Mono-Green Devotion',
    'RDW': 'Mono-Red Aggro',
    'UR Aggro': 'Izzet Aggro',
    'Lotus Field': 'Lotus Field Combo',
    'UW Control': 'Azorius Control',
    'Golgari MIDRANGE': 'Golgari Midrange',
    'Izzet Control': 'Izzet Control',
    'Selesnya Aggro': 'Selesnya Aggro',
    'Boros Aggro': 'Boros Aggro',
    'Greasefang Parhelion': 'Greasefang Parhelion',
    Creativity: 'Creativity',
    'Jeskai Control': 'Jeskai Control',
  }
  for (const [name, expected] of Object.entries(names)) {
    assert.equal(classifyArchetype('Constructed - Pioneer', name), expected, name)
    assert.ok(archetypesFor('Pioneer').includes(expected))
  }
  assert.equal(classifyArchetype('Pioneer', 'Pilot · UR Aggro v2'), 'Izzet Aggro')
  assert.equal(classifyArchetype('Constructed - Freeform', 'Lotus Field'), 'Other')
  assert.equal(classifyArchetype('Pioneer', 'words with infield endpoints'), 'Other')
})


test('only complete all-basic practice lists and corroborated starter names can refine ambiguous legacy labels', () => {
  const land = amount => [{ name: 'Snow-Covered Forest', amount }]
  const face = { name: 'Ajani, Valiant Protector', amount: 1 }
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(60)), 'Basic Lands Practice')
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(59)), null)
  assert.equal(verifiedListArchetype('Limited', 'Practice', land(40)), 'Basic Lands Practice')
  assert.equal(verifiedListArchetype('Variant Magic - Momir Basic', 'Test', land(60)), null)
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(60), [face]), null)
  assert.equal(verifiedListArchetype('Freeform', face.name, [face]), null)
  assert.equal(verifiedListArchetype('Freeform', face.name, [...land(59), face]), 'Selesnya Counters')
  assert.equal(verifiedListArchetype('Pioneer', face.name, [...land(59), face]), null)
})

test('Pioneer archive classifiers resolve current tournament lists by cards even when a pilot renames them', async () => {
  const card = (name, quantity = 4) => ({ name, quantity })
  const core = ['Kaito, Bane of Nightmares', 'Moon-Circuit Hacker', 'Faerie Miscreant', 'Floodpits Drowner'].map(name => card(name))
  assert.ok(archetypesFor('Pioneer').includes('Dimir Ninjas'))
  assert.ok(archetypesFor('Pioneer').includes('Izzet Cauldron'))
  assert.equal(verifiedListArchetype('Pioneer', 'Untitled', [...core, card('Island', 44)]), 'Dimir Ninjas')
  assert.equal(verifiedListArchetype('Modern', 'Untitled', [...core, card('Island', 44)]), null)
  assert.equal(verifiedListArchetype('Pioneer', 'Dimir Ninjas', core), null)
  assert.equal(verifiedListArchetype('Pioneer', 'Untitled', [card('Island', 60)], core), null)
})

test('all 40 Pioneer tournament labels have a distinct searchable category and miscellaneous buckets stay unknown', () => {
  const examples = {
    'UR Aggro': 'Izzet Aggro', 'Red Deck Wins': 'Mono-Red Aggro', 'Devotion to Green': 'Mono-Green Devotion',
    'Arclight Phoenix': 'Izzet Phoenix', 'Weenie White': 'Mono-White Aggro', 'Mono Black Aggro': 'Mono-Black Aggro',
    'The Rock (Golgari Control)': 'Golgari Midrange', 'UW Control': 'Azorius Control',
    'Mono Black Control': 'Mono-Black Control', 'Lotus Field': 'Lotus Field Combo',
  }
  const names = 'Jund|Selesnya Aggro|Dimir Aggro|Boros Aggro|Azorius Tempo / Spirit Aggro|Rakdos Sacrifice|Rakdos Aggro|5c Legends Aggro|Gruul Aggro|Humans|Golgari Aggro|Elves|Goblins|Auras|Izzet Control|Jeskai Control|Dimir Control|Orzhov Control|Boros Control|Sultai Control|Green Ramp|Enigmatic Incarnation|Esper Control|Temur Control|Bant Control|Niv-Mizzet Reborn|Creativity|Greasefang Parhelion|Jeskai Ascendancy|Retraction Helix'.split('|')
  for (const name of names) examples[name] = name
  assert.equal(Object.keys(examples).length, 40)
  for (const [name, label] of Object.entries(examples)) assert.equal(classifyArchetype('Pioneer', name), label, name)
  for (const name of ['Other - Aggro','Other - Combo','Other - Control']) assert.equal(classifyArchetype('Pioneer', name), 'Other')
})

test('characteristic engines distinguish renamed lists, color splashes, and two decks with the same title', () => {
  const cases = [
    ['Temur Lessons', 'Gran-Gran|Tablet of Discovery|Firebending Lesson|Questing Druid'],
    ['Four-Color Lessons', 'Gran-Gran|Tablet of Discovery|Firebending Lesson|Questing Druid|Jeskai Revelation'],
    ["Lumra's Scapeshift", 'Scapeshift|Spelunking|Lumra, Bellow of the Woods'],
    ['Rakdos Midrange', 'Bloodtithe Harvester|Fable of the Mirror-Breaker // Reflection of Kiki-Jiki|Thoughtseize|Sheoldred, the Apocalypse'],
    ['Sultai Beanstalk', 'Up the Beanstalk|Overlord of the Balemurk|Wistfulness|Deceit'],
    ['Rakdos Leyline Aggro', 'Cacophony Scamp|Callous Sell-Sword // Burn Together|Leyline of Resonance'],
    ['Izzet Prowess', "Stormchaser's Talent|Academic Dispute|Pompous Battlemage|Spirebluff Canal"],
    ['Retraction Helix', 'Retraction Helix|Mox Amber|Rona, Herald of Invasion'],
    ['Mono-Green Creature Toolbox', "Fiend Artisan|Enduring Vitality|Nature's Rhythm|Craterhoof Behemoth"],
    ['Dimir Control', 'Drown in the Loch|Fatal Push|Spell Snare|Jace Beleren|Thoughtseize'],
    ['Mono-Red Aggro', 'Kumano Faces Kakkazan // Etching of Kumano|Soul-Scar Mage|Sunspine Lynx|Screaming Nemesis'],
  ]
  for (const [expected, packageText] of cases) {
    const cards = packageText.split('|').map(cardName => ({ cardName, amount: 4 }))
    cards.push({ cardName: 'Mountain', amount: 60 - cards.length * 4 })
    assert.equal(verifiedListArchetype('Pioneer', 'Same title', cards), expected)
  }
  assert.equal(verifiedListArchetype('Pioneer', 'New deck', []), 'Empty deck')
})

test('an unformatted archived registration can recover unique packages and exact published starter lists', async () => {
  const asList = names => [...names.map(cardName => ({ cardName, amount: 4 })), { cardName: 'Forest', amount: 60 - 4 * names.length }]
  for (const format of [null, 'Constructed - Freeform']) {
    assert.equal(verifiedListArchetype(format, null, asList(['Leyline of Resonance','Callous Sell-Sword','Cacophony Scamp'])), 'Rakdos Leyline Aggro')
    assert.equal(verifiedListArchetype(format, 'Practice', asList(['Eldrazi Temple','Eye of Ugin','Thought-Knot Seer','Reality Smasher'])), 'Eldrazi Stompy')
    assert.equal(verifiedListArchetype(format, null, asList(['Up the Beanstalk','Force of Will','Leyline Binding','Brainstorm'])), 'Beanstalk Control')
    assert.equal(verifiedListArchetype(format, null, asList(['Reanimate','Animate Dead','Griselbrand','Faithless Looting'])), 'Rakdos Reanimator')
  }
  assert.equal(verifiedListArchetype(null, 'Eldrazi Stompy', [{ cardName: 'Eldrazi Temple', amount: 1 }]), null)
})

test('the October Pioneer Challenge exile engine identifies Orzhov Ketramose, and Legacy exposes Beanstalk Control', () => {
  const cards = ['Ketramose, the New Dawn', 'Rest in Peace', 'Eldrazi Displacer', 'Wasteland Strangler'].map(cardName => ({ cardName, amount: 3 }))
  const mana = { cardName: 'Godless Shrine', amount: 48 }
  assert.equal(verifiedListArchetype('Pioneer', 'Orzhov Midrange', [...cards, mana]), 'Orzhov Ketramose')
  assert.notEqual(verifiedListArchetype('Pioneer', 'Orzhov Midrange', [cards[0], { ...mana, amount: 57 }], cards.slice(1)), 'Orzhov Ketramose')
  assert.ok(archetypesFor('Constructed - Legacy').includes('Beanstalk Control'))
})

test('archived Dimir Control and mono-red prowess are identified by their registered main decks', () => {
  const red = ['Monastery Swiftspear', 'Soul-Scar Mage', 'Slickshot Show-Off', 'Play with Fire', 'Lightning Strike', 'Monstrous Rage', 'Emberheart Challenger', 'Light Up the Stage']
  const asDeck = (names, land) => [...names.map(cardName => ({ cardName, amount: 3 })), { cardName: land, amount: 60 - names.length * 3 }]
  const ub = asDeck(['Anthropological Mission', 'Drown in the Loch', 'Fatal Push', 'Spell Snare', 'Thoughtseize', 'Consider'], 'Island')
  const variants = [['Burst Lightning', "Wizard's Lightning", 'Rending Volley', 'Unlicensed Hearse'], ['Abrade', 'Den of the Bugbear', 'Reckless Impulse', 'Skewer the Critics', 'Roiling Vortex']]
  for (const format of ['Pioneer', null, 'Constructed - Freeform']) {
    assert.equal(verifiedListArchetype(format, 'UB', ub), 'Dimir Control')
    for (const variant of variants) {
      const cards = asDeck([...red, ...variant], 'Mountain')
      assert.equal(verifiedListArchetype(format, null, cards, [{ cardName: 'Negate', amount: 1 }]), 'Mono-Red Prowess')
      assert.notEqual(verifiedListArchetype(format, 'Mono-Red Prowess', asDeck([...red, ...variant, 'Spirebluff Canal'], 'Mountain')), 'Mono-Red Prowess')
    }
  }
  assert.ok(archetypesFor('Pioneer').includes('Mono-Red Prowess'))
})

test('only the exact registered sixty-card creature practice configurations receive the practice label', () => {
  const card = (name, amount) => ({ cardName: name, amount })
  const green = [card('Forest',44),...['Elvish Mystic','Elvish Reclaimer','Gilded Goose','Llanowar Elves'].map(name => card(name,4))]
  const red = [card('Mountain',52), card('Mountain',4), card('Monastery Swiftspear',4)]
  for (const format of ['Pioneer','Freeform',null]) {
    for (const cards of [red,green]) assert.equal(verifiedListArchetype(format, 'Unrelated title', cards), 'Creature Practice')
    assert.notEqual(verifiedListArchetype(format, 'Fixture', [card('Mountain',55),card('Lightning Bolt',1),card('Monastery Swiftspear',4)]), 'Creature Practice')
    assert.notEqual(verifiedListArchetype(format, 'Fixture', [card('Forest',44), ...green.slice(1,4), card('Elvish Visionary',4)]), 'Creature Practice')
  }
  assert.ok(archetypesFor('Freeform').includes('Creature Practice'))
})
