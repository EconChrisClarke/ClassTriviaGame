// Shared helpers: Firebase setup, DOM helpers, animations, confetti, logo.
import * as F from './vendor/firebase.js';
import { firebaseConfig } from './config.js';

export { F };

// ?emu=1 on localhost points the site at the local Firebase emulator (testing only).
const params = new URLSearchParams(location.search);
export const USE_EMU = params.has('emu') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

export const app = F.initializeApp(firebaseConfig);
export const db = F.getFirestore(app);
export const auth = F.getAuth(app);
if (USE_EMU) {
  F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  F.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

/* ---------- DOM ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Show one view (section[data-view]) and pop its children in. */
export function showView(name) {
  $$('[data-view]').forEach(v => v.classList.toggle('hidden', v.dataset.view !== name));
  const v = $(`[data-view="${name}"]`);
  if (v) popIn(v);
  window.scrollTo({ top: 0 });
  return v;
}

/** Re-trigger the staggered pop-in on every .pop element inside root. */
export function popIn(root) {
  $$('.pop', root).forEach((el, i) => {
    if (!el.style.getPropertyValue('--i')) el.style.setProperty('--i', i);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });
}

/* Every .btn springs when released. Delegated, so new buttons get it free. */
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.btn');
  if (b && !b.disabled) { b.classList.remove('boing'); b.classList.add('pressed'); }
});
document.addEventListener('pointerup', () => {
  $$('.btn.pressed').forEach(b => {
    b.classList.remove('pressed');
    void b.offsetWidth;
    b.classList.add('boing');
  });
});
document.addEventListener('animationend', e => {
  if (e.animationName === 'boing') e.target.classList.remove('boing');
});

let toastTimer;
export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Brand ---------- */
// The EconChrisClarke mark: red square, white axes, steep supply and shallow demand.
export const LOGO_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="#C71E1D"/>
  <path d="M21.5 10.5V84.5H90.5" fill="none" stroke="#fff" stroke-width="9.5"/>
  <path d="M30 82L80 14M24 26L88 70" fill="none" stroke="#fff" stroke-width="9.5" stroke-linecap="round"/>
</svg>`;

export function brandHTML(title = 'Class Poll Bonanza') {
  return `<span class="brand">${LOGO_SVG}<span><span class="name">${esc(title)}</span><br>
    <span class="ecc">ECON CHRIS CLARKE</span></span></span>`;
}

/* ---------- Choice shapes (triangle, diamond, circle, square) ---------- */
export const SHAPES = [
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 3 22 20H2z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'
];
export const CHOICE_NAMES = ['Triangle', 'Diamond', 'Circle', 'Square'];

/* ---------- Scoring helpers ---------- */
export function inOval(x, y, o) {
  if (!o || !o.rx || !o.ry) return false;
  const dx = (x - o.cx) / o.rx, dy = (y - o.cy) / o.ry;
  return dx * dx + dy * dy <= 1;
}
/** The correct ovals of a heatmap question: one, or two for a two-dot question. */
export function heatOvals(q) {
  return (q?.dots === 2 ? [q.oval, q.oval2] : [q?.oval]).filter(Boolean);
}
/** The pins in an answer: {x, y} for one dot, or {x: [x1, x2], y: [y1, y2]} for two. */
export function answerPins(a) {
  if (!a || a.x == null) return [];
  return Array.isArray(a.x) ? a.x.map((x, i) => [x, a.y[i]]) : [[a.x, a.y]];
}
/** How many ovals got a pin, matching pins to ovals in whichever order scores best (any order). */
export function heatHits(a, ovals) {
  const pins = answerPins(a);
  if (!pins.length || !ovals.length) return 0;
  const hit = (p, o) => (p && o && inOval(p[0], p[1], o) ? 1 : 0);
  if (ovals.length === 1) return pins.some(p => hit(p, ovals[0])) ? 1 : 0;
  const [p0, p1] = pins, [o0, o1] = ovals;
  return Math.max(hit(p0, o0) + hit(p1, o1), hit(p0, o1) + hit(p1, o0));
}
export function fmtPts(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}

/* ---------- Confetti ---------- */
export function confetti(count = 120) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let c = $('#confetti');
  if (!c) { c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c); }
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#C71E1D', '#1B3A5C', '#E8A33D', '#2E8B7A', '#7C4A8D'];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * innerWidth * .3,
    y: innerHeight * .35,
    vx: (Math.random() - .5) * 14,
    vy: -Math.random() * 14 - 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - .5) * .4,
    w: 6 + Math.random() * 7, h: 9 + Math.random() * 8,
    col: colors[Math.floor(Math.random() * colors.length)]
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t - start < 3200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}
