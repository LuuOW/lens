// Open-domain orbital classifier. Derives a physics signature for each
// skill (mass, scope, independence, cross_domain, fragmentation, drag,
// dep_ratio), assigns a celestial class, computes orbital + optical
// parameters, and scores task→skill relevance.
//
// Pure JS. Runs identically in browser and Node — no bundler-only globals.

import { tokenize, uniq } from './tokenize.mjs'
import { SYSTEM_TERMS }   from './systems.mjs'

const CLASS_BOOST = {
  planet: 1.30, trojan: 1.20, irregular: 1.10,
  moon: 1.05, asteroid: 0.85, comet: 0.80,
}

function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }
function r3(x) { return Math.round(x * 1000) / 1000 }
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function physicsOf(skill, sibTokens) {
  const desc  = (skill.description || '').toLowerCase()
  const body  = (skill.body || '').toLowerCase()
  const kws   = (skill.keywords || []).map(k => String(k).toLowerCase())
  const kwSet = new Set(kws)
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  const bodyLen = body.length
  const massRaw = (Math.log10(Math.max(50, bodyLen)) - 1.7) * 0.35 + Math.min(0.4, kws.length / 15)
  const mass = clamp(massRaw)

  const sysAffinity = {}
  for (const [sys, terms] of Object.entries(SYSTEM_TERMS)) {
    let hits = 0
    for (const t of tokens) if (terms.has(t)) hits++
    sysAffinity[sys] = clamp(hits / 6)
  }
  const dominant = Object.entries(sysAffinity).reduce((a, b) => a[1] > b[1] ? a : b)[0]
  const sysVec   = Object.values(sysAffinity)
  const sysSum   = sysVec.reduce((s, v) => s + v, 0) || 1
  const sysProbs = sysVec.map(v => v / sysSum)
  const H = -sysProbs.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0)
  const cross_domain = clamp(H / Math.log(3))

  const top2 = sysVec.slice().sort((a, b) => b - a)
  const lagrange_potential = clamp(Math.min(top2[0], top2[1]) * 1.4)

  const scope = clamp(0.25 + Math.min(0.5, kws.length / 14) + cross_domain * 0.25)

  let bestTokSim = 0, bestKwSim = 0
  for (const sib of sibTokens) {
    if (sib.skill === skill) continue
    const inter = sib.toks.reduce((n, t) => n + (tokens.includes(t) ? 1 : 0), 0)
    const union = new Set([...tokens, ...sib.toks]).size
    const j = union ? inter / union : 0
    if (j > bestTokSim) bestTokSim = j

    const sibKws = new Set((sib.skill.keywords || []).map(k => String(k).toLowerCase()))
    if (sibKws.size && kwSet.size) {
      let ki = 0
      for (const k of kwSet) if (sibKws.has(k)) ki++
      const ku = new Set([...kwSet, ...sibKws]).size
      const kj = ku ? ki / ku : 0
      if (kj > bestKwSim) bestKwSim = kj
    }
  }
  const dep_ratio = clamp(Math.max(bestTokSim * 1.5, bestKwSim * 2.2))

  const independence = clamp(1 - dep_ratio * 0.7 + mass * 0.2)

  const lens = kws.map(k => k.length)
  const meanL = lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length)
  const sdL   = Math.sqrt(lens.reduce((s, x) => s + (x - meanL) ** 2, 0) / Math.max(1, lens.length))
  const fragmentation = clamp(sdL / 8 + cross_domain * 0.4)

  const longWords = kws.filter(k => k.includes('-') || k.length >= 12).length
  const drag = clamp(longWords / Math.max(2, kws.length) * 0.7 + cross_domain * 0.2)

  const semi_major_axis = r3(1 + (1 - 0.5 * mass - 0.3 * scope - 0.2 * independence) * 6)
  const eccentricity    = r3(clamp(Math.abs(mass - scope) * 0.85 + drag * 0.3, 0, 0.95))
  const inclination     = r3(cross_domain * (Math.PI / 2))
  const orbital_period  = r3(Math.pow(semi_major_axis, 1.5))
  const perihelion      = r3(semi_major_axis * (1 - eccentricity))
  const aphelion        = r3(semi_major_axis * (1 + eccentricity))
  const slugHash        = hashStr(skill.slug || '')
  const mean_anomaly    = r3(((slugHash % 1000) / 1000) * 2 * Math.PI)

  const wavelength      = Math.round(Math.max(380, Math.min(750,
    380 + mass * 370 - drag * 100 - cross_domain * 50)))
  const polarization    = r3(clamp(1 - fragmentation, 0, 1))
  const amplitude       = r3(mass)
  const phaseHash       = hashStr(`${skill.slug || ''}|${(body || '').slice(0, 64)}`)
  const phase           = r3(((phaseHash % 1000) / 1000) * 2 * Math.PI)

  return {
    mass, scope, independence, cross_domain,
    fragmentation, drag, dep_ratio,
    lagrange_potential,
    star_system: dominant,
    star_affinity: sysAffinity,
    orbital: { semi_major_axis, eccentricity, inclination,
               orbital_period, perihelion, aphelion, mean_anomaly },
    optical: { wavelength, polarization, amplitude, phase },
  }
}

