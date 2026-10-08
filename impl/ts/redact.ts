const R = "[REDACTED]";
const EXACT = new Set(["api_key", "apiKey", "token", "bearer", "secret", "password", "passwd", "pwd",
  "private_key", "privateKey", "access_key", "accessKey", "authorization", "Authorization"]);
const KEYSUB = /password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer$|private[_-]?key|access[_-]?key/i;
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
const SSH = /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/;

const wc = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const cls = (c: number) => wc(c) || c === 46 || c === 45;

// End index of the match of pattern 10's tail at the last viable ".env" in a word, or -1.
function envEnd(w: string): number {
  let i = w.lastIndexOf(".env");
  if (i < 0) return -1;
  const n = w.length;
  const at = (k: number) => (k >= 0 && k < n ? w.charCodeAt(k) : -1);
  const bnd = (e: number) => wc(at(e - 1)) !== wc(at(e));
  const lb = new Int32Array(n + 1); // largest boundary position <= x, or -1
  for (let x = 0; x <= n; x++) lb[x] = bnd(x) ? x : x > 0 ? lb[x - 1] : -1;
  const re = new Int32Array(n + 2); // end of the class run starting at k
  re[n] = n;
  for (let k = n - 1; k >= 0; k--) re[k] = cls(at(k)) ? re[k + 1] : k;
  for (;;) {
    const j = i + 4;
    if (j < n && at(j) === 46) {
      const e = lb[re[j + 1]];
      if (e >= j + 2) return e;
    }
    if (bnd(j)) return j;
    if (i === 0) return -1;
    i = w.lastIndexOf(".env", i - 1);
    if (i < 0) return -1;
  }
}

function paths(s: string): string {
  return s.replace(/[^\s"]+/g, (w) => {
    if (w.includes(".env")) {
      const e = envEnd(w);
      if (e >= 0) w = R + w.slice(e);
    }
    return w.includes("id_") && SSH.test(w) ? R : w;
  });
}

const sub = (s: string, ps: RegExp[]) => ps.reduce((a, p) => a.replace(p, R), s);

function walk(v: unknown, onKey: (k: string, x: unknown) => unknown, onStr: ((s: string) => string) | null): unknown {
  if (typeof v === "string") return onStr ? onStr(v) : v;
  if (Array.isArray(v)) return v.map((x) => walk(x, onKey, onStr));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const r = onKey(k, x);
      return [k, r !== undefined ? r : walk(x, onKey, onStr)];
    }));
  }
  return v;
}

export function makeRedactor(defaults: boolean, user: RegExp[]) {
  const s4 = (s: string) => sub(defaults ? sub(s, P1_4) : s, user);
  const none = () => undefined;
  const step2 = (s: string) => paths(sub(s, [...P1_4, ...P5_9]));
  const str = (s: string) => s4(defaults ? step2(s) : s);
  const msg = (v: unknown): unknown => {
    if (defaults) {
      v = walk(v, (k) => (EXACT.has(k) ? R : undefined), null);
      v = walk(v, none, step2);
      v = walk(v, (k, x) => (KEYSUB.test(k) && x !== null && typeof x !== "number" && typeof x !== "boolean" ? R : undefined), null);
    }
    return walk(v, none, s4);
  };
  return { str, msg };
}
