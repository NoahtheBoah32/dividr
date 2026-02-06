/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Startup Manager
 *
 * Manages app startup state, performance tracking, and initialization stages.
 * Provides utilities for monitoring and optimizing the boot sequence.
 */

export type StartupStage =
  | 'app-start'
  | 'renderer-mount'
  | 'editor-init'
  | 'editor-ready'
  | 'indexeddb-init'
  | 'indexeddb-ready'
  | 'projects-loading'
  | 'projects-loaded'
  | 'app-ready';

interface StartupMetric {
  stage: StartupStage;
  timestamp: number;
  duration?: number;
}

class StartupManager {
  private metrics: StartupMetric[] = [];
  private startTime: number = Date.now();
  private listeners: Set<(stage: StartupStage, progress: number) => void> =
    new Set();
  private lastLoggedAt: number = this.startTime;

  private isDev(): boolean {
    try {
      return (import.meta as any)?.env?.DEV === true;
    } catch {
      return false;
    }
  }

  constructor() {
    // Mark app start
    this.logStage('app-start');

    // Log to console for debugging
    if (typeof window !== 'undefined') {
      (window as any).__DIVIDR_STARTUP__ = this;
    }
  }

  /**
   * Log a startup stage with timestamp
   */
  logStage(stage: StartupStage): void {
    const timestamp = Date.now();
    const duration = timestamp - this.startTime;
    const delta = timestamp - this.lastLoggedAt;

    this.metrics.push({ stage, timestamp, duration });
    this.lastLoggedAt = timestamp;

    // Notify listeners
    const progress = this.calculateProgress(stage);
    this.listeners.forEach((listener) => listener(stage, progress));

    if (typeof window !== 'undefined') {
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.invoke) {
        void electronAPI
          .invoke('startup:mark', stage, {
            duration,
            delta,
          })
          .catch((error: unknown) => {
            if (this.isDev()) {
              console.warn('⚠️ Startup mark failed:', error);
            }
          });
      }
    }

    if (this.isDev()) {
      const formatted = `[startup] ${stage} +${delta}ms (${duration}ms)`;
      if (stage === 'app-ready' && duration > 5000) {
        console.warn(`${formatted} ⚠️ exceeded 5s startup budget`);
      } else {
        console.log(formatted);
      }
    }
  }

  /**
   * Calculate progress percentage based on stage
   */
  private calculateProgress(stage: StartupStage): number {
    const stageProgress: Record<StartupStage, number> = {
      'app-start': 0,
      'renderer-mount': 20,
      'editor-init': 45,
      'editor-ready': 55,
      'indexeddb-init': 40,
      'indexeddb-ready': 60,
      'projects-loading': 75,
      'projects-loaded': 90,
      'app-ready': 100,
    };

    return stageProgress[stage] || 0;
  }

  /**
   * Subscribe to startup progress updates
   */
  subscribe(
    callback: (stage: StartupStage, progress: number) => void,
  ): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Get all metrics
   */
  getMetrics(): StartupMetric[] {
    return [...this.metrics];
  }

  /**
   * Get total startup time
   */
  getTotalStartupTime(): number {
    const lastMetric = this.metrics[this.metrics.length - 1];
    return lastMetric ? lastMetric.duration || 0 : 0;
  }

  /**
   * Print performance summary (console logging removed for production cleanliness)
   */
  printSummary(): void {
    if (!this.isDev()) return;

    const entries = this.metrics.map((metric) => ({
      stage: metric.stage,
      ms: metric.duration ?? 0,
    }));

    console.log('[startup] summary', entries);
  }

  /**
   * Identify stages that took longer than expected
   */
  private identifyBottlenecks(): StartupMetric[] {
    const thresholds: Partial<Record<StartupStage, number>> = {
      'indexeddb-init': 500,
      'projects-loading': 1000,
    };

    return this.metrics.filter((metric) => {
      const threshold = thresholds[metric.stage];
      return threshold && metric.duration && metric.duration > threshold;
    });
  }

  /**
   * Reset metrics (for testing)
   */
  reset(): void {
    this.metrics = [];
    this.startTime = Date.now();
    this.logStage('app-start');
  }
}

// Singleton instance
export const startupManager = new StartupManager();

/**
 * Hook to track startup progress in React components
 */
export const useStartupProgress = (
  callback: (stage: StartupStage, progress: number) => void,
): void => {
  if (typeof window === 'undefined') return;

  const unsubscribe = startupManager.subscribe(callback);

  // Cleanup on unmount
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', unsubscribe);
  }
};
