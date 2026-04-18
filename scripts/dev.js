const { spawn } = require('child_process');

const procs = [];
let shuttingDown = false;

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true,
    env: process.env
  });

  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  p.stdout.on('data', (d) => process.stdout.write(`${prefix} ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`${prefix} ${d}`));

  p.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const x of procs) {
      try { x.kill('SIGTERM'); } catch (_) {}
    }
    process.exit(code ?? 0);
  });

  procs.push(p);
}

run('api', 'npm', ['run', 'dev:api'], '32');
run('web', 'npm', ['run', 'dev:web'], '34');

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
