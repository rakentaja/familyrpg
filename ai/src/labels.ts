// Word labels the tagger predicts (one per model word). The assembler turns labelled words into DSL.
// Keep this list append-only once a model is trained: the label index is baked into the model head.

export const LABELS = [
  'O', 'SEP',
  // actions (the verb words). A clause with no action is "add" (or "edit" when it only has modifiers).
  'ACT-add', 'ACT-edit', 'ACT-move', 'ACT-remove', 'ACT-hide', 'ACT-show',
  'ACT-scene_add', 'ACT-scene_set', 'ACT-scene_copy', 'ACT-scene_delete', 'ACT-goto', 'ACT-recipe',
  // roles of entity placeholders
  'SUBJ', 'TGT', 'FACE',
  // selection words: "all/every/everything", "it/this/that one/them"
  'SEL-all', 'SEL-it',
  'COUNT', 'NUM',
  'REL-near', 'REL-behind', 'REL-front_of', 'REL-left_of', 'REL-right_of', 'REL-around', 'REL-on',
  'REG-center', 'REG-spread', 'REG-side', 'REG-corner', 'REG-side_n', 'REG-side_s', 'REG-side_e', 'REG-side_w',
  'REG-corner_ne', 'REG-corner_nw', 'REG-corner_se', 'REG-corner_sw',
  'MOD-cluster', 'MOD-hidden', 'MOD-shown',
  'MOD-scale_up', 'MOD-scale_down', 'MOD-scale_x2', 'MOD-scale_half', 'MOD-scale_reset',
  'MOD-turn_right', 'MOD-turn_left', 'MOD-turn_around', 'MOD-face', 'MOD-face_center',
  'MOD-lift_up', 'MOD-lift_down', 'MOD-lift_max', 'MOD-lift_floor',
  'GROUND-floor', 'GROUND-snow', 'GROUND-ice', 'GROUND-roof',
  'SIZE', 'NAME',
  'NAV-next', 'NAV-prev', 'NAV-first', 'NAV-last',
  'PARAM-dense', 'PARAM-sparse',
  // added 2026-11-11: exact size ("resize to 1") and exact turn ("rotate to 90 degrees")
  'MOD-scale_set', 'MOD-turn_set',
] as const;
export type Label = typeof LABELS[number];
export const LABEL_SET = new Set<string>(LABELS);