export { CLASS_BOOST, SYSTEM_TERMS }

export function classOf(p, hasParentInSet) {
  const planet_score   = p.mass * p.scope * p.independence
  const moon_score     = Math.max(0, 0.5 - p.independence) * 2
                         * (hasParentInSet ? 1 : 0.4)
                         * (1 - 0.5 * p.mass)
  const trojan_score   = p.dep_ratio * (hasParentInSet ? 1 : 0.5) * (1 - p.fragmentation)
  const asteroid_score = Math.max(0, 0.4 - p.mass) * 2.5 * p.scope * p.independence
  const comet_score    = p.drag * p.cross_domain * (1 - p.dep_ratio)
  const irregular_score= p.cross_domain * p.fragmentation * 0.85

  const candidates = {
    planet: planet_score, moon: moon_score, trojan: trojan_score,
    asteroid: asteroid_score, comet: comet_score, irregular: irregular_score,
  }
  let cls = 'asteroid', best = -1
  for (const [k, v] of Object.entries(candidates)) {
    if (v > best) { best = v; cls = k }
  }
  return { cls, scores: candidates }
}

function decisionRule(cls, p, parent, systems) {
  const sys = p.star_system
  const cdSystems = systems.filter(s => p.star_affinity[s] >= 0.25)
  switch (cls) {
    case 'planet':
      return `Domain anchor in the ${sys} system — high mass (${p.mass.toFixed(2)}) × scope (${p.scope.toFixed(2)}) × independence (${p.independence.toFixed(2)}). Loads as a primary skill.`
    case 'moon':
      return `Sub-skill orbiting ${parent ? parent + ' ' : 'a parent skill'}— low independence (${p.independence.toFixed(2)}). Auto-loads alongside its parent.`
    case 'trojan':
      return `Companion at L4/L5 of ${parent ? parent + ' ' : 'a parent skill'}— high dep_ratio (${p.dep_ratio.toFixed(2)}), low fragmentation. Co-activates permanently.`
    case 'asteroid':
      return `Narrow-scope niche tool — low mass (${p.mass.toFixed(2)}) but independently useful. Loaded only when explicitly relevant.`
    case 'comet':
      return `Occasional / specialized skill — high drag (${p.drag.toFixed(2)}) × cross_domain (${p.cross_domain.toFixed(2)}). Triggers on rare task profiles.`
    case 'irregular':
      return `Cross-domain bridge — spans ${cdSystems.join(' ↔ ') || 'multiple systems'}. High fragmentation, useful for hybrid tasks.`
  }
  return ''
}

