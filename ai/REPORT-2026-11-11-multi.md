# Multi-instruction report — 2026-11-11

## Result

The helper now handles requests with more than one instruction. On a new test set of 98 multi-instruction
requests (`eval/heldout3.jsonl`), exact match went from **83 to 95 (84.7% → 96.9%)**. The older test sets did not get worse.
The model is the same size (14.0 MB int8) and takes about 1–2 ms per request.

| Test set | Before (`gm-tagger-20261111b`) | After (`gm-tagger-20261111c`) |
|---|---|---|
| `heldout3`: 98 requests with 2–4 instructions (new) | 83 (84.7%) | **95 (96.9%)** |
| `heldout`: 50, mostly single | 50 (100%) | 49 (98%) |
| `heldout2`: 100, mostly single | 94 (94%) | **96 (96%)** |
| All 248 | 227 (91.5%) | **240 (96.8%)** |

Why nobody saw this before: only 15 of the 150 old test requests had more than one instruction, and they were
written close to the templates. The gate was measuring single requests.

## What was not possible before, and is now

| Request | Before | Now |
|---|---|---|
| delete the crates **and the rocks** | `remove crates`, `goto first` | still wrong (see below) |
| hide the imps **and the rats** and show the golem | the rats were *added* | hides both, shows the golem |
| make all the lamps bigger **and the benches smaller** | `goto first` | two edits |
| put the snowman in the middle **and the mailbox in the corner** | mailbox *added* | both moved |
| remove the fence **plus** the signpost | `goto first` | both removed |
| put a crate in the top left corner **put** a bench in the bottom right (no "and") | bench in the top left | each in its own corner |
| hide the golem **make** the imps bigger (no "and") | one merged command | two commands |
| add a snowman **and make it bigger** | one bigger snowman, which is close but not what was asked | add, then edit "it" |
| add two lamp posts on the right, **make them smaller** | merged | add, then edit "them" |
| add a crate in the corner and put **another one** next to it | second crate lost | a second crate next to the first |
| add a snow golem at the back and make **the new one** face the middle | edit lost | the edit applies to the new golem |
| add the troll at the back and make **him** face the door | "him" not understood | understood (but see below) |
| add a clue on the bench. **next,** a villager by the mailbox | jumped to the next scene | two adds |
| rotate it **90 degrees** and make it smaller | size set to 1/90 (a bug) | turn 90, smaller |

The game side is new as well:

- **Every line is checked against the table before it runs** (`check()` in `game/src/ai/solve.ts`). The checks are:
  - a missing piece: "There is no bench in this scene."
  - "it" with nothing to point at
  - no piece selected
  - a scene that doesn't exist
  - deleting the only scene
  - contradictions inside one plan, for example "Line 1 adds this, and this line removes it again." or
    "Line 1 hides this piece."

  The check runs the real `run()` on a throwaway copy of the table, so the preview and the real run can't
  disagree.
- **The plan has one tickbox per line.** A line that can't run starts unticked and says why. A line the model is
  unsure about is marked "not sure". Do it runs only the ticked lines. Enter still runs the plan.
- **Real requests are kept for retraining.** Every Do it and Cancel is logged on the device (`sb2.ai.log`, at most
  500 entries) with the text, the plan, the ticked lines, the issues and the confidences. "Copy requests (N)" in
  the Ask card copies them as JSONL. Nothing is sent anywhere.

## What changed

1. **Test set:** `eval/heldout3.jsonl` has 98 requests. They were written without looking at the training
   templates and are checked against the strict DSL parser and the lexicon. They cover:
   - plain "and"
   - noun lists vs command lists, written as matched pairs
   - commas or no punctuation at all
   - "also / next / after that / plus"
   - "it / them / the new one / another one"
   - 3–4 instructions
   - modifiers and places that must stay with their own instruction

   `eval/run.ts` now also prints the score by the number of commands per request.
