// Redaction of the trace copy of messages (SPEC § 6). Never used on forwarded bytes.
export const R = '[REDACTED]';

export interface RedactConfig {
  defaults: boolean;
  extra: RegExp[];
}

const EXACT = new Set(['api_key', 'apiKey', 'token', 'bearer', 'secret', 'password', 'passwd', 'pwd',
  'private_key', 'privateKey', 'access_key', 'accessKey', 'authorization', 'Authorization']);
const KEY_RE = /password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer$|private[_-]?key|access[_-]?key/i;

const P1_4 = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];
const P5_9 = [
  /[Aa]uthorization\s*:\s*.+/g,
  /[Bb]earer\s+[A-Za-z0-9._\-+/=]+/g,
  /\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}/g,
  /\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b/g,
  /(?<=:\/\/[^/\s:@]{1,128}:)[^/\s@]+(?=@)/g,
];
const WORD = /[^\s"]+/g;
const ENV = /\.env(?:\.[A-Za-z0-9._\-]+)?\b/y;
const SSH = /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/;

// Pattern 10, word-based and linear: replace up to the end of the last `.env` match in the word.
function envWord(w: string): string {
  for (let i = w.lastIndexOf('.env'); i >= 0; i = i === 0 ? -1 : w.lastIndexOf('.env', i - 1)) {
    ENV.lastIndex = i;
    const m = ENV.exec(w);
    if (m) return R + w.slice(i + m[0].length);
  }
  return w;
}

function step2(s: string): string {
  for (const p of P1_4) s = s.replace(p, R);
  for (const p of P5_9) s = s.replace(p, R);
  s = s.replace(WORD, envWord);
  return s.replace(WORD, (w) => (SSH.test(w) ? R : w));
}

function step4(s: string, c: RedactConfig): string {
  if (c.defaults) for (const p of P1_4) s = s.replace(p, R);
  for (const p of c.extra) s = s.replace(p, R);
  return s;
}

// Active string rules (steps 2 and 4), used for meta.command and the derived label.
export function redactString(s: string, c: RedactConfig): string {
  return step4(c.defaults ? step2(s) : s, c);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function walk(v: unknown, str: (s: string) => string, member: (k: string, v: unknown) => unknown): unknown {
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, str, member));
  if (isObj(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const r = member(k, x);
      return [k, r !== undefined ? r : walk(x, str, member)];
    }));
  }
  return v;
}

export function redactTree(v: unknown, c: RedactConfig): unknown {
  const id = (s: string) => s;
  if (c.defaults) {
    v = walk(v, id, (k) => (EXACT.has(k) ? R : undefined));
    v = walk(v, step2, () => undefined);
    v = walk(v, id, (k, x) => (KEY_RE.test(k) && (typeof x === 'string' || typeof x === 'object' && x !== null) ? R
      : KEY_RE.test(k) ? x : undefined));
  }
  return walk(v, (s) => step4(s, c), () => undefined);
}
