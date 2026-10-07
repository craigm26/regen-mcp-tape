// SPEC § 5 (label) and § 6 (redaction) restated as code, for computing expected trace content.
// Written from SPEC.md. JavaScript's RegExp gives the ECMAScript meanings of \b, \s and .
// that § 6.2 pins, so the patterns are used as written there.

export const R = '[REDACTED]';

export const EXACT_KEYS = new Set(['api_key', 'apiKey', 'token', 'bearer', 'secret', 'password', 'passwd', 'pwd',
  'private_key', 'privateKey', 'access_key', 'accessKey', 'authorization', 'Authorization']);

export const STRING_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /[Aa]uthorization\s*:\s*.+/g,
  /[Bb]earer\s+[A-Za-z0-9._\-+/=]+/g,
  /\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}/g,
  /\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b/g,
  /(?<=:\/\/[^/\s:@]{1,128}:)[^/\s@]+(?=@)/g,
  /[^\s"]*\.env(?:\.[A-Za-z0-9._\-]+)?\b/g,
  /[^\s"]*\bid_(?:rsa|ed25519|ecdsa|dsa)\b[^\s"]*/g,
];

export const KEY_SUBSTRINGS = [/password/i, /passwd/i, /\bpwd\b/i, /secret/i, /token/i, /api[_-]?key/i,
  /authorization/i, /^bearer$/i, /private[_-]?key/i, /access[_-]?key/i];

// Patterns 10 and 11 by their word-based descriptions in REQ-RD-002 (linear time). The plain
// regexes above are quadratic on long words; `selfTestWordRules` checks the two agree.
const WORD = /[^\s"]+/g;
const ID_AT = /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/;
function rule10(s) {
  if (!s.includes('.env')) return s;
  // The last position in the word where ".env" starts and the pattern matches from there
  // (with its longest suffix that still ends at \b); replace from the word start to that end.
  const AT = /\.env(?:\.[A-Za-z0-9._\-]+)?\b/y;
  return s.replace(WORD, (w) => {
    for (let i = w.lastIndexOf('.env'); i >= 0; i = i > 0 ? w.lastIndexOf('.env', i - 1) : -1) {
      AT.lastIndex = i;
      const m = AT.exec(w);
      if (m) return R + w.slice(i + m[0].length);
    }
    return w;
  });
}
const rule11 = (s) => (s.includes('id_') ? s.replace(WORD, (w) => (ID_AT.test(w) ? R : w)) : s);
const FAST = STRING_PATTERNS.map((re, i) => (i === 9 ? rule10 : i === 10 ? rule11 : (s) => s.replace(re, R)));

export function selfTestWordRules(n = 3000) {
  const alphabet = ['.env', '.', 'env', 'x', '/', ' ', '"', 'id_', 'rsa', 'dsa', '-', '_', 'a', '9', '+', '.local', 'é'];
  let seed = 12345;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let t = 0; t < n; t++) {
    let s = '';
    for (let k = rnd(12); k > 0; k--) s += alphabet[rnd(alphabet.length)];
    for (const [i, f] of [[9, rule10], [10, rule11]]) {
      const want = s.replace(STRING_PATTERNS[i], R);
      if (f(s) !== want) throw new Error(`oracle word rule for pattern ${i + 1} disagrees with the regex on ${JSON.stringify(s)}: ${JSON.stringify(f(s))} vs ${JSON.stringify(want)}`);
    }
  }
  return n;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const replaceAll = (s, res) => res.reduce((acc, re) => (typeof re === 'function' ? re(acc) : acc.replace(re, R)), s);
const mapStrings = (v, f) =>
  typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, f))
    : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) : v;

function step1(v) {
  if (Array.isArray(v)) return v.map(step1);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, EXACT_KEYS.has(k) ? R : step1(x)]));
  return v;
}
function step3(v) {
  if (Array.isArray(v)) return v.map(step3);
  if (isObj(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, KEY_SUBSTRINGS.some((re) => re.test(k)) ? (typeof x === 'string' || (x !== null && typeof x === 'object') ? R : x) : step3(x)]));
  }
  return v;
}
const userRes = (user) => user.map((p) => new RegExp(p, 'g'));

/** Redact a message value (REQ-RD-001..004). */
export function redact(value, { defaults = true, user = [] } = {}) {
  let v = value;
  if (defaults) {
    v = step1(v);
    v = mapStrings(v, (s) => replaceAll(s, FAST));
    v = step3(v);
    v = mapStrings(v, (s) => replaceAll(s, STRING_PATTERNS.slice(0, 4)));
  }
  return mapStrings(v, (s) => replaceAll(s, userRes(user)));
}

/** Redact one command-line argument (REQ-RD-005). */
export function redactArg(s, { defaults = true, user = [] } = {}) {
  let out = s;
  if (defaults) out = replaceAll(replaceAll(out, FAST), STRING_PATTERNS.slice(0, 4));
  return replaceAll(out, userRes(user));
}

const SKIP = new Set(['npx', '-y', '--yes', 'node', 'bun', 'deno', 'run', '--']);
/** REQ-LB-001, given already-redacted arguments. */
export function deriveLabel(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a.startsWith('-') || SKIP.has(a) || /\s/.test(a)) continue;
    const last = a.split(/[\\/]/).pop();
    const cleaned = last.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase().slice(0, 32);
    if (cleaned) return cleaned;
  }
  return 'mcp';
}

/** REQ-TR-001 file-name part. */
export const fileName = (label) => label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'mcp';
