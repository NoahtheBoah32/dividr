import { describe, it, expect } from 'vitest';
import { applyDeletion, type EditWord } from './transcriptCaretEdit';

const M = (): EditWord[] => [
  { id: 'a', chars: 'the' },
  { id: 'b', chars: 'nagging' },
  { id: 'c', chars: 'dog' },
];
const caret = (wordId: string, offset: number) => ({ anchor: { wordId, offset }, focus: { wordId, offset } });

describe('transcriptCaretEdit.applyDeletion', () => {
  it('backspace mid-word shrinks the word without emptying or rippling', () => {
    // "nagging" caret after 'g' (offset 7) -> remove last char -> "naggin"
    const r = applyDeletion(M(), caret('b', 7), 'deleteContentBackward');
    expect(r.model.find((w) => w.id === 'b')!.chars).toBe('naggin');
    expect(r.emptied).toEqual([]);
    expect(r.changed).toEqual(['b']);
    expect(r.caret).toEqual({ wordId: 'b', offset: 6 });
  });

  it('backspacing the whole word only ripples on the LAST character', () => {
    let model = M();
    // delete "nagging" down to "nag" — three backspaces from offset 7,6,5,4 (g,n,i,g)
    let sel = caret('b', 7);
    for (let i = 0; i < 4; i++) {
      const r = applyDeletion(model, sel, 'deleteContentBackward');
      model = r.model;
      expect(r.emptied).toEqual([]); // still partial, nothing rippled
      sel = caret('b', r.caret!.offset);
    }
    expect(model.find((w) => w.id === 'b')!.chars).toBe('nag');
    // now delete the remaining "nag": g, a, n — the last one empties the word
    const seq = ['nag'];
    void seq;
    let lastEmptied: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = applyDeletion(model, sel, 'deleteContentBackward');
      model = r.model;
      lastEmptied = r.emptied;
      if (r.caret) sel = caret(r.caret.wordId, r.caret.offset);
    }
    expect(lastEmptied).toEqual(['b']); // only the final char emptied -> ripple
    expect(model.map((w) => w.id)).toEqual(['a', 'c']); // "nagging" gone from the model
  });

  it('backspace at word start deletes the previous word last char', () => {
    // caret at start of "dog" (c,0) -> deletes 'g' from "nagging"
    const r = applyDeletion(M(), caret('c', 0), 'deleteContentBackward');
    expect(r.model.find((w) => w.id === 'b')!.chars).toBe('naggin');
    expect(r.caret).toEqual({ wordId: 'b', offset: 6 });
    expect(r.emptied).toEqual([]);
  });

  it('delete-forward removes the char after the caret', () => {
    const r = applyDeletion(M(), caret('b', 0), 'deleteContentForward');
    expect(r.model.find((w) => w.id === 'b')!.chars).toBe('agging');
    expect(r.caret).toEqual({ wordId: 'b', offset: 0 });
  });

  it('word-granularity deletes are downgraded to a single character (never empty a neighbor)', () => {
    // Ctrl+Backspace at the END of "nagging" removes ONE char, not the whole word,
    // and never touches a neighbor.
    const back = applyDeletion(M(), caret('b', 7), 'deleteWordBackward');
    expect(back.emptied).toEqual([]);
    expect(back.model.find((w) => w.id === 'b')!.chars).toBe('naggin');
    expect(back.caret).toEqual({ wordId: 'b', offset: 6 });
    // Ctrl+Delete at the END of "the" removes the first char of "nagging" only,
    // NOT the whole "nagging" word.
    const fwd = applyDeletion(M(), caret('a', 3), 'deleteWordForward');
    expect(fwd.emptied).toEqual([]);
    expect(fwd.model.find((w) => w.id === 'b')!.chars).toBe('agging');
    // Ctrl+Backspace at the START of "dog" removes the previous word's last char only.
    const prev = applyDeletion(M(), caret('c', 0), 'deleteWordBackward');
    expect(prev.emptied).toEqual([]);
    expect(prev.model.find((w) => w.id === 'b')!.chars).toBe('naggin');
  });

  it('range selection across fully-covered words empties every one (multi-ripple)', () => {
    // select from start of "the" to end of "dog" -> everything
    const r = applyDeletion(M(), { anchor: { wordId: 'a', offset: 0 }, focus: { wordId: 'c', offset: 3 } }, 'deleteContentBackward');
    expect(r.emptied.sort()).toEqual(['a', 'b', 'c']);
    expect(r.model).toEqual([]);
    expect(r.caret).toBeNull();
  });

  it('range selection covering one full word + partial neighbor ripples only the full one', () => {
    // select "nagging" fully + first char of nothing: a(2)..b(7) -> trims "the"->"th", empties "nagging"
    const r = applyDeletion(M(), { anchor: { wordId: 'a', offset: 2 }, focus: { wordId: 'b', offset: 7 } }, 'deleteContentBackward');
    expect(r.model.find((w) => w.id === 'a')!.chars).toBe('th');
    expect(r.emptied).toEqual(['b']);
    expect(r.changed).toEqual(['a']);
    expect(r.model.map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('caret resolves to a surviving neighbor when its word is emptied', () => {
    // single-word model, backspace the only char -> caret null
    const r = applyDeletion([{ id: 'x', chars: 'a' }], caret('x', 1), 'deleteContentBackward');
    expect(r.emptied).toEqual(['x']);
    expect(r.caret).toBeNull();
  });
});
