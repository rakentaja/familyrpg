// Table moments between scenes: "Wrap it!" (charades), "Draw the ornament" (shared canvas), "Hum-a-tune".
import type { GameState, PackTableMoment } from '../engine/types';
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { icon } from './icons';
import { canRunTable, hero } from './common';
import { readAloud, sfx, buzz } from './feedback';

const INK = ['#2a2328', '#c97f84', '#7f9a78', '#8c80a8', '#d9b75a'];

interface Stroke { s: string; c: string; w: number; p: [number, number][] }

export function momentView(ctx: Ctx) {
  const store = ctx.store!;
  const pack = ctx.pack;
  const net = store.net;
  const el = h('div', { class: 'modal moment', role: 'dialog', 'aria-label': 'Table moment' });
  const card = h('div', { class: 'card moment-card tall' });
  el.appendChild(card);

  // ---- persistent drawing canvas (survives re-renders)
  const canvas = h('canvas', { class: 'draw-canvas', width: '600', height: '600', 'aria-label': 'Drawing' });
  const g = canvas.getContext('2d')!;
  let strokes = new Map<string, Stroke>();
  let ink = INK[0];
  let canDraw = false;
  let momentKey = '';
  let localDone = false;      // timer ran out / performer tapped Done → show the pick/vote step
  let peek = false;           // pass-and-play: performer holds to peek at the prompt
  let timerId = 0;
  let last: GameState | null = null;
  let doneKey = '';

  const paintAll = () => {
    g.fillStyle = '#f7f3ec'; g.fillRect(0, 0, 600, 600);
    for (const st of strokes.values()) drawSeg(st, 0);
  };
  const drawSeg = (st: Stroke, from: number) => {
    g.strokeStyle = st.c; g.lineWidth = st.w; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    const pts = st.p;
    const start = Math.max(0, from - 1);
    if (!pts.length) return;
    g.moveTo(pts[start][0] * 600, pts[start][1] * 600);
    for (let i = start; i < pts.length; i++) g.lineTo(pts[i][0] * 600, pts[i][1] * 600);
    if (pts.length === 1) g.lineTo(pts[0][0] * 600 + 0.1, pts[0][1] * 600);
    g.stroke();
  };
  paintAll();

  let cur: Stroke | null = null;
  let pending: [number, number][] = [];
  let flushT = 0;
  const flush = () => {
    flushT = 0;
    if (!cur || !pending.length) return;
    net.sendEphemeral('draw', { k: momentKey, s: cur.s, c: cur.c, w: cur.w, p: pending });
    pending = [];
  };
  const pt = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))].map((v) => Math.round(v * 1000) / 1000) as [number, number];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw) return;
    canvas.setPointerCapture(e.pointerId);
    cur = { s: Math.random().toString(36).slice(2, 8), c: ink, w: ink === '#f7f3ec' ? 28 : 7, p: [pt(e)] };
    strokes.set(cur.s, cur); pending = [cur.p[0]]; drawSeg(cur, 0);
    flushT = setTimeout(flush, 110) as unknown as number;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const p = pt(e); const lp = cur.p[cur.p.length - 1];
    if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) < 0.004) return;
    cur.p.push(p); pending.push(p); drawSeg(cur, cur.p.length - 1);
    if (!flushT) flushT = setTimeout(flush, 110) as unknown as number;
  });
  const up = () => { if (cur) { clearTimeout(flushT); flush(); cur = null; } };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  const offEph = net.onEphemeral((ch, data, from) => {
    if (from === store.me) return;
    const d = data as { k: string; s: string; c: string; w: number; p: [number, number][] };
    if (ch === 'drawClear' && (data as { k: string })?.k === momentKey) { strokes = new Map(); paintAll(); return; }
    if (ch !== 'draw' || !d || d.k !== momentKey || !Array.isArray(d.p)) return;
    let st = strokes.get(d.s);
    if (!st) { st = { s: d.s, c: d.c, w: d.w, p: [] }; strokes.set(d.s, st); }
    const from0 = st.p.length; st.p.push(...d.p); drawSeg(st, from0);
  });

  function def(s: GameState): PackTableMoment | undefined {
    return pack.tableMoments.find((m) => m.id === s.tableMoment?.id);
  }
  const name = (s: GameState, id?: string) => s.players.find((p) => p.id === id)?.name ?? hero(s, id)?.name ?? 'Someone';
  const tm = (op: 'start' | 'begin' | 'vote' | 'finish' | 'skip', extra: { performer?: string; vote?: string; winner?: string; at?: number } = {}) => {
    sfx.tap(); store.dispatch({ t: 'tm', op, ...extra });
  };

  /** Players who can win (everyone but the performer). */
  function candidates(s: GameState): { id: string; label: string }[] {
    const perf = s.tableMoment?.performer;
    return s.players.filter((p) => p.id !== perf).map((p) => ({ id: p.id, label: p.name }));
  }

  function render(s: GameState) {
    last = s;
    const t = s.tableMoment;
    const d = def(s);
    const me = store.me;
    const runner = canRunTable(s, me, store.isHost());
    const local = store.role === 'local';
    const kind = d?.kind ?? 'charades';
    const key = `${t?.id}:${t?.performer}:${t?.stage === 'performing' ? 'p' : 'x'}:${t?.endsAt ?? ''}`;
    if (t?.stage === 'performing' && key !== momentKey) { momentKey = key; strokes = new Map(); paintAll(); localDone = false; peek = false; }
    if (t?.stage !== 'performing') { localDone = false; }
    const iPerform = !!t && (t.performer === me || local);
    canDraw = kind === 'draw' && t?.stage === 'performing' && iPerform && !localDone;
    clearInterval(timerId);

    const head = h('header', { class: 'moment-head' },
      h('p', { class: 'kicker' }, 'Table moment'),
      h('h2', null, d?.name ?? 'Table moment', ' ', readAloud(() => `${d?.name}. ${d?.text}`)),
      btn('Skip', () => tm('skip'), 'ghost small skip', { 'aria-label': 'Skip the table moment' }));
    const parts: (HTMLElement | null)[] = [head];

    if (!t || t.stage === 'ready') {
      parts.push(h('p', { class: 'prose' }, d?.text ?? ''));
      if (d) parts.push(h('p', { class: 'hint' }, `Winner gets ${d.reward} ${pack.labels.sparks}!`));
      const chosen = !!t?.performer;
      if (!local && runner && s.players.length > 1) {
        parts.push(h('p', { class: 'lbl' }, 'Who goes first?'),
          h('div', { class: 'chips' }, s.players.map((p) => h('button', {
            type: 'button', class: 'chip' + (t?.performer === p.id ? ' on' : ''), style: `--c:${p.color}`, onclick: () => tm('start', { performer: p.id }),
          }, p.name))));
      }
      if (!chosen) {
        if (local) parts.push(btn('Let’s play!', () => tm('start', { performer: me }), 'primary big'));
        else if (runner) parts.push(btn('I’ll go first', () => tm('start', { performer: me }), 'primary big'));
        else parts.push(btn('Me! I’ll go first', () => tm('start', { performer: me }), 'big'), waiting(s));
      } else if (iPerform) {
        parts.push(h('p', { class: 'big-q' }, local ? 'Pick who goes first and hand them the phone. Everyone else: no peeking!' : 'You’re up! Don’t show anyone your screen.'),
          btn('Start!', () => tm('begin', { at: Date.now() }), 'primary big'));
      } else parts.push(h('p', { class: 'waiting' }, `${name(s, t!.performer)} is getting ready…`));
    } else if (t.stage === 'performing' && !localDone) {
      const left = h('b', { class: 'timer' });
      const tick = () => {
        const ms = t.endsAt ? t.endsAt - Date.now() : (d?.seconds ?? 30) * 1000;
        const sec = Math.max(0, Math.ceil(ms / 1000));
        left.textContent = String(sec);
        left.classList.toggle('low', sec <= 5);
        if (t.endsAt && ms <= 0) { clearInterval(timerId); sfx.chime(); buzz([60, 40, 60]); localDone = true; render(s); }
      };
      tick(); timerId = setInterval(tick, 250) as unknown as number;
      const prompt = t.prompt ?? '';
      const secret = local
        ? h('button', { type: 'button', class: 'peek' + (peek ? ' on' : ''), onpointerdown: () => { peek = true; secretTxt.hidden = false; }, onpointerup: () => { peek = false; secretTxt.hidden = true; }, onpointerleave: () => { secretTxt.hidden = true; } },
          'Performer: hold here to peek')
        : null;
      const secretTxt = h('p', { class: 'secret', hidden: local }, prompt);
      parts.push(h('div', { class: 'timer-row' }, icon('clock', 'ic big'), left));
      if (iPerform) {
        parts.push(h('div', { class: 'secret-box' }, h('span', { class: 'lbl' }, kind === 'draw' ? 'Draw this:' : kind === 'hum' ? 'Hum this tune:' : 'Act this out:'), secret, secretTxt));
      } else {
        parts.push(h('p', { class: 'big-q' }, kind === 'draw' ? `${name(s, t.performer)} is drawing… what is it?` : kind === 'hum' ? `${name(s, t.performer)} is humming… name that tune!` : `${name(s, t.performer)} is acting… guess out loud!`));
      }
      if (kind === 'draw') {
        parts.push(canvas);
        if (canDraw) parts.push(h('div', { class: 'row center inks' }, [...INK, '#f7f3ec'].map((c) => h('button', {
          type: 'button', class: 'swatch' + (c === ink ? ' on' : '') + (c === '#f7f3ec' ? ' eraser' : ''), style: `--c:${c}`, 'aria-label': c === '#f7f3ec' ? 'Eraser' : 'Ink colour',
          onclick: () => { ink = c; render(s); },
        })), btn('Clear', () => { strokes = new Map(); paintAll(); net.sendEphemeral('drawClear', { k: momentKey }); }, 'ghost small')));
      }
      if (iPerform || runner) parts.push(btn(kind === 'draw' ? 'Done drawing' : 'Someone guessed it!', () => { localDone = true; sfx.chime(); render(s); }, 'primary big'));
    } else if (t.stage === 'performing' || t.stage === 'voting') {
      if (kind === 'draw') parts.push(canvas);
      if (t.prompt && (iPerform || runner)) parts.push(h('p', { class: 'hint center' }, `It was: “${t.prompt}”`));
      if (local) {
        parts.push(h('p', { class: 'big-q' }, kind === 'hum' ? 'Did someone name the tune?' : 'Did someone guess it?'),
          h('div', { class: 'choice-list' },
            btn('⭐ Yes, we got it!', () => tm('finish', { winner: me }), 'big primary'),
            btn('Nobody got it', () => tm('finish', {}), 'ghost')));
      } else {
        const others = candidates(s);
        const votes = t.votes ?? {};
        const tally = (id: string) => Object.values(votes).filter((v) => v === id).length;
        if (kind === 'draw' && !iPerform) {
          parts.push(h('p', { class: 'big-q' }, 'Who guessed it first?'),
            h('div', { class: 'choice-list' }, others.map((c) => btn(`${c.label}${tally(c.id) ? ' · ' + '⭐'.repeat(tally(c.id)) : ''}`, () => tm('vote', { vote: c.id }), 'big' + (votes[me] === c.id ? ' on' : '')))));
        }
        if (iPerform || runner) {
          parts.push(h('p', { class: 'big-q' }, kind === 'hum' ? 'Who named the tune first?' : kind === 'draw' ? 'Pick the winner (or count the votes)' : 'Who guessed it?'),
            h('div', { class: 'choice-list' },
              others.map((c) => btn(`${c.label}${tally(c.id) ? ' · ' + '⭐'.repeat(tally(c.id)) : ''}`, () => tm('finish', { winner: c.id }), 'big')),
              kind === 'draw' && Object.keys(votes).length ? btn('Count the votes', () => tm('finish', {}), 'primary') : null,
              btn('Nobody got it', () => tm('finish', {}), 'ghost')));
        } else if (kind !== 'draw') parts.push(h('p', { class: 'waiting' }, `${name(s, t.performer)} is picking who got it…`));
      }
    } else if (t.stage === 'done') {
      const won = !!t.winner;
      parts.push(h('div', { class: 'outcome ' + (won ? 'o-success' : 'o-twist') },
        h('b', null, won ? (local ? `You win ${d?.reward ?? 1} ${pack.labels.sparks}!` : `${name(s, t.winner)} wins ${d?.reward ?? 1} ${pack.labels.sparks}!`) : 'What fun! On with the adventure.')));
      if (t.prompt) parts.push(h('p', { class: 'hint center' }, `It was: “${t.prompt}”`));
      if (kind === 'draw') parts.push(canvas);
      parts.push(runner ? btn('On with the adventure!', () => { sfx.tap(); store.dispatch({ t: 'next' }); }, 'primary big') : waiting(s));
      if (won && doneKey !== key) sfx.twinkle();
      doneKey = key;
    }
    card.replaceChildren(...parts.filter(Boolean) as HTMLElement[]);
  }

  function waiting(s: GameState) {
    const hst = s.players.find((p) => p.host);
    return h('p', { class: 'waiting' }, `Waiting for ${hst?.name ?? 'the host'}…`);
  }

  return {
    el,
    update: render,
    destroy() { offEph(); clearInterval(timerId); clearTimeout(flushT); },
    get state() { return last; },
  };
}
