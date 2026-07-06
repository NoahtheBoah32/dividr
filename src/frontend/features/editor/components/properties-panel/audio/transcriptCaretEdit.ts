/**
 * transcriptCaretEdit — pure, DOM-free deletion + caret math for the editable
 * transcript box.
 *
 * The transcript renders as a controlled contenteditable. The component maps the
 * browser Selection to an EditSelection over this word model, hands it here, and
 * applies the returned model + caret back to the DOM. Keeping the logic pure
 * makes the fiddly parts (cross-word backspace, range delete, which word just
 * emptied) unit-testable without a browser.
 *
 * Rules that mirror the product spec:
 * - Insertions never reach here (the component blocks them). This only deletes.
 * - A word only "empties" when its last visible character is removed. Emptied
 *   words are reported so the component can ripple their video segment out.
 * - Partial words (still have characters) are kept; only their text shrinks.
 */

export interface EditWord {
  id: string;
  /** Current visible characters of the word (always non-empty in the input model). */
  chars: string;
}

export interface EditCaret {
  wordId: string;
  /** Character offset within that word's chars, 0..chars.length. */
  offset: number;
}

export interface EditSelection {
  anchor: EditCaret;
  focus: EditCaret;
}

export interface DeletionResult {
  /** New ordered editable-word model (emptied words removed). */
  model: EditWord[];
  /** Where to put the caret after applying, or null if nothing left. */
  caret: EditCaret | null;
  /** Ids of words fully emptied by this operation (ripple their segments). */
  emptied: string[];
  /** Ids of words whose visible text changed but are NOT emptied (store partial). */
  changed: string[];
}

const indexOfId = (model: EditWord[], id: string): number =>
  model.findIndex((w) => w.id === id);

/** Linear order comparison of two carets within the model. */
function cmp(model: EditWord[], a: EditCaret, b: EditCaret): number {
  const ai = indexOfId(model, a.wordId);
  const bi = indexOfId(model, b.wordId);
  if (ai !== bi) return ai - bi;
  return a.offset - b.offset;
}

/** Build the result after the model words have had their chars mutated in place. */
function finalize(
  before: EditWord[],
  working: EditWord[],
  caretWordId: string | null,
  caretOffset: number,
  touched: Set<string>,
): DeletionResult {
  const emptied: string[] = [];
  const survivors: EditWord[] = [];
  for (const w of working) {
    if (w.chars.length === 0) emptied.push(w.id);
    else survivors.push(w);
  }
  const changed = [...touched].filter((id) => !emptied.includes(id));

  // Resolve the caret onto a surviving word.
  let caret: EditCaret | null = null;
  if (survivors.length > 0) {
    if (caretWordId && survivors.some((w) => w.id === caretWordId)) {
      const w = survivors.find((x) => x.id === caretWordId)!;
      caret = { wordId: caretWordId, offset: Math.min(caretOffset, w.chars.length) };
    } else {
      // Caret's word was emptied — fall to the nearest surviving boundary using
      // the ORIGINAL ordering so "where it was" is meaningful.
      const origIdx = caretWordId ? indexOfId(before, caretWordId) : -1;
      let target: EditWord | null = null;
      let atStart = true;
      // Prefer the next surviving word (caret sits at its start).
      for (let i = origIdx + 1; i < before.length; i++) {
        const s = survivors.find((w) => w.id === before[i].id);
        if (s) { target = s; atStart = true; break; }
      }
      if (!target) {
        // else the previous surviving word (caret at its end).
        for (let i = origIdx - 1; i >= 0; i--) {
          const s = survivors.find((w) => w.id === before[i].id);
          if (s) { target = s; atStart = false; break; }
        }
      }
      if (target) caret = { wordId: target.id, offset: atStart ? 0 : target.chars.length };
    }
  }

  return { model: survivors, caret, emptied, changed };
}

/**
 * Apply a delete operation to the word model. `inputType` is the contenteditable
 * beforeinput inputType (deleteContentBackward / deleteContentForward /
 * deleteWordBackward / deleteWordForward / deleteByCut / deleteByDrag / ...).
 * A non-collapsed selection always deletes the selected range regardless of type.
 */
export function applyDeletion(
  model: EditWord[],
  sel: EditSelection,
  inputType: string,
): DeletionResult {
  const working = model.map((w) => ({ ...w }));
  const touched = new Set<string>();

  const collapsed =
    sel.anchor.wordId === sel.focus.wordId &&
    sel.anchor.offset === sel.focus.offset;

  // ---- Range delete (any delete type with a non-empty selection) ------------
  if (!collapsed) {
    const [start, end] =
      cmp(working, sel.anchor, sel.focus) <= 0
        ? [sel.anchor, sel.focus]
        : [sel.focus, sel.anchor];
    const si = indexOfId(working, start.wordId);
    const ei = indexOfId(working, end.wordId);
    if (si === -1 || ei === -1) return finalize(model, working, start.wordId, start.offset, touched);

    for (let i = si; i <= ei; i++) {
      const w = working[i];
      const from = i === si ? start.offset : 0;
      const to = i === ei ? end.offset : w.chars.length;
      if (to > from) {
        w.chars = w.chars.slice(0, from) + w.chars.slice(to);
        touched.add(w.id);
      }
    }
    return finalize(model, working, start.wordId, start.offset, touched);
  }

  // ---- Collapsed caret ------------------------------------------------------
  const wi = indexOfId(working, sel.anchor.wordId);
  if (wi === -1) return finalize(model, working, null, 0, touched);
  const off = sel.anchor.offset;
  const word = working[wi];

  // Strictly one character per collapsed keystroke. Word/line-granularity delete
  // types (Ctrl+Backspace etc.) are intentionally treated as a single character
  // too — a keystroke never empties a whole (and never a NEIGHBOR) word. A whole
  // word only goes once the user has backspaced through its last character, which
  // keeps the char-by-char "shrink, then ripple on empty" contract.
  const forward = inputType.includes('Forward');

  if (!forward) {
    // Backward (Backspace)
    if (off > 0) {
      word.chars = word.chars.slice(0, off - 1) + word.chars.slice(off);
      touched.add(word.id);
      return finalize(model, working, word.id, off - 1, touched);
    }
    // off === 0 → take the previous word's last character.
    const p = working[wi - 1];
    if (!p) return finalize(model, working, word.id, 0, touched);
    p.chars = p.chars.slice(0, -1);
    touched.add(p.id);
    return finalize(model, working, p.id, p.chars.length, touched);
  } else {
    // Forward (Delete)
    if (off < word.chars.length) {
      word.chars = word.chars.slice(0, off) + word.chars.slice(off + 1);
      touched.add(word.id);
      return finalize(model, working, word.id, off, touched);
    }
    // off === len → take the next word's first character.
    const n = working[wi + 1];
    if (!n) return finalize(model, working, word.id, off, touched);
    n.chars = n.chars.slice(1);
    touched.add(n.id);
    return finalize(model, working, n.id, 0, touched);
  }
}
