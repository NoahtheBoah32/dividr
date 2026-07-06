import { execSync } from 'child_process';

const PORT = 5173;

try {
  const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  const pids = new Set(
    out.split('\n')
      .map(line => line.trim().split(/\s+/).pop())
      .filter(pid => pid && pid !== '0' && /^\d+$/.test(pid))
  );
  for (const pid of pids) {
    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
  }
  if (pids.size) console.log(`[prestart] Cleared port ${PORT} (PIDs: ${[...pids].join(', ')})`);
} catch {
  // port was already free
}
