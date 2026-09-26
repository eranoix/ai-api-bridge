/**
 * Internal SFTP upload helper.
 *   SSH_HOST=... SSH_KEY=... npx tsx scripts/_ssh-upload.ts <local> <remote>
 */
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

const HOST = process.env.SSH_HOST;
const USER = process.env.SSH_USER ?? 'root';
const PORT = Number(process.env.SSH_PORT ?? '22');
const KEY_PATH = process.env.SSH_KEY;
const PASS = process.env.SSH_PASS;

if (!HOST || (!KEY_PATH && !PASS)) {
  console.error('SSH_HOST + (SSH_KEY or SSH_PASS) required');
  process.exit(2);
}
const [local, remote] = process.argv.slice(2);
if (!local || !remote) {
  console.error('usage: _ssh-upload.ts <local> <remote>');
  process.exit(2);
}

const client = new Client();
client.on('ready', () => {
  client.sftp((err, sftp) => {
    if (err) {
      console.error('sftp error:', err.message);
      process.exit(3);
    }
    import('node:fs').then(({ createReadStream, statSync }) => {
      const size = statSync(local).size;
      const rs = createReadStream(local);
      const ws = sftp.createWriteStream(remote);
      let written = 0;
      rs.on('data', (chunk: Buffer | string) => {
        written += chunk.length;
      });
      ws.on('close', () => {
        console.log(`uploaded ${local} (${size} bytes) -> ${HOST}:${remote}`);
        client.end();
        process.exit(0);
      });
      ws.on('error', (e: Error) => {
        console.error('upload failed:', e.message);
        process.exit(4);
      });
      rs.on('error', (e) => {
        console.error('local read error:', e.message);
        process.exit(6);
      });
      rs.pipe(ws);
      void written;
    });
  });
});
client.on('error', (e) => {
  console.error('connection error:', e.message);
  process.exit(5);
});

const connectOpts: Parameters<Client['connect']>[0] = {
  host: HOST,
  port: PORT,
  username: USER,
  tryKeyboard: true,
  readyTimeout: 30_000,
};
if (KEY_PATH) connectOpts.privateKey = readFileSync(KEY_PATH);
if (PASS) connectOpts.password = PASS;
client.connect(connectOpts);
