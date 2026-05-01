import { ChildProcess } from 'child_process';

export default async function globalTeardown() {
  const viteServer = (global as Record<string, unknown>).__vite_server__ as ChildProcess | null;
  if (viteServer) {
    viteServer.kill();
  }
}
