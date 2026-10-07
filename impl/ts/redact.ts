const R = '[REDACTED]';
const EXACT = new Set(['api_key', 'apiKey', 'token', 'bearer', 'secret', 'password', 'passwd', 'pwd',
  'private_key', 'privateKey', 'access_key', 'accessKey', 'authorization', 'Authorization']);
const KEYRE = /password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer$|private[_-]?key|access[_-]?key/i;
// patterns 1-4 (run twice: step 2 and step 4), then 5-9
const P14 = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];
const P59 = [
  /[Aa]uthorization\s*:\s*.+/g,
  /[Bb]earer\s+[A-Za-z0-9._\-+/=]+/g,
  /\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}/g,
  /\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b/g,
  /(?<=:\/\/[^/\s:@]{1,128}:)[^/\s@]+(?=@)/g,
];
const WORD = /[^\s"]+/g;
const SSH = /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/;
const isW = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isBoundary = (w: string, j: number) => isW(w[j - 1]) !== isW(w[j]);

// End of the match of \.env(?:\.[A-Za-z0-9._\-]+)?\b starting at i, or -1.
function envEnd(w: string, i: number): number {
  const s = i + 4;
  if (w[s] === '.') {
    let e = s + 1;
    while (e < w.length && /[A-Za-z0-9._-]/.test(w[e]!)) e++;
    for (let j = e; j > s + 1; j--) if (isBoundary(w, j)) return j;
  }
  return isBoundary(w, s) ? s : -1;
}

// Pattern 10 on one word: replace from the word start to the end of the last match.
function envWord(w: string): string {
  for (let i = w.lastIndexOf('.env'); i >= 0; i = i ? w.lastIndexOf('.env', i - 1) : -1) {
    const e = envEnd(w, i);
    if (e >= 0) return R + w.slice(e);
  }
  return w;
}

function stage2(s: string): string {
  for (const p of P14) s = s.replace(p, R);
  for (const p of P59) s = s.replace(p, R);
  s = s.replace(WORD, envWord);
  return s.replace(WORD, (w) => (SSH.test(w) ? R : w));
}

type J = unknown;
function walk(v: J, str: (s: string) => string, key?: (k: string, x: J) => boolean): J {
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, str, key));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, key?.(k, x) ? R : walk(x, str, key)]));
  }
  return v;
}

const keyRule = (k: string, x: J) =>
  EXACT.has(k) || (KEYRE.test(k) && (typeof x === 'string' || (x !== null && typeof x === 'object')));

export function makeRedactor(defaults: boolean, user: RegExp[]) {
  const s2 = (s: string) => (defaults ? stage2(s) : s);
  const s4 = (s: string) => {
    if (defaults) for (const p of P14) s = s.replace(p, R);
    for (const u of user) s = s.replace(u, R);
    return s;
  };
  return {
    str: (s: string) => s4(s2(s)),
    // steps 1-3 in one walk (they commute), then step 4
    msg: (v: J) => walk(walk(v, s2, defaults ? keyRule : undefined), s4),
  };
}
