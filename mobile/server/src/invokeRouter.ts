/**
 * POST /api/invoke — server-side equivalent of ipcMain.handle dispatch.
 *
 * Body: { channel: string, args: unknown[] }
 * Looks up the channel in the handler registry, runs it with an `emit` bound to
 * the WS hub, and returns the handler's result as JSON.
 */
import type { Request, Response } from 'express';
import { emit } from './events';
import { getHandler } from './handlers/index';

export async function invokeRoute(req: Request, res: Response): Promise<void> {
  const { channel, args } = (req.body ?? {}) as { channel?: string; args?: unknown[] };

  if (!channel) {
    res.status(400).json({ error: 'Missing "channel"' });
    return;
  }

  const handler = getHandler(channel);
  if (!handler) {
    res.status(404).json({ error: `No handler for channel "${channel}"` });
    return;
  }

  try {
    const result = await handler(args ?? [], { emit });
    res.json(result ?? null);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
