// Runs the desktop shell from the repository (after `npm run build`). Editors built on Electron, such
// as VS Code, set ELECTRON_RUN_AS_NODE in their terminals, which would start Electron as plain Node;
// it is cleared here. Packaged builds ignore the variable altogether (runAsNode fuse off).
//
// Usage: npm run desktop:start
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
