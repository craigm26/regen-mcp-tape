// Fake MCP server used by the tests. Mode is argv[2].
const [mode, arg] = process.argv.slice(2);
if (mode === 'echo') {
  process.stdin.pipe(process.stdout);
  process.stdin.on('end', () => { process.exitCode = Number(arg || 0); });
} else if (mode === 'exit') {
  process.stdout.write('bye\n');
  process.stderr.write('err\n');
  setTimeout(() => process.exit(Number(arg || 0)), 100);
} else if (mode === 'sig') {
  process.kill(process.pid, arg);
  setTimeout(() => {}, 5000);
} else if (mode === 'term') {
  process.on('SIGTERM', () => process.exit(0));
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
} else if (mode === 'info') {
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env.TAPE_T, args: process.argv.slice(3) }) + '\n');
}
