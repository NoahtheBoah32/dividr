import { ChildProcess, spawn } from 'child_process';
import http from 'http';

let viteServer: ChildProcess | null = null;

function waitForPort(port: number, retries = 40, interval = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(`http://localhost:${port}`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++attempts >= retries) {
          reject(new Error(`Port ${port} never became available`));
        } else {
          setTimeout(check, interval);
        }
      });
      req.setTimeout(300, () => {
        req.destroy();
        if (++attempts >= retries) {
          reject(new Error(`Port ${port} never became available`));
        } else {
          setTimeout(check, interval);
        }
      });
    };
    check();
  });
}

export default async function globalSetup() {
  viteServer = spawn(
    'npx',
    ['vite', '--config', 'vite.renderer.config.ts', '--port', '5173', '--strictPort'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
      shell: true,
    },
  );

  viteServer.stdout?.on('data', (d: Buffer) =>
    process.stdout.write(`[vite] ${d}`),
  );
  viteServer.stderr?.on('data', (d: Buffer) =>
    process.stderr.write(`[vite] ${d}`),
  );

  // Poll HTTP instead of parsing stdout (output format varies by Vite version)
  await waitForPort(5173);

  (global as Record<string, unknown>).__vite_server__ = viteServer;
}
