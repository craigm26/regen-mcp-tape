// Reference adapter: runs the earlier implementation's built CLI in this same process, so the
// suite talks to it directly (no wrapper process between the pipes or in front of signals).
// local.json (gitignored): { "cli": "<absolute path to the built CLI entry>" }
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const local = JSON.parse(readFileSync(new URL('./local.json', import.meta.url), 'utf8'));
// The earlier implementation also reads a per-user redaction file and some environment
// variables, which are outside this spec. Point them at nothing so they cannot interfere.
for (const k of Object.keys(process.env)) if (/^MCP_TAPE_/i.test(k)) delete process.env[k];
process.env.XDG_CONFIG_HOME = join(tmpdir(), 'tape-reference-no-config');
process.argv = [process.argv[0], local.cli, ...process.argv.slice(2)];
await import(pathToFileURL(local.cli).href);
