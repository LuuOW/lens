// Shared tokenizer. Lowercase → strip non-alphanum (keep hyphen) → drop
// short tokens (<3) and English stopwords. Mirrors src/embeddings.mjs and
// scripts/build-miniapp-index.mjs so token boundaries stay aligned across
// build-time IDF and runtime scoring.

export const STOP = new Set([
  'the','and','for','with','that','this','from','have','your','about',
  'into','what','when','where','which','their','there','these','those',
  'will','would','should','could','been','being','need','want','get',
  'set','use','using','make','made','like','also','some','any','all',
  'one','two','out','off','its',"it's",'you',"you're",'our',
])

export function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}

export function uniq(arr) { return [...new Set(arr)] }
