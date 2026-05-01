// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';

// Mock localStorage for persist middleware
const store: Record<string, string> = {};
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  },
  writable: true,
});

import { useCaptionStylesStore } from './captionStylesStore';

describe('captionStylesStore', () => {
  beforeEach(() => {
    // Reset to initial state before each test
    useCaptionStylesStore.setState({
      styles: [
        { id: 'mycelium', name: 'Mycelium', fontFamily: 'Inter', fontSize: 52, fillColor: '#FFFFFF', highlightColor: '#FFD700', isBold: true, isUppercase: true, position: 0.65 },
        { id: 'hormozi', name: 'Hormozi', fontFamily: 'Inter', fontSize: 56, fillColor: '#FFFFFF', highlightColor: '#FFFF00', isBold: true, isUppercase: true, position: 0.7 },
      ],
      activeStyleId: 'mycelium',
    });
  });

  it('ships with Mycelium and Hormozi styles pre-seeded', () => {
    const { styles } = useCaptionStylesStore.getState();
    expect(styles.find(s => s.name === 'Mycelium')).toBeTruthy();
    expect(styles.find(s => s.name === 'Hormozi')).toBeTruthy();
  });

  it('saves a new named style', () => {
    useCaptionStylesStore.getState().saveStyle('Esteban', {
      fontFamily: 'Bebas Neue',
      fontSize: 58,
      fillColor: '#FFFFFF',
      highlightColor: '#00FF88',
    });
    const { styles } = useCaptionStylesStore.getState();
    const esteban = styles.find(s => s.name === 'Esteban');
    expect(esteban).toBeTruthy();
    expect(esteban?.fontFamily).toBe('Bebas Neue');
    expect(esteban?.highlightColor).toBe('#00FF88');
  });

  it('upserts (updates existing) when saving same name again', () => {
    useCaptionStylesStore.getState().saveStyle('Esteban', { fontSize: 48 });
    useCaptionStylesStore.getState().saveStyle('Esteban', { fontSize: 64 });
    const { styles } = useCaptionStylesStore.getState();
    const estebans = styles.filter(s => s.name === 'Esteban');
    expect(estebans).toHaveLength(1);
    expect(estebans[0].fontSize).toBe(64);
  });

  it('upsert is case-insensitive on name', () => {
    useCaptionStylesStore.getState().saveStyle('esteban', { fontSize: 48 });
    useCaptionStylesStore.getState().saveStyle('ESTEBAN', { fontSize: 60 });
    const { styles } = useCaptionStylesStore.getState();
    const estebans = styles.filter(s => s.name.toLowerCase() === 'esteban');
    expect(estebans).toHaveLength(1);
    expect(estebans[0].fontSize).toBe(60);
  });

  it('deletes a style by id', () => {
    useCaptionStylesStore.getState().saveStyle('ToDelete', { fontSize: 40 });
    const before = useCaptionStylesStore.getState().styles;
    const target = before.find(s => s.name === 'ToDelete')!;
    useCaptionStylesStore.getState().deleteStyle(target.id);
    const after = useCaptionStylesStore.getState().styles;
    expect(after.find(s => s.name === 'ToDelete')).toBeUndefined();
  });

  it('resets activeStyleId to mycelium when active style is deleted', () => {
    useCaptionStylesStore.getState().saveStyle('Temp', { fontSize: 40 });
    const { styles } = useCaptionStylesStore.getState();
    const temp = styles.find(s => s.name === 'Temp')!;
    useCaptionStylesStore.getState().setActiveStyle(temp.id);
    useCaptionStylesStore.getState().deleteStyle(temp.id);
    expect(useCaptionStylesStore.getState().activeStyleId).toBe('mycelium');
  });

  it('setActiveStyle changes the active style', () => {
    useCaptionStylesStore.getState().setActiveStyle('hormozi');
    expect(useCaptionStylesStore.getState().activeStyleId).toBe('hormozi');
  });

  it('saveStyle fills missing fields from defaults', () => {
    useCaptionStylesStore.getState().saveStyle('Sparse', { fontSize: 44 });
    const { styles } = useCaptionStylesStore.getState();
    const sparse = styles.find(s => s.name === 'Sparse')!;
    // Should fall back to Mycelium defaults for unspecified fields
    expect(sparse.fontFamily).toBe('Inter');
    expect(sparse.fillColor).toBe('#FFFFFF');
  });
});
