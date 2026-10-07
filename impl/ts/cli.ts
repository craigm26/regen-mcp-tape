export interface Opts {
  out: string;
  label?: string;
  redact: string[];
  defaults: boolean;
  help: boolean;
  version: boolean;
  error?: string;
  command: string[];
}

export function parseArgs(argv: string[]): Opts {
  const o: Opts = { out: './mcp-traces', redact: [], defaults: true, help: false, version: false, command: [] };
  const fail = (m: string) => { o.error ??= m; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { o.command = argv.slice(i + 1); break; }
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a === '--no-redact-defaults') o.defaults = false;
    else if (a === '--out' || a === '--label' || a === '--redact') {
      if (i + 1 >= argv.length) { fail(`option ${a} needs a value`); break; }
      const v = argv[++i]!;
      if (a === '--out') o.out = v;
      else if (a === '--label') o.label = v;
      else o.redact.push(v);
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else { o.command = argv.slice(i); break; }
  }
  if (!o.command.length) fail('no command given');
  return o;
}

const SKIP = new Set(['npx', '-y', '--yes', 'node', 'bun', 'deno', 'run', '--']);

// `command` must already be redacted.
export function deriveLabel(command: string[]): string {
  for (let i = command.length - 1; i >= 0; i--) {
    const a = command[i]!;
    if (a.startsWith('-') || SKIP.has(a) || /\s/.test(a)) continue;
    const base = a.slice(Math.max(a.lastIndexOf('/'), a.lastIndexOf('\\')) + 1);
    const l = base.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase().slice(0, 32);
    if (l) return l;
  }
  return 'mcp';
}