export function orbitalClassify(skills, task) {
  const enriched = skills.map(s => ({
    skill: s,
    toks: uniq([
      ...tokenize(s.description),
      ...tokenize(s.body),
      ...(s.keywords || []).flatMap(k => tokenize(k)),
    ]),
  }))

  const physics = enriched.map(({ skill }) => physicsOf(skill, enriched))

  const parents = enriched.map(({ toks }, i) => {
    let best = null, bestSim = 0
    for (let j = 0; j < enriched.length; j++) {
      if (j === i) continue
      const sib  = enriched[j]
      const inter = sib.toks.reduce((n, t) => n + (toks.includes(t) ? 1 : 0), 0)
      const union = new Set([...toks, ...sib.toks]).size
      const j2 = union ? inter / union : 0
      if (j2 > bestSim) { bestSim = j2; best = sib.skill.slug }
    }
    return bestSim > 0.18 ? best : null
  })

  const taskTokens = uniq(tokenize(task))

  const classified = enriched.map(({ skill }, i) => {
    const p = physics[i]
    const parent = parents[i]
    const { cls, scores } = classOf(p, !!parent)

    let hits = [], desc_hits = 0, body_hits = 0, kw_hits = 0
    const kwTokens = new Set((skill.keywords || []).flatMap(k => tokenize(k)))
    const descTokens = new Set(tokenize(skill.description))
    const body = (skill.body || '').toLowerCase()
    for (const t of taskTokens) {
      const k = kwTokens.has(t),  d = descTokens.has(t),  b = body.includes(t)
      if (k) kw_hits++
      if (d) desc_hits++
      if (b) body_hits = Math.min(20, body_hits + Math.min(3, body.split(t).length - 1))
      if (k || d || b) hits.push(t)
    }

    const tokenScore = kw_hits * 10 + desc_hits * 5 + body_hits
    const diversity  = 1 + Math.max(0, hits.length - 1) * 0.12
    const classBoost = CLASS_BOOST[cls] || 1
    const versatility= 1 + Math.min(0.30, p.lagrange_potential * 0.5)
    const route_score = Number((tokenScore * diversity * classBoost * versatility).toFixed(3))

    const systems = Object.keys(SYSTEM_TERMS)
    const lagrange_systems = systems.filter(s => p.star_affinity[s] >= 0.25)

    return {
      slug:        skill.slug,
      name:        skill.name || skill.slug,
      description: skill.description,
      body:        skill.body || '',
      keywords:    skill.keywords || [],
      route_score,
      classification: {
        class:              cls,
        class_scores:       scores,
        physics:            p,
        parent,
        star_system:        p.star_system,
        lagrange_systems,
        lagrange_potential: p.lagrange_potential,
        decision_rule:      decisionRule(cls, p, parent, systems),
        habitable_zone:     p.mass >= 0.4 && p.mass <= 0.85,
        tidal_lock:         cls === 'trojan' || (cls === 'moon' && p.dep_ratio > 0.55),
      },
      breakdown: {
        kw_hits, desc_hits, body_hits,
        diversity_mult: Number(diversity.toFixed(2)),
        class_mult:     Number(classBoost.toFixed(2)),
        lagrange_mult:  Number(versatility.toFixed(2)),
        tokens:         hits,
      },
      hits: { keywords: kw_hits, description: desc_hits, body: body_hits, tokens: hits },
      why: explainRoute({ kw_hits, desc_hits, body_hits, cls, classBoost, versatility, hits, parent }),
    }
  })

  classified.sort((a, b) => b.route_score - a.route_score)
  return classified
}

function explainRoute({ kw_hits, desc_hits, body_hits, cls, classBoost, versatility, hits, parent }) {
  const parts = []
  if (kw_hits)   parts.push(`${kw_hits} keyword`)
  if (desc_hits) parts.push(`${desc_hits} desc`)
  if (body_hits) parts.push(`${body_hits} body`)
  let line = parts.join(' · ')
  line += ` · ${cls}×${classBoost.toFixed(2)}`
  if (versatility > 1.01) line += ` · L×${versatility.toFixed(2)}`
  if (parent) line += ` · parent=${parent}`
  if (hits.length) line += ` · "${hits.slice(0, 5).join(', ')}"`
  return line
}