2. **Assembler (`src/assemble.ts`), deterministic, no model change:**
   - **Implied boundaries.** A new clause starts before a different verb once the clause has something to act on,
     or before the same verb again after a thing ("put a crate … put a bench"). It also starts before a new thing
     after a thing plus a place ("a fence along the bottom two signposts on the left"). "New snowy room" still
     stays one clause.
   - **Gapping.** A verbless clause about something already on the table ("the X", "all the X") keeps the
     previous verb, but only when it fits: edit needs a change, move needs a place, and remove/hide/show need
     neither.
   - **"another one"** is a new label, `SEL-again` (appended, so old label ids are unchanged). It means the thing
     the last add made.
   - **Numbers go with their own kind of word.** "90 degrees" never sets a size, and "2 metres" or "50%" never
     sets a turn.

   With gold labels the assembler is still 100% on the 2,156 dev rows. With these rules alone, the old model went
   from 84.7% to 88.8% on heldout3.
3. **Training data (`data/realize.ts`, `data/phrases.ts`):**
   - More multi-instruction requests: 55% had one instruction before, 45% do now.
   - The joining word is often "and" or a comma.
   - Some clauses start with a new verb and no joining word, as in voice input.
   - 35% of follow-up clauses refer back with "it / them / those / the new one / him / her".
   - Gapped clauses are added.
   - "another one" clauses are added.
   - New phrases: "go back a scene", "forward a scene", and "next" as a joining word.

   `data/build.ts` now re-checks every row (templates and the older Haiku rewrites) against the current
   assembler; 8 old rewrites were dropped. The result is 41,366 training rows.
4. **Retrained:** ELECTRA-small, 4 epochs, the same settings as before. Training took 7.5 minutes on the M4.
   Shipped as `game/public/ai/gm-tagger-20261111c` (`MODEL` in `game/src/ai/helper.ts`). The old `…b` folder was
   removed.
5. **Two-pass parsing (`parseRequest(…, 'clause')`):** the second pass tags each clause on its own. With the old
   model it fixed a few rows. With the new model a single pass is as good or better on every set and twice as fast,
   so `'whole'` is the default and `'clause'` is kept only for comparison.

## Still not possible (3 of 98, plus 1 on the old set)

- **"delete the crates and the rocks"**: the model still tags "the" in "and the rocks" as "first scene". The
  assembler would handle it if the words were tagged right. More real requests of this shape should fix it.
- **"spin the bench around rotate the signpost 90 degrees"**: there is no joining word, and the second verb is
  a turn word, not an action word. The assembler only splits before action words, because splitting before turn
  and size words would break "turn it to the right and make it bigger" style edits. Fixing this needs a model that
  marks a clause start without a joining word, which is a new kind of label. Not done.
- **"add the troll at the back"**: read as a *move*. This is arguable: the troll may already be on the table.
- **"New icy scene called Frozen Pond, 10 by 8"** (old set): the name was dropped. This is a new miss and needs a
  look.

Not attempted:

- **"hide them both"** after two separate adds: `last` means only the pieces from the last command. Fixing it
  needs a "last N" in the DSL and the solver.
- **The Gemma fallback** was not retrained. It is still optional and not shipped.

## Not verified

- **The Ask card on a phone:** tickbox size, the "not sure" mark, and Copy requests (clipboard rules differ on
  iOS). The build passes, and the 13 solver tests and 11 parser tests pass.
- **heldout3 is not your own words.** It was written by a separate agent that had not seen the templates, not by
  a real Guide. The request log is how to get real requests: copy it after a session, label it with
  `bun data/paraphrase.ts --annotate`, and retrain (README step 3).

## Re-run

```bash
cd ai
bun data/gen.ts --n 30000 && bun data/build.ts
cd train && uv run train_tagger.py --name gm-tagger-multi && uv run export_tagger.py --name gm-tagger-multi && cd ..
bun eval/run.ts --model gm-tagger-multi --set heldout,heldout2,heldout3,dev
```
