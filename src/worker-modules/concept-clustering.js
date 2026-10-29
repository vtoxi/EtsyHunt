// concept-clustering.js
//
// Pure-JS tight-cluster product concept builder. No DOM, no network, no
// imports — safe to run in the service worker.
//
// Inputs:
//   keywords: Array<{
//     keyword_id: number|string,
//     keyword: string,
//     searches?: number,          // monthly Etsy searches
//     tags?: string[]             // optional: Etsy tags observed on top listings
//   }>
//   config: {
//     cluster_min_shared_tokens: number,   // default 2
//     cluster_jaccard_threshold: number,   // default 0.5
//     cluster_use_tag_graph: 0|1,          // default 1
//     cluster_max_size: number,            // default 8
//     cluster_stopword_langs: string       // default 'en,es'
//   }
//
// Output:
//   Array<{
//     concept_label: string,
//     keyword_ids: Array<number|string>,
//     keyword_count: number,
//     total_searches: number,
//     shared_tokens: string[]
//   }>
//
// Tight clustering: each keyword belongs to at most one concept.
// Union-find over an edge set built from (a) Jaccard similarity of non-stopword
// token sets gated by min_shared_tokens and (b) optional tag co-occurrence when
// cluster_use_tag_graph=1. Post-pass splits clusters larger than cluster_max_size.

// ---------- Stopwords ----------
const STOPWORDS_EN = new Set([
  'a','an','and','or','the','of','for','to','in','on','with','by','from',
  'at','as','is','it','this','that','these','those','be','are','was','were',
  'my','your','our','their','his','her','its','i','you','we','they','he','she',
  'not','no','but','so','if','then','than','too','very','just','also','more',
  'most','any','all','some','each','every','such','own','same','other','new',
  'best','top','cute','cool','nice','pretty','perfect','great','super','ultimate',
  'custom','personalized','unique','handmade','vintage','gift','gifts','idea','ideas',
  'style','design','designs','set','sets','pack','packs','bundle','bundles',
  'print','prints','printable','digital','download','downloadable','file','files',
  'svg','png','jpg','jpeg','pdf','eps','dxf','ai','psd','cricut','silhouette',
  'instant','ready','easy','quick','simple','fun','modern','classic','trendy',
]);

const STOPWORDS_ES = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','al','y','o','u',
  'e','en','con','por','para','sin','sobre','entre','hasta','desde','como',
  'que','qué','cual','cuál','quien','quién','donde','dónde','cuando','cuándo',
  'es','son','ser','estar','está','están','fue','fueron','era','eran','soy',
  'eres','somos','sois','mi','tu','su','nuestro','vuestro','mis','tus','sus',
  'yo','tú','él','ella','nosotros','vosotros','ellos','ellas','me','te','se',
  'le','lo','nos','os','les','no','sí','si','ni','pero','mas','aunque','porque',
  'muy','mucho','poco','más','menos','tan','tanto','todo','toda','todos','todas',
  'otro','otra','otros','otras','mismo','misma','cada','algún','alguna','ningún',
  'ninguna','nuevo','nueva','mejor','regalo','regalos','idea','ideas','estilo',
  'diseño','diseños','personalizado','personalizada','único','única','hecho',
  'hecha','mano','descarga','imprimible','digital','archivo','archivos',
]);

export function getStopwords(langsCsv) {
  const set = new Set();
  const langs = String(langsCsv || 'en,es').toLowerCase().split(',').map(s => s.trim());
  if (langs.includes('en')) for (const w of STOPWORDS_EN) set.add(w);
  if (langs.includes('es')) for (const w of STOPWORDS_ES) set.add(w);
  return set;
}

// ---------- Tokenization ----------
export function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripPlural(tok) {
  if (tok.length > 4 && tok.endsWith('es')) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith('s'))  return tok.slice(0, -1);
  return tok;
}

export function tokenize(str, stopwords) {
  const norm = normalize(str);
  if (!norm) return [];
  const out = [];
  for (const raw of norm.split(' ')) {
    if (!raw) continue;
    if (raw.length < 2) continue;
    const t = stripPlural(raw);
    if (stopwords.has(t) || stopwords.has(raw)) continue;
    out.push(t);
  }
  return out;
}

// ---------- Similarity ----------
export function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sharedTokenCount(setA, setB) {
  let n = 0;
  for (const t of setA) if (setB.has(t)) n++;
  return n;
}

// ---------- Union-Find ----------
function makeUF(n) {
  const parent = new Array(n);
  const rank = new Array(n).fill(0);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
    return true;
  }
  return { find, union };
}

