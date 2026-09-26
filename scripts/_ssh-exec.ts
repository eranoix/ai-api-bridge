/**
 * Internal SSH helper for deploy scripts: npx tsx scripts/_ssh-exec.ts "<command>"
 * Env: SSH_HOST and SSH_PASS required; SSH_USER (default root), SSH_PORT (default 22).
 * Streams output live and exits with the remote command's exit code.
 */
import { Client } from 'ssh2';

import { readFileSync } from 'node:fs';

const HOST = process.env.SSH_HOST;
const USER = process.env.SSH_USER ?? 'root';
const PORT = Number(process.env.SSH_PORT ?? '22');
const PASS = process.env.SSH_PASS;
const KEY_PATH = process.env.SSH_KEY;

if (!HOST) {
  console.error('SSH_HOST is required');
  process.exit(2);
}
if (!PASS && !KEY_PATH) {
  console.error('SSH_PASS or SSH_KEY is required');
  process.exit(2);
}

const cmd = process.argv.slice(2).join(' ');
if (!cmd) {
  console.error('usage: tsx scripts/_ssh-exec.ts "<remote command>"');
  process.exit(2);
}

const client = new Client();
client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
  finish([PASS]);
});
client.on('ready', () => {
  client.exec(cmd, { pty: false }, (err, stream) => {
    if (err) {
      console.error('ssh exec error:', err.message);
      process.exit(3);
    }
    stream.on('close', (code: number) => {
      client.end();
      process.exit(code ?? 0);
    });
    stream.on('data', (b: Buffer) => process.stdout.write(b));
    stream.stderr.on('data', (b: Buffer) => process.stderr.write(b));
  });
});
client.on('error', (e) => {
  console.error('ssh connection error:', e.message);
  process.exit(4);
});
const connectOpts: Parameters<Client['connect']>[0] = {
  host: HOST,
  port: PORT,
  username: USER,
  tryKeyboard: true,
  readyTimeout: 20_000,
  keepaliveInterval: 5_000,
};
if (KEY_PATH) connectOpts.privateKey = readFileSync(KEY_PATH);
if (PASS) connectOpts.password = PASS;
client.connect(connectOpts);
