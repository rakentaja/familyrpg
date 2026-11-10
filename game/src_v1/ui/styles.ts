// All UI styles. Watercolour-comic look: cream paper, ink outlines, dusty rose / sage / lavender washes.
const CSS = /* css */ `
:root{
  --ink:#2a2328;--paper:#f2eadb;--paper2:#f7f3ec;--rose:#d8a7a7;--roseInk:#8a4a4e;--sage:#a9bfa0;--sageInk:#4d6b47;
  --lav:#b4abc6;--lavInk:#5b5175;--butter:#f1dfa4;--mute:#5a4e58;--danger:#a0494f;
  --hand:Kalam,'Comic Sans MS','Chalkboard SE','Segoe Print',cursive;
  --serif:'IM Fell English',Georgia,'Times New Roman',serif;
  --title:Cinzel,'Trajan Pro',Georgia,serif;
  --r:10px 6px 12px 7px;
  --sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px);--sal:env(safe-area-inset-left,0px);--sar:env(safe-area-inset-right,0px);
  --grain:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .55  0 0 0 0 .47  0 0 0 0 .38  0 0 0 .22 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:#e9e1d3;color:var(--ink);font-family:var(--hand);font-size:18px;line-height:1.35;
  -webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%;overscroll-behavior:none;touch-action:manipulation}
body{position:fixed;inset:0}
#board{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;visibility:hidden;outline:none}
body.board-on #board{visibility:visible}
#ui{position:fixed;inset:0;pointer-events:none;z-index:10}
#ui>*{pointer-events:auto}
button,input,select,textarea{font:inherit;color:inherit}
h1,h2,h3{margin:0;font-weight:700}
p{margin:.35em 0}
[hidden]{display:none!important}
.ic{display:inline-flex;width:1.35em;height:1.35em;vertical-align:-.3em;flex:none;align-items:center;justify-content:center}
.ic svg{width:100%;height:100%;overflow:visible}
.ic.big{width:2em;height:2em}.ic.huge{width:3.2em;height:3.2em}
.ic.emo{font-size:1.1em;line-height:1}
.hint{color:var(--mute);font-size:.88em}
.lbl{font-size:.85em;color:var(--mute);display:block}
.center{text-align:center;justify-content:center}
.row{display:flex;gap:10px;align-items:center}.row.wrap{flex-wrap:wrap}.grow{flex:1}
.paper{background:var(--paper2) var(--grain);border:2.5px solid var(--ink);border-radius:var(--r);box-shadow:3px 4px 0 rgba(42,35,40,.18)}

/* ---------- buttons (all ≥ 48px) */
.btn{min-height:48px;min-width:48px;padding:6px 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
  background:var(--paper);border:2.2px solid var(--ink);border-radius:var(--r);box-shadow:0 3px 0 var(--ink);font-family:var(--hand);font-size:1.02em;
  line-height:1.15;text-align:center;user-select:none;-webkit-user-select:none;touch-action:manipulation;transition:transform .08s,box-shadow .08s}
.btn:active:not(:disabled){transform:translateY(2px);box-shadow:0 1px 0 var(--ink)}
.btn:disabled{opacity:.42;cursor:default;box-shadow:none}
.btn:focus-visible,.seg-btn:focus-visible,.chip:focus-visible,.hchip:focus-visible,.swatch:focus-visible{outline:3px solid var(--lavInk);outline-offset:2px}
.btn.primary{background:var(--sage);font-weight:700}
.btn.ghost{background:transparent;box-shadow:none;border-style:dashed}
.btn.small{font-size:.9em;padding:4px 12px}
.btn.big{font-size:1.25em;min-height:58px;padding:8px 22px;width:100%}
.btn.huge{font-size:1.9em;min-height:84px;width:100%;letter-spacing:.04em}
.btn.icon{padding:0;width:48px;font-size:1.3em}
.btn.icon.round{border-radius:50%}
.btn.wide{width:100%;justify-content:flex-start}
.btn.good{background:var(--sage)}.btn.bad{background:var(--rose)}
.btn.danger{color:var(--danger);border-color:var(--danger)}
.btn.on{background:var(--lav)}
.btn.speak{width:44px;min-width:44px;min-height:44px;height:44px;border-radius:50%;box-shadow:none;border-width:1.8px;background:var(--paper2);font-size:1em;vertical-align:middle}
.btn.speak .ic{width:1.2em;height:1.2em}

input.name-in,input.code-in,input.twist-in,input.say-in,select{min-height:52px;padding:8px 14px;border:2.2px solid var(--ink);border-radius:var(--r);
  background:#fffdf8;font-family:var(--hand);font-size:1.1em;width:100%;min-width:0}
select{appearance:none;-webkit-appearance:none;padding-right:34px;
  background:#fffdf8 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='10'><path d='M1 1l6 7 6-7' fill='none' stroke='%232a2328' stroke-width='2.4'/></svg>") no-repeat right 12px center}
select.small{min-height:48px;font-size:.95em}
input:focus,select:focus{outline:3px solid var(--lav);outline-offset:1px}

/* ---------- screens */
.screen{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;background:var(--paper) var(--grain);
  padding:calc(var(--sat) + 12px) calc(var(--sar) + 14px) calc(var(--sab) + 18px) calc(var(--sal) + 14px)}
.screen-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 auto 12px;max-width:980px}
.screen-head h1{font-family:var(--title);font-size:1.45em;color:var(--roseInk);letter-spacing:.05em}
.card-block{padding:14px 16px;margin:0 auto 14px}
.card-block h2{font-family:var(--title);font-size:1.05em;letter-spacing:.06em;color:var(--roseInk);margin-bottom:8px}
body.busy-cursor{cursor:progress}
.busy{pointer-events:none;opacity:.85}

/* home */
.home{padding:0;display:flex;flex-direction:column;align-items:center}
.hero-art{width:100%;min-height:min(36vh,400px);flex:none;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  padding:calc(var(--sat) + 22px) 16px 0;text-align:center;
  background:linear-gradient(to bottom,rgba(242,234,219,0) 55%,var(--paper) 98%),url(img/cover.webp) center 30%/cover no-repeat,#b4abc6}
.hero-art h1{font-family:var(--title);font-size:clamp(2.2em,10vw,3.4em);letter-spacing:.06em;color:var(--paper2);
  text-shadow:0 2px 0 var(--ink),2px 0 0 var(--ink),-2px 0 0 var(--ink),0 -2px 0 var(--ink),3px 4px 0 rgba(42,35,40,.35)}
.hero-art .subtitle{margin-top:4px;background:rgba(247,243,236,.92);border:2px solid var(--ink);border-radius:var(--r);padding:2px 12px;font-size:1.02em}
.sheet-card{width:calc(100% - 28px);max-width:560px;margin:-48px auto calc(var(--sab) + 18px);padding:14px 16px 16px;position:relative;z-index:1}
.premise{font-family:var(--serif);font-size:1em;line-height:1.4;margin-top:14px;color:var(--mute)}
.me-row{display:grid;grid-template-columns:1fr;gap:6px;margin:0 0 12px}
.swatches{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:4px 3px}.swatches::-webkit-scrollbar{display:none}
.swatch{width:42px;height:42px;flex:none;border-radius:50%;border:2.2px solid var(--ink);background:var(--c);cursor:pointer;padding:0}
.swatch.on{box-shadow:0 0 0 3px var(--paper2),0 0 0 5.5px var(--ink)}
.swatch.eraser{background:repeating-linear-gradient(45deg,#f7f3ec 0 5px,#e2d8c6 5px 10px)}
.choices{display:flex;flex-direction:column;gap:12px}
.btn.choice{justify-content:flex-start;text-align:left;min-height:72px;padding:10px 14px;gap:14px;font-size:1.05em}
.btn.choice .ic{width:2.2em;height:2.2em}
.btn.choice span{display:flex;flex-direction:column}
.btn.choice b{font-size:1.2em}.btn.choice small{font-size:.82em;color:var(--mute);font-weight:400}
.btn.choice.primary small{color:#3d4f39}
.join-panel{padding:10px 12px;border:2px dashed var(--ink);border-radius:var(--r);display:flex;flex-direction:column;gap:10px;background:#fffdf8}
.load-row{margin-top:14px;display:flex;align-items:center;gap:10px;font-size:.9em;color:var(--mute)}
.bar{height:12px;border:2px solid var(--ink);border-radius:8px 5px 9px 6px;overflow:hidden;background:var(--paper2);flex:1}
.bar i{display:block;height:100%;width:0;background:var(--sage);transition:width .3s}
.install{margin-top:12px}

/* joining */
.joining{display:flex;align-items:center;justify-content:center}
.joining .sheet-card{margin:0;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.spinner{width:64px;height:64px;border:5px solid var(--lav);border-top-color:var(--ink);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* lobby */
.lobby{padding-bottom:calc(var(--sab) + 110px)}
.lobby-cols{max-width:980px;margin:0 auto;display:grid;grid-template-columns:1fr;gap:0 16px}
@media (min-width:820px){.lobby-cols{grid-template-columns:1fr 1fr}}
.invite-row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:center}
.invite-text{flex:1;min-width:200px}
.qr{border:2.5px solid var(--ink);border-radius:var(--r);overflow:hidden;background:var(--paper2);flex:none}
.qr svg{display:block}
code.code{display:inline-block;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:1.25em;font-weight:700;letter-spacing:.08em;
  background:#fffdf8;border:2px dashed var(--ink);border-radius:8px;padding:6px 10px;margin:6px 0 10px;user-select:all;-webkit-user-select:all;word-break:break-all}
code.code.small{font-size:.95em;margin:0}
.players{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.player{display:flex;align-items:center;gap:10px;min-height:44px;padding:2px 4px;border-bottom:1.5px dashed rgba(42,35,40,.2)}
.player:last-child{border-bottom:0}
.dot{width:22px;height:22px;border-radius:50%;background:var(--c);border:2px solid var(--ink);flex:none}
.pname{flex:1;font-size:1.05em}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:.78em;background:var(--butter);border:1.6px solid var(--ink);border-radius:20px;padding:1px 8px}
.badge.guide{background:var(--lav)}
.online{width:14px;height:14px;border-radius:50%;background:#cfc6b6;border:1.6px solid var(--ink);flex:none}
.online.on{background:#7fb36f;box-shadow:0 0 0 3px rgba(127,179,111,.3)}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.seg-btn{min-height:76px;padding:8px 10px;border:2.2px solid var(--ink);border-radius:var(--r);background:var(--paper);display:flex;flex-direction:column;
  align-items:flex-start;text-align:left;gap:2px;cursor:pointer;box-shadow:0 3px 0 var(--ink)}
.seg-btn.on{background:var(--sage)}
.seg-btn:disabled{cursor:default}.seg-btn:disabled:not(.on){opacity:.6}
.seg-btn b{font-size:1.08em}.seg-btn small{font-size:.8em;color:var(--mute);line-height:1.2}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{min-height:48px;padding:4px 14px;border:2.2px solid var(--ink);border-radius:30px;background:var(--paper);display:inline-flex;align-items:center;gap:6px;cursor:pointer;
  box-shadow:inset 0 -6px 0 var(--c,transparent)}
.chip.on{background:var(--lav);font-weight:700}
.guide-pick{margin-top:12px}
.toggle{display:flex;align-items:center;gap:12px;margin-top:14px;min-height:56px;cursor:pointer}
.toggle input{position:absolute;opacity:0;width:1px;height:1px}
.toggle .switch{width:58px;height:34px;border:2.2px solid var(--ink);border-radius:20px;background:#ddd3c2;position:relative;flex:none;transition:background .2s}
.toggle .switch::after{content:'';position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:var(--paper2);border:2px solid var(--ink);transition:left .2s}
.toggle input:checked+.switch{background:var(--sage)}
.toggle input:checked+.switch::after{left:26px}
.toggle input:focus-visible+.switch{outline:3px solid var(--lavInk);outline-offset:2px}
.toggle span:last-child{display:flex;flex-direction:column}.toggle small{font-size:.8em;color:var(--mute)}
.heroes{display:flex;flex-direction:column;gap:10px}
.hero-card{display:flex;align-items:center;gap:12px;padding:8px;border:2px solid var(--ink);border-radius:var(--r);background:#fffdf8;box-shadow:inset 6px 0 0 var(--pc)}
.hc-text{flex:1;display:flex;flex-direction:column;min-width:0}
.hname{font-size:1.15em}
.hc-text>small{color:var(--mute);margin-top:-2px}
.traits,.traits-line{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.trait{display:inline-flex;align-items:center;gap:3px;font-size:.92em}
.trait b{font-size:.95em}
.pips{display:inline-flex;gap:3px}
.pips i{width:9px;height:9px;border-radius:50%;border:1.6px solid var(--ink);background:transparent}
.pips i.on{background:var(--ink)}
.pips.big i{width:18px;height:18px;border-width:2.2px}
.t-brave .pips i.on{background:var(--roseInk)}.t-clever .pips i.on{background:#b08a2e}.t-kind .pips i.on{background:var(--sageInk)}
.owner{font-size:.85em;color:var(--mute)}
.owner-sel.small{margin-top:6px;max-width:240px}
.btn.add-hero{width:100%;min-height:64px;border-style:dashed;font-size:1.15em;background:transparent;box-shadow:none}
.plus{font-size:1.5em;line-height:0}
.start-box{position:fixed;left:0;right:0;bottom:0;padding:10px calc(var(--sar) + 14px) calc(var(--sab) + 12px) calc(var(--sal) + 14px);
  background:linear-gradient(to top,var(--paper) 70%,rgba(242,234,219,0));display:flex;flex-direction:column;align-items:center;gap:4px;z-index:2}
.start-box>*{max-width:560px}
.waiting{color:var(--mute);text-align:center;font-size:1.02em}
.dots-anim{display:inline-block;animation:blink 1.4s infinite}
@keyframes blink{50%{opacity:.2}}

/* avatars */
.avatar{--pc:#b4abc6;width:58px;height:58px;border-radius:50%;border:2.5px solid var(--ink);background:var(--pc);overflow:hidden;flex:none;display:inline-flex;
  align-items:center;justify-content:center;position:relative;box-shadow:0 0 0 3px var(--pc) inset}
.avatar img{width:100%;height:100%;object-fit:cover;object-position:50% 0;transform:scale(1.25);transform-origin:50% 0;background:var(--paper2)}
.avatar b{font-family:var(--title);font-size:1.4em}
.avatar.small{width:44px;height:44px;border-width:2px}
.avatar.tiny{width:30px;height:30px;border-width:1.6px}

/* ---------- modals & cards */
.modal{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(42,35,40,.38);
  padding:calc(var(--sat) + 10px) calc(var(--sar) + 10px) calc(var(--sab) + 10px) calc(var(--sal) + 10px);animation:fadein .2s}
@keyframes fadein{from{opacity:0}}
.card{background:var(--paper2) var(--grain);border:2.5px solid var(--ink);border-radius:var(--r);box-shadow:4px 6px 0 rgba(42,35,40,.3);
  width:100%;max-width:540px;max-height:100%;overflow-y:auto;padding:16px 16px 18px;display:flex;flex-direction:column;gap:10px;animation:pop .25s cubic-bezier(.3,1.4,.6,1)}
@keyframes pop{from{transform:scale(.92) translateY(14px);opacity:0}}
.card.tall{height:100%;max-height:860px;padding:0;overflow:hidden}
.card.tall .scroll{flex:1;overflow-y:auto;padding:4px 16px 12px;-webkit-overflow-scrolling:touch}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 4px 16px}
.card:not(.tall)>.card-head{padding:0}
.card-head h2{font-family:var(--title);font-size:1.15em;letter-spacing:.05em;color:var(--roseInk)}
.card-foot{padding:10px 16px calc(12px);border-top:2px dashed rgba(42,35,40,.25);display:flex;gap:10px}
.card-foot .btn{flex:1}
.kicker{font-size:.82em;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0}
.story-card .title{font-family:var(--title);font-size:1.5em;color:var(--roseInk);letter-spacing:.03em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.prose{font-family:var(--serif);font-size:1.15em;line-height:1.45}
.goal{display:flex;gap:10px;align-items:flex-start;background:#fffdf8;border:2px dashed var(--ink);border-radius:var(--r);padding:10px 12px}
.goal .ic{width:2em;height:2em}
.goal p{margin:0}
.story-card.won{background-color:#eef3e9}.story-card.lost{background-color:#f5ece9}
.meter-line{display:flex;align-items:center;gap:10px}
.gifts{display:inline-flex;gap:2px}.gifts .ic{width:1.5em;height:1.5em}
.gifts.big .ic{width:2.2em;height:2.2em}
.big-q{font-size:1.3em;font-weight:700;text-align:center}

/* creator */
.creator .card{max-width:620px}
.step{font-size:1.1em;margin:12px 0 6px}
.step b{display:inline-flex;width:30px;height:30px;border-radius:50%;background:var(--ink);color:var(--paper2);align-items:center;justify-content:center;font-size:.9em;margin-right:4px}
.carousel-wrap{position:relative}
.carousel{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px 8% 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
.carousel::-webkit-scrollbar{display:none}
.role-card{scroll-snap-align:center;flex:0 0 84%;max-width:400px;display:flex;gap:10px;background:#fffdf8;border:2.5px solid var(--ink);border-radius:var(--r);
  padding:10px;box-shadow:0 4px 0 rgba(42,35,40,.25);transition:transform .2s,opacity .2s;opacity:.6;transform:scale(.95)}
.role-card.sel{opacity:1;transform:none;background:#fffaf0}
.role-card.taken .role-pic{filter:grayscale(.5)}
.role-pic{flex:0 0 38%;max-width:140px;aspect-ratio:220/440;border-radius:8px;overflow:hidden;background:var(--paper2);border:1.6px solid rgba(42,35,40,.4)}
.role-pic img{width:100%;height:100%;object-fit:cover;object-position:50% 10%}
.role-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.role-text h3{font-family:var(--title);font-size:1.02em;color:var(--roseInk);display:flex;align-items:center;justify-content:space-between;gap:6px}
.role-text p{font-size:.9em;margin:2px 0}
.role-text .blurb{font-family:var(--serif);font-size:.98em}
.role-text .knack .ic,.role-text .start .ic{margin-right:4px}
.tag{font-size:.75em!important;background:var(--butter);border-radius:6px;padding:0 6px;align-self:flex-start}
.nav{position:absolute;top:50%;transform:translateY(-60%);z-index:2;background:rgba(247,243,236,.92)}
.nav.prev{left:-4px}.nav.next{right:-4px}
.dots{display:flex;justify-content:center;gap:6px;margin:2px 0 6px}
.dots i{width:9px;height:9px;border-radius:50%;border:1.6px solid var(--ink)}
.dots i.on{background:var(--ink)}
.splitter{display:flex;flex-direction:column;gap:8px}
.split-row{display:grid;grid-template-columns:1fr 48px auto 48px;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r);background:#fffdf8;border:2px solid rgba(42,35,40,.35)}
.split-name{display:flex;align-items:center;gap:8px;min-width:0}
.split-name span{display:flex;flex-direction:column;min-width:0}
.split-name small{font-size:.75em;color:var(--mute);line-height:1.15}
.points-left{text-align:center;margin:6px 0;font-weight:700;color:var(--roseInk)}
.points-left.ok{color:var(--sageInk)}
.field{display:flex;flex-direction:column;gap:4px;margin-top:12px}

/* ---------- play HUD */
.play{position:absolute;inset:0;pointer-events:none}
.play>*{pointer-events:auto}
.play>.overlay-layer{pointer-events:none}
.overlay-layer>*{pointer-events:auto}
.topbar{position:absolute;top:0;left:0;right:0;padding:calc(var(--sat) + 6px) calc(var(--sar) + 8px) 6px calc(var(--sal) + 8px);
  background:linear-gradient(to bottom,rgba(242,234,219,.97),rgba(242,234,219,.9));border-bottom:2.5px solid var(--ink);box-shadow:0 3px 0 rgba(42,35,40,.12);
  display:flex;flex-direction:column;gap:6px}
.meters{display:flex;align-items:center;gap:8px}
.meter{display:flex;align-items:center;gap:4px;min-height:44px}
.meter.goal{flex:1;min-width:0}
.meter.goal .gifts{flex-wrap:nowrap;overflow:hidden}
.meter.goal .gifts .ic{width:1.45em;height:1.45em}
.meter.sparks{background:#fffdf8;border:2px solid var(--ink);border-radius:20px;padding:0 10px 0 6px;font-size:1.1em}
.meter.sparks .ic{width:1.6em;height:1.6em}
.ring{display:inline-flex}
.net-pill{font-size:.75em;background:var(--butter);border:1.6px solid var(--ink);border-radius:12px;padding:1px 8px}
.chips-row{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:2px 2px 4px}
.chips-row::-webkit-scrollbar{display:none}
.hchip{position:relative;flex:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px 3px 3px;border:2px solid transparent;border-radius:12px;background:transparent;
  min-width:54px;min-height:60px;cursor:pointer}
.hchip.mine{background:rgba(255,253,248,.7);border-color:rgba(42,35,40,.25)}
.hchip.sel{border-color:var(--ink);background:#fffdf8}
.hchip.active .avatar{box-shadow:0 0 0 3px var(--pc) inset,0 0 0 3px var(--butter),0 0 10px 4px rgba(241,223,164,.95)}
.hchip.tuckered .avatar img{filter:grayscale(1) brightness(.85)}
.hchip.done{opacity:.7}
.hchip-hearts{display:flex;gap:2px}
.hchip-hearts i{width:9px;height:8px;background:#e2d8c6;border:1.4px solid var(--ink);border-radius:50% 50% 50% 50%/60% 60% 40% 40%}
.hchip-hearts i.on{background:var(--rose)}
.badge-ic{position:absolute;right:-2px;top:-2px;width:22px;height:22px;background:var(--paper2);border:1.6px solid var(--ink);border-radius:50%;padding:2px}
.guide-fab{position:absolute;right:calc(var(--sar) + 10px);top:calc(var(--sat) + 132px);background:var(--lav);font-weight:700}

.sheet{position:absolute;left:0;right:0;bottom:0;margin:0 auto;max-width:640px;background:var(--paper2) var(--grain);border:2.5px solid var(--ink);border-bottom:0;
  border-radius:18px 14px 0 0;box-shadow:0 -4px 0 rgba(42,35,40,.12);padding:0 calc(var(--sar) + 12px) calc(var(--sab) + 10px) calc(var(--sal) + 12px);
  display:flex;flex-direction:column;gap:6px;max-height:42dvh;overflow-y:auto;overscroll-behavior:contain;transition:max-height .25s ease;touch-action:pan-y}
.sheet>*{flex:none}
.grip,.sheet-head{touch-action:none}
.sheet.expanded{max-height:84dvh}
.grip{position:sticky;top:0;z-index:1;align-self:center;width:84px;height:26px;border:0;background:transparent;cursor:pointer;position:relative;flex:none;padding:0}
.grip::after{content:'';position:absolute;left:22px;right:22px;top:9px;height:6px;border-radius:4px;background:var(--ink);opacity:.5}
.sheet-head{display:flex;align-items:center;gap:6px}
.nav-gap{width:4px}
.who{flex:1;display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer}
.who-text{display:flex;flex-direction:column;min-width:0}
.who-text b{font-size:1.15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who-text small{color:var(--mute);margin-top:-3px}
.hearts{display:inline-flex;gap:1px}.hearts .ic{width:1.25em;height:1.25em}
.turn-info{display:flex;align-items:center;gap:6px}
.steps{display:inline-flex;align-items:center;gap:2px;background:#fffdf8;border:2px solid var(--ink);border-radius:16px;padding:0 8px 0 4px;min-height:36px}
.steps .ic{width:1.5em;height:1.5em}
.acted .ic{width:1.6em;height:1.6em}
.hint-line{display:flex;align-items:center;gap:8px;font-size:1.02em;min-height:44px;padding:2px 10px;background:#fffdf8;border:1.8px dashed rgba(42,35,40,.45);border-radius:var(--r)}
.hint-line span{flex:1}
.hint-line:empty{display:none}
.actions{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:2px 2px 4px}
.actions .btn{min-height:52px;justify-content:flex-start;text-align:left;padding:6px 10px}
.actions .btn .ic{width:1.7em;height:1.7em}
.act-label{display:flex;flex-direction:column}
.act-label small{font-size:.75em;color:var(--mute)}
.btn.act.k-roll{background:#fbf3e6}
.btn.act.t-brave{background:#f6e3e1}.btn.act.t-clever{background:#f8efcf}.btn.act.t-kind{background:#e6eee2}
.btn.end-turn{background:var(--lav);font-weight:700;justify-content:center!important}
.btn.target-btn{background:var(--butter)}
.more{display:flex;flex-direction:column;gap:8px;padding-bottom:6px}
.more h3{font-size:1em;margin-top:6px;display:flex;align-items:center;gap:6px}
.knack-card,.item{display:flex;gap:10px;align-items:center;padding:8px 10px;border:2px solid var(--ink);border-radius:var(--r);background:#fffdf8}
.knack-card.used{opacity:.6}
.knack-card p,.item p{margin:0;font-size:.88em}
.knack-card>div,.item>div:not(.item-btns){flex:1}
.item-btns{display:flex;flex-direction:column;gap:6px}
.pocket{display:flex;flex-direction:column;gap:8px}
.log{margin:0;padding-left:1.4em;font-size:.88em;display:flex;flex-direction:column;gap:3px}
.log li.lk-good{color:var(--sageInk)}.log li.lk-bad{color:var(--danger)}.log li.lk-scene{font-weight:700}

.foe-card{position:absolute;left:50%;transform:translateX(-50%);top:calc(var(--sat) + 136px);width:min(92vw,420px);padding:10px 12px;z-index:20;animation:pop .2s}
.foe-card .row>div{flex:1}
.grump{display:inline-flex;gap:3px;vertical-align:middle}
.grump i{width:14px;height:14px;border-radius:3px;border:1.6px solid var(--ink);background:#e2d8c6;transform:rotate(45deg)}
.grump i.on{background:var(--lav)}
.weak{font-size:1.02em}

/* trait picker */
.trait-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.btn.trait-btn{flex-direction:column;min-height:132px;padding:10px 4px;font-size:1.05em;gap:4px}
.btn.trait-btn.suggested{background:var(--butter);box-shadow:0 3px 0 var(--ink),0 0 0 4px rgba(241,223,164,.8)}
.btn.trait-btn small{color:var(--mute)}

/* roll */
.modal.roll{align-items:flex-end;background:rgba(42,35,40,.22);z-index:45}
.modal.roll.is-rolling{background:transparent;pointer-events:none}
.modal.roll.is-rolling .card{opacity:.92}
.roll-card{max-width:560px}
.roll-head{display:flex;align-items:center;gap:12px}
.roll-head>div{flex:1}
.roll-head h2{font-size:1.25em}
.roll-head p{margin:0}
.roll-trait{display:flex;align-items:center;gap:10px;padding:8px 12px;border:2px solid var(--ink);border-radius:var(--r);background:#fffdf8;flex-wrap:wrap}
.roll-trait.t-brave{background:#f6e3e1}.roll-trait.t-clever{background:#f8efcf}.roll-trait.t-kind{background:#e6eee2}
.roll-trait>span>b{font-size:1.25em}
.bonus{font-size:1.4em;font-weight:700;margin-left:auto}
.helpers{display:flex;gap:6px;flex-wrap:wrap;width:100%}
.helper{display:inline-flex;align-items:center;gap:4px;font-size:.88em;background:var(--paper2);border:1.6px solid var(--ink);border-radius:20px;padding:1px 8px 1px 2px}
.help-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn.help-btn{background:var(--sage);font-size:1.15em;min-height:58px;flex:1}
.help-prompt{border:2.2px dashed var(--ink);border-radius:var(--r);padding:10px 12px;background:#fffdf8}
.roll-go{display:flex;flex-direction:column;gap:8px;align-items:center}
.btn.roll-btn{background:var(--rose);animation:nudge 2.4s ease-in-out infinite}
@keyframes nudge{0%,80%,100%{transform:none}86%{transform:rotate(-1.5deg) scale(1.02)}93%{transform:rotate(1.5deg) scale(1.02)}}
.dice-row{display:flex;align-items:center;justify-content:center;gap:14px;padding:6px}
.die{width:64px;height:64px;border:3px solid var(--ink);border-radius:12px 9px 13px 10px;background:#fffdf8;display:grid;grid-template-columns:repeat(3,1fr);
  padding:8px;gap:2px;box-shadow:0 4px 0 var(--ink)}
.die i{border-radius:50%;margin:2px}
.die i.on{background:var(--ink)}
.dice-row.shake .die{animation:shake .35s infinite}
.dice-row.shake .die+.die{animation-delay:.1s}
@keyframes shake{25%{transform:rotate(-12deg) translateY(-5px)}75%{transform:rotate(10deg) translateY(3px)}}
.sum{font-size:1.4em}.sum b{font-size:1.3em}
.outcome{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px;border:2.5px solid var(--ink);border-radius:var(--r);font-size:1.45em;text-align:center}
.o-success{background:var(--sage)}.o-twist{background:var(--butter)}.o-trouble{background:var(--rose)}
.twist{font-family:var(--serif);font-size:1.1em;display:flex;gap:8px;align-items:flex-start;background:#fffdf8;border:2px dashed var(--ink);border-radius:var(--r);padding:8px 10px}
.spark-row .hint{text-align:center;margin:0 0 6px}
.btn.spark{background:#fbf3d8;flex:1}
.guide-box{border:2px solid var(--lavInk);border-radius:var(--r);padding:6px 10px;background:#f1eef6}
.guide-box summary{min-height:44px;display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;color:var(--lavInk)}
.guide-box .row{margin-top:8px}

/* event flip */
.modal.event{background:rgba(42,35,40,.3);perspective:1200px;cursor:pointer}
.modal.event.out{opacity:0;transition:opacity .25s}
.flip{width:min(86vw,380px);aspect-ratio:3/4;max-height:80dvh}
.flip-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;animation:flip .9s .15s cubic-bezier(.4,1.3,.5,1) both}
@keyframes flip{from{transform:rotateY(180deg) scale(.8)}to{transform:rotateY(0)}}
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:3px solid var(--ink);border-radius:16px 12px 18px 13px;
  box-shadow:6px 8px 0 rgba(42,35,40,.3);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center;gap:10px}
.face.back{transform:rotateY(180deg);background:var(--lav) var(--grain)}
.face.front{background:var(--paper2) var(--grain)}
.face.front h2{font-family:var(--title);font-size:1.6em;color:var(--roseInk)}

/* moments */
.moment-card{max-width:620px}
.moment-card .moment-head{padding:12px 14px 0;position:relative}
.moment-card>*:not(.moment-head){margin-left:14px;margin-right:14px}
.moment-head h2{font-family:var(--title);font-size:1.3em;color:var(--roseInk);display:flex;align-items:center;gap:8px;padding-right:90px}
.moment-head .skip{position:absolute;right:12px;top:12px}
.moment-card{overflow-y:auto!important}
.timer-row{display:flex;align-items:center;justify-content:center;gap:10px}
.timer{font-size:2.6em;font-variant-numeric:tabular-nums;min-width:2ch;text-align:center}
.timer.low{color:var(--danger);animation:blink .8s infinite}
.secret-box{background:var(--butter);border:2.5px solid var(--ink);border-radius:var(--r);padding:12px;text-align:center}
.secret{font-size:2em;font-weight:700;margin:4px 0;line-height:1.15}
.peek{min-height:72px;width:100%;border:2.5px dashed var(--ink);border-radius:var(--r);background:#fffdf8;font-size:1.1em;user-select:none;-webkit-user-select:none;touch-action:none}
.draw-canvas{width:100%;max-width:440px;aspect-ratio:1;align-self:center;border:2.5px solid var(--ink);border-radius:var(--r);background:#f7f3ec;touch-action:none;display:block}
.inks{gap:8px;flex-wrap:wrap}
.choice-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}

/* ending */
.ending .card{max-width:620px}
.end-stats{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.stat{display:flex;align-items:center;gap:10px;padding:6px 10px;border:2px dashed rgba(42,35,40,.4);border-radius:var(--r);color:var(--mute)}
.stat.yes{border-style:solid;border-color:var(--ink);background:#eef3e9;color:var(--ink);font-weight:700}
.end-heroes{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}
.end-hero{display:flex;flex-direction:column;align-items:center;font-size:.9em;gap:2px}
.recap h3{font-family:var(--title);font-size:1em;color:var(--roseInk);margin:8px 0 4px}
.recap ol{margin:0;padding-left:1.3em;font-family:var(--serif);font-size:1em;display:flex;flex-direction:column;gap:3px}

/* drawers */
.drawer{position:fixed;top:0;bottom:0;right:0;width:min(94vw,400px);z-index:50;background:var(--paper2) var(--grain);border-left:2.5px solid var(--ink);
  box-shadow:-6px 0 0 rgba(42,35,40,.15);display:flex;flex-direction:column;transform:translateX(105%);transition:transform .22s ease;
  padding:var(--sat) var(--sar) var(--sab) 0}
.drawer.open{transform:none}
.drawer-body{flex:1;overflow-y:auto;padding:6px 14px 18px;display:flex;flex-direction:column;gap:10px}
.drawer h3{font-size:1em;margin-top:6px;display:flex;align-items:center;gap:6px}
.guide-panel section{display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1.6px dashed rgba(42,35,40,.25)}
.g-row{display:flex;align-items:center;gap:6px}
.g-row.calmed{opacity:.55}
.g-name{flex:1;display:flex;flex-direction:column;min-width:0}
.g-name small{color:var(--mute);font-size:.8em}
.pm{display:flex;align-items:center;gap:6px}
.pm-label{flex:1}
.pm-val{min-width:3.2ch;text-align:center}

/* banners & toasts */
.banners{position:fixed;top:calc(var(--sat) + 4px);left:50%;transform:translateX(-50%);z-index:80;display:flex;flex-direction:column;gap:6px;width:min(94vw,460px);pointer-events:none}
.banner{pointer-events:auto;min-height:44px;padding:8px 14px;border:2.2px solid var(--ink);border-radius:var(--r);background:var(--paper2);text-align:center;font-family:var(--hand);font-size:1em;box-shadow:0 3px 0 var(--ink)}
.banner.good{background:var(--sage);cursor:pointer;font-weight:700}
.banner.warn{background:var(--butter)}
.toasts{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--sab) + 50dvh);z-index:90;display:flex;flex-direction:column;gap:6px;width:min(92vw,440px);pointer-events:none;align-items:center}
body[data-screen=home] .toasts,body[data-screen=lobby] .toasts{bottom:calc(var(--sab) + 110px)}
.toast{pointer-events:auto;padding:10px 16px;border:2.2px solid var(--ink);border-radius:var(--r);background:var(--paper2);box-shadow:0 3px 0 var(--ink);font-size:1em;
  animation:pop .2s;transition:opacity .4s,transform .4s;text-align:center}
.toast.error{background:#f6e0de}.toast.good{background:#e6eee2}
.toast.out{opacity:0;transform:translateY(8px)}

/* scanner */
.scan-box{position:relative;border:2.5px solid var(--ink);border-radius:var(--r);overflow:hidden;background:#000;aspect-ratio:1}
.scan-video{width:100%;height:100%;object-fit:cover;display:block}
.scan-frame{position:absolute;inset:18%;border:4px dashed var(--paper2);border-radius:14px}

/* tablet / desktop */
@media (min-width:760px){
  html,body{font-size:19px}
  .sheet{left:auto;right:calc(var(--sar) + 14px);bottom:14px;border-bottom:2.5px solid var(--ink);border-radius:var(--r);width:420px;max-height:calc(100dvh - 180px)}
  .sheet.expanded{max-height:calc(100dvh - 180px)}
  .toasts{bottom:24px}
  .modal.roll{align-items:center}
}
@media (max-height:640px){.hero-art{min-height:38vh}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`;

export function injectStyles() {
  if (document.getElementById('sb-ui-css')) return;
  const st = document.createElement('style');
  st.id = 'sb-ui-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}
