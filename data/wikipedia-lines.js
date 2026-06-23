/**
 * wikipedia-lines.js
 *
 * Parses the German Wikipedia "Liste der Eisenbahnlinien in Brandenburg und
 * Berlin" into a canonical Berlin-Brandenburg line set, used as a QA layer for
 * the VBB-API-built lines.json:
 *
 *  - which RE/RB lines SHOULD exist (detect discovery gaps / suspensions)
 *  - which refs are out-of-state duplicates (the page tags them "(Sachsen)",
 *    "(Sachsen-Anhalt)" …) so we can flag wrongly-included foreign lines
 *  - each line's route (Verlauf), whose terminal stops seed extra harvest hubs
 *    so missing lines can self-heal
 *
 * We deliberately do NOT parse the "Vorübergehende Änderungen" (temporary
 * changes) prose — the VBB API already reflects live construction reroutes.
 */

const WIKI_URL =
  'https://de.wikipedia.org/w/index.php?title=Liste_der_Eisenbahnlinien_in_Brandenburg_und_Berlin&action=raw';

const SKIP_SECTIONS = new Set([
  'S-Bahn Berlin',
  'Vorübergehende Änderungen',
  'Übersicht der Neuerungen im Fahrplan 2026',
]);

export async function fetchWikipediaLines(userAgent) {
  const res = await fetch(WIKI_URL, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseWikipedia(await res.text());
}

export function parseWikipedia(wiki) {
  const sections = splitSections(wiki);

  const expected = new Set();        // BB RE/RB refs (unsuffixed)
  const foreignRefs = new Set();     // refs that appear with a "(Sachsen…)" suffix
  const termini = new Map();         // ref -> [first, ...middle, last] station names
  const fullRoute = new Map();       // ref -> ordered station names

  for (const { title, body } of sections) {
    if (SKIP_SECTIONS.has(title)) continue;
    const m = title.match(/^(RE|RB)\s*(\d+)\s*(.*)$/);
    if (!m) continue; // FEX / HBX / TES / "S 1 (S-Bahn Mittelelbe)" etc.
    const ref = `${m[1]}${m[2]}`;
    const suffixed = m[3].trim().length > 0;

    if (suffixed) {
      foreignRefs.add(ref);
      continue; // not a Berlin-Brandenburg line
    }

    expected.add(ref);
    const stops = parseVerlauf(body);
    if (stops.length >= 2) {
      fullRoute.set(ref, stops);
      // First, last, and a middle stop give the best chance of catching the
      // line at a harvest hub regardless of where it diverges from a trunk.
      const mid = stops[Math.floor(stops.length / 2)];
      termini.set(ref, [...new Set([stops[0], mid, stops[stops.length - 1]])]);
    }
  }

  return { expected, foreignRefs, termini, fullRoute };
}

function splitSections(wiki) {
  const re = /^==== (.+?) ====$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(wiki))) heads.push({ title: m[1].trim(), start: m.index, end: re.lastIndex });
  return heads.map((h, i) => ({
    title: h.title,
    body: wiki.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : wiki.length),
  }));
}

// The route lives in the table cell with the most "–" separators.
function parseVerlauf(body) {
  let best = '';
  let bestCount = 1;
  for (const line of body.split('\n')) {
    const count = (line.match(/–/g) || []).length;
    if (count > bestCount) { bestCount = count; best = line; }
  }
  if (!best) return [];

  const cell = best
    .replace(/^\s*\|[^|]*\|\s*/, '')   // drop leading "|colspan=…|" cell markup
    .replace(/^\s*\|\s*/, '')
    .replace(/&nbsp;|&#160;|&shy;/g, ' ')
    .replace(/'''?/g, ' ');            // strip bold/italic markers

  return cell
    .split('–')
    .map(cleanWikiStation)
    .filter(Boolean);
}

function cleanWikiStation(segment) {
  const link = segment.match(/\[\[([^\]]+)\]\]/);
  let name = link
    ? (link[1].includes('|') ? link[1].split('|').pop() : link[1])
    : segment.replace(/\[\[|\]\]/g, '');
  return name
    .replace(/#.*$/, '')               // drop "#Bahnhof" anchors
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
