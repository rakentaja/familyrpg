# Rewrite batches (for Claude Code subagents)

Instructions for one rewrite agent. Use a fast, cheap model (Haiku); the merge step verifies everything.

## Task
Read `ai/out/rewrite/batch_NNN.in.jsonl`. Each line is
`{"id": "...", "markup": "...", "styles": ["...", ...]}`.
For each line, write one rewrite per listed style (all different), keeping the exact meaning and the markup.
Write `ai/out/rewrite/batch_NNN.out.jsonl`, one line per input line:
`{"id": "<same id>", "rewrites": ["...", "...", ...]}`. Valid JSON lines only, no other text.

## Markup rules
`[LABEL words]` marks words that carry meaning; plain words carry none. Example:
`[ACT-add put] [COUNT two] [SUBJ coal imps] [MOD-hidden hiding] [REL-behind behind] the [TGT crates]`
→ `[REL-behind behind] the [TGT boxes] [ACT-add stick] [COUNT a couple of] [SUBJ coal imps] [MOD-hidden where nobody can see them]`

- Every labelled span in the input must appear in the output with the same label, and you may not add new labelled spans.
  Spans may move, and their words may change, as long as the meaning stays the same.
- SUBJ/TGT/FACE spans name a game piece (SUBJ = the thing acted on, TGT = what it is placed relative to,
  FACE = what it faces). Keep naming the same piece. A common synonym is fine; keep singular/plural as it was.
- COUNT/NUM/SIZE spans must keep the same number (digits or words). NAME spans keep their exact text.
- ACT-* = the action words, SEP = words separating two commands ("and", "then", ","), REL-*/REG-* = where, MOD-* = how.
- Directions: n = back/far/top, s = front/near/bottom, e = right, w = left.
- Plain English only. Styles: follow the listed one (child, terse, voice transcript, polite, typos…).