// ---------- Label picker ----------
function pickConceptLabel(members, tokenSets, sharedTokens) {
  const withShared = members.filter(m => {
    const s = tokenSets.get(m.keyword_id);
    return sharedTokens.every(t => s.has(t));
  });
  const pool = withShared.length ? withShared : members;
  pool.sort((a, b) => {
    const sa = a.searches || 0, sb = b.searches || 0;
    if (sb !== sa) return sb - sa;
    return (a.keyword || '').length - (b.keyword || '').length;
  });
  return pool[0].keyword;
}

// ---------- Splitter for oversized clusters ----------
function splitOversized(memberIdxs, tokenSets, idToKw, maxSize, jaccardThreshold) {
  const remaining = new Set(memberIdxs);
  const subclusters = [];

  while (remaining.size > 0) {
    if (remaining.size <= maxSize) {
      subclusters.push(Array.from(remaining));
      break;
    }
    let seed = null, seedSearches = -1;
    for (const idx of remaining) {
      const kw = idToKw.get(idx);
      const s = kw.searches || 0;
      if (s > seedSearches) { seedSearches = s; seed = idx; }
    }
    const sub = [seed];
    remaining.delete(seed);

    while (sub.length < maxSize && remaining.size > 0) {
      let best = null, bestAvg = -1;
      for (const cand of remaining) {
        const candSet = tokenSets.get(idToKw.get(cand).keyword_id);
        let sum = 0;
        for (const m of sub) {
          sum += jaccard(candSet, tokenSets.get(idToKw.get(m).keyword_id));
        }
        const avg = sum / sub.length;
        if (avg > bestAvg) { bestAvg = avg; best = cand; }
      }
      if (bestAvg < jaccardThreshold) break;
      sub.push(best);
      remaining.delete(best);
    }
    subclusters.push(sub);
  }
  return subclusters;
}

// ---------- Main entry ----------
export function clusterKeywordsIntoConcepts(keywords, config = {}) {
  const minShared   = Number(config.cluster_min_shared_tokens ?? 2);
  const jThreshold  = Number(config.cluster_jaccard_threshold ?? 0.5);
  const useTagGraph = Number(config.cluster_use_tag_graph ?? 1) === 1;
  const maxSize     = Number(config.cluster_max_size ?? 8);
  const stopwords   = getStopwords(config.cluster_stopword_langs ?? 'en,es');

  const n = keywords.length;
  if (n === 0) return [];

  const tokenSets = new Map();
  const tagSets   = new Map();
  const idToKw    = new Map();
  for (let i = 0; i < n; i++) {
    const kw = keywords[i];
    idToKw.set(i, kw);
    tokenSets.set(kw.keyword_id, new Set(tokenize(kw.keyword, stopwords)));
    const tagNorm = Array.isArray(kw.tags)
      ? kw.tags.map(t => normalize(t)).filter(Boolean).map(stripPlural)
      : [];
    tagSets.set(kw.keyword_id, new Set(tagNorm));
  }

  const uf = makeUF(n);

  for (let i = 0; i < n; i++) {
    const si = tokenSets.get(keywords[i].keyword_id);
    if (si.size === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const sj = tokenSets.get(keywords[j].keyword_id);
      if (sj.size === 0) continue;
      if (sharedTokenCount(si, sj) < minShared) continue;
      if (jaccard(si, sj) >= jThreshold) uf.union(i, j);
    }
  }

  if (useTagGraph) {
    for (let i = 0; i < n; i++) {
      const ti = tagSets.get(keywords[i].keyword_id);
      if (ti.size < 2) continue;
      for (let j = i + 1; j < n; j++) {
        if (uf.find(i) === uf.find(j)) continue;
        const tj = tagSets.get(keywords[j].keyword_id);
        if (tj.size < 2) continue;
        if (sharedTokenCount(ti, tj) >= 2) uf.union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const concepts = [];
  for (const memberIdxs of groups.values()) {
    const subs = memberIdxs.length > maxSize
      ? splitOversized(memberIdxs, tokenSets, idToKw, maxSize, jThreshold)
      : [memberIdxs];

    for (const sub of subs) {
      const members = sub.map(idx => idToKw.get(idx));
      let shared = null;
      for (const m of members) {
        const s = tokenSets.get(m.keyword_id);
        if (shared === null) shared = new Set(s);
        else for (const t of Array.from(shared)) if (!s.has(t)) shared.delete(t);
      }
      const sharedArr = Array.from(shared || []);
      const label = pickConceptLabel(members, tokenSets, sharedArr);
      const totalSearches = members.reduce((sum, m) => sum + (m.searches || 0), 0);
      concepts.push({
        concept_label: label,
        keyword_ids: members.map(m => m.keyword_id),
        keyword_count: members.length,
        total_searches: totalSearches,
        shared_tokens: sharedArr,
      });
    }
  }

  concepts.sort((a, b) => b.total_searches - a.total_searches);
  return concepts;
}
