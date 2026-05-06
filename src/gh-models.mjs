// Dynamic skill routing for lens — same architecture as the
// meridian-skills-mcp 2.0.0 npm package: an LLM (Llama-3.3-70B via
// GitHub Models) generates fresh SKILL.md candidates per task, then a
// local orbital classifier ranks them. No static corpus.
//
// The orbital classifier itself is imported cross-origin from the
// meridian-mcp deployment so lens and the npm package share one
// implementation. The user must provide a GitHub PAT with the
// `Models: read` permission; the lens gate captures it and stashes it
// in localStorage under `lens.github_token`.

const ENDPOINT = 'https://models.github.ai/inference/chat/completions'
const MODEL    = 'meta/llama-3.3-70b-instruct'
const PKG_VER  = 'lens-vlm-1'
const CANDIDATES = 5

const ORBITAL_URL = 'https://luuow.github.io/meridian-mcp/_lib/orbital.mjs'
let _orbitalPromise = null
function loadOrbital() {
  if (_orbitalPromise) return _orbitalPromise
  _orbitalPromise = import(/* @vite-ignore */ ORBITAL_URL)
  return _orbitalPromise
}

// Token storage: localStorage on lens.ask-meridian.uk. The user pastes
// it once at the gate; subsequent loads pick it up automatically.
const TOKEN_KEY = 'lens.github_token'
export function getToken()       { return localStorage.getItem(TOKEN_KEY) || '' }
export function setToken(token)  { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY) }
export function hasToken()       { return !!getToken() }

const SYSTEM_PROMPT = `You generate "SKILL.md" candidate documents for an AI agent's tool registry.

For the user's task, propose ${CANDIDATES} candidate skills the agent might load. Each skill is a self-contained capability with a slug, one-line description, list of relevant keywords, and a markdown body that walks the agent through "Use it for", "Workflow", and any "Pitfalls".

Respond with a JSON object:
{
  "skills": [
    {
      "slug": "kebab-case-id",
      "description": "one sentence explaining what this skill does",
      "keywords": ["term1", "term2", "..."],
      "body": "## Use It For\\n- ...\\n\\n## Workflow\\n1. ...\\n\\n## Pitfalls\\n- ...\\n"
    }
  ]
}

Rules:
- Generate exactly ${CANDIDATES} candidates.
- Slugs must be unique kebab-case strings.
- Keywords are 4–10 short terms relevant to retrieval.
- Body is concrete, action-oriented markdown with the three sections above.
- Skills should be diverse — different angles on the task — not minor variations.
- No prose outside the JSON.`

async function generateCandidates(task, token, signal) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': PKG_VER,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Task: ${task}\n\nGenerate ${CANDIDATES} candidate skills.` },
      ],
    }),
    signal,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error?.message || body.message || `GitHub Models HTTP ${res.status}`)
  const text = body.choices?.[0]?.message?.content
  if (!text) throw new Error('LLM returned empty content')
  let parsed
  try { parsed = JSON.parse(text) }
  catch {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    parsed = JSON.parse(cleaned)
  }
  const arr = Array.isArray(parsed.skills) ? parsed.skills : []
  if (!arr.length) throw new Error('LLM produced no skills')
  return arr.map(s => ({
    slug:        String(s.slug || '').slice(0, 80),
    name:        String(s.slug || ''),
    description: String(s.description || ''),
    keywords:    Array.isArray(s.keywords) ? s.keywords.map(String).slice(0, 12) : [],
    body:        String(s.body || ''),
  }))
}

// Mirrors the route() shape that lens previously imported from meridian's
// static-corpus router, so spawnOrbit() in index.js can use the result
// without any further changes downstream.
export async function route({ task, limit = 5, signal } = {}) {
  if (!task) throw new Error('task required')
  const token = getToken()
  if (!token) throw new Error('GitHub PAT required (lens.github_token in localStorage). Set one at the gate.')

  const [{ orbitalClassify }, candidates] = await Promise.all([
    loadOrbital(),
    generateCandidates(task, token, signal),
  ])

  const ranked = orbitalClassify(candidates, task)
  const top = ranked.slice(0, Math.max(1, Math.min(20, limit)))
  const top_score = top[0]?.route_score || 0
  return {
    task,
    skills: top,
    total: ranked.length,
    top_score,
    confidence: top_score >= 30 ? 'strong' : top_score >= 8 ? 'moderate' : 'weak',
    candidates_generated: candidates.length,
    classifier: 'orbital-edge-v1',
  }
}
