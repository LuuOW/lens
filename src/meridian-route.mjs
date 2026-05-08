// Candidate routing for lens — calls the live Meridian MCP at
// mcp.ask-meridian.uk via its first-party browser endpoint
// (POST /v1/route). The endpoint is operator-pays: a single GitHub
// PAT lives as a Cloudflare Worker secret, so the lens user never
// pastes credentials. The endpoint is Origin-restricted server-side
// (lens.ask-meridian.uk is allowlisted).
//
// Returns the same { task, selected, ... } shape the MCP tool emits,
// so spawnOrbit() can keep consuming `selected[i].classification.physics.orbital`
// to render real classifier-driven orbits.
//
// Replaces an earlier path that called GitHub Models directly with
// a user-pasted PAT. Routing through the MCP keeps lens credential-free.

const ROUTE_ENDPOINT    = 'https://mcp.ask-meridian.uk/v1/route'
const FEEDBACK_ENDPOINT = 'https://mcp.ask-meridian.uk/v1/feedback'
const TIMEOUT_MS = 60_000

export async function route({ task, limit = 5, signal } = {}) {
  if (!task) throw new Error('task required')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)

  let res
  try {
    res = await fetch(ROUTE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: String(task).slice(0, 800), limit }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Meridian MCP HTTP ${res.status}`)

  const candidates = body.selected || []
  const top_score = body.top_score || candidates[0]?.route_score || 0
  return {
    task:        body.task ?? task,
    candidates,
    total:       body.candidates_generated ?? candidates.length,
    top_score,
    confidence:  body.confidence || (top_score >= 30 ? 'strong' : top_score >= 8 ? 'moderate' : 'weak'),
    candidates_generated: body.candidates_generated ?? candidates.length,
    classifier:  'meridian-mcp@cf-worker',
  }
}

// Fire-and-forget feedback POST. The worker uses these to drive
// online SGD on the fitted-correction layer that sits on top of the
// orbital classifier — so user engagements (planet clicks, detail
// opens) gradually nudge the ranking toward what users actually pick.
//
// Never throws or blocks the UI. Failures are logged at warn level
// and dropped — feedback is best-effort by design.
export function sendFeedback({ task, candidates, chosenSlug, action = 'click' }) {
  if (!task || !Array.isArray(candidates) || !chosenSlug) return
  try {
    fetch(FEEDBACK_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({
        query:        task,
        selected:     candidates,
        chosen_slug:  chosenSlug,
        action,
      }),
      keepalive: true,    // survives page unload — feedback often fires on navigation
    }).catch(e => console.warn('[meridian-route] feedback failed:', e?.message || e))
  } catch (e) {
    console.warn('[meridian-route] feedback fire failed:', e?.message || e)
  }
}
