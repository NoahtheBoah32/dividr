import { v4 as uuidv4 } from 'uuid';
import { Op, OpStatus, QueuedOp } from './types';

type OpEventType = 'opApplied' | 'opFailed' | 'queueDrained' | 'paused' | 'resumed';
type OpListener = (opId: string, op: Op) => void;
type SimpleListener = () => void;

class OperationEngine {
  private queue: QueuedOp[] = [];
  private paused = false;
  private processing = false;

  private listeners: Map<OpEventType, Set<Function>> = new Map([
    ['opApplied', new Set()],
    ['opFailed', new Set()],
    ['queueDrained', new Set()],
    ['paused', new Set()],
    ['resumed', new Set()],
  ]);

  // Apply function injected by storeAdapter — mutates Dividr state
  private applyFn: ((op: Op) => Promise<void>) | null = null;

  setApplyFn(fn: (op: Op) => Promise<void>) {
    this.applyFn = fn;
  }

  on(event: OpEventType, listener: Function) {
    this.listeners.get(event)?.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  private emit(event: OpEventType, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  enqueue(op: Op): string {
    const id = uuidv4();
    this.queue.push({ id, op, status: 'pending' });
    this.processNext();
    return id;
  }

  enqueueMany(ops: Op[]): string[] {
    return ops.map((op) => this.enqueue(op));
  }

  pause() {
    this.paused = true;
    this.emit('paused');
  }

  resume() {
    this.paused = false;
    this.emit('resumed');
    this.processNext();
  }

  clearQueue() {
    this.queue = this.queue.filter((q) => q.status === 'running');
  }

  cancelByStepId(stepId: string) {
    this.queue = this.queue.map((q) =>
      (q.op as any).stepId === stepId && q.status === 'pending'
        ? { ...q, status: 'undone' as const }
        : q,
    );
  }

  undo(opId: string) {
    const entry = this.queue.find((q) => q.id === opId);
    if (entry) {
      entry.status = 'undone';
    }
  }

  getQueue(): QueuedOp[] {
    return [...this.queue];
  }

  getStatus(opId: string): OpStatus | null {
    return this.queue.find((q) => q.id === opId)?.status ?? null;
  }

  // Ops that are already slow (async work) — no artificial delay needed
  private static readonly INSTANT_OPS = new Set([
    'cutSilence', 'runWhisper', 'analyzeReference', 'downloadMedia', 'geminiEdit',
  ]);

  private async processNext() {
    if (this.paused || this.processing) return;
    const next = this.queue.find((q) => q.status === 'pending');
    if (!next) {
      this.emit('queueDrained');
      return;
    }

    if (!this.applyFn) {
      console.warn('[OperationEngine] No applyFn set — cannot apply ops');
      return;
    }

    this.processing = true;
    next.status = 'running';

    try {
      await this.applyFn(next.op);
      next.status = 'applied';
      next.appliedAt = Date.now();
      this.emit('opApplied', next.id, next.op);
    } catch (err) {
      next.status = 'failed';
      next.error = String(err);
      this.emit('opFailed', next.id, next.op);
    } finally {
      this.processing = false;
      // Deliberate pause between ops so edits are visible one by one
      const isInstant = OperationEngine.INSTANT_OPS.has((next.op as any).type);
      if (!isInstant) {
        await new Promise((r) => setTimeout(r, 480));
      }
      this.processNext();
    }
  }
}

export const operationEngine = new OperationEngine();
