// Student (phone) side of Class Poll Bonanza.
// Reads: one listener on the game doc (1 read per state change), plus one image
// read per heatmap question. Writes: one player doc, one answer per question.
import {
  F, db, auth, $, esc, showView, toast, confetti, brandHTML, SHAPES, CHOICE_NAMES, inOval, fmtPts
} from './common.js';

$('#brand').innerHTML = brandHTML();

const params = new URLSearchParams(location.search);
let code = (params.get('g') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
let uid = null;
let game = null;
let unsub = null;
let timerRaf = null;
const imgCache = new Map();

/* ---------- Local memory (survives refresh) ---------- */
const PROFILE_KEY = 'cpb:profile';
const LAST_CODE_KEY = 'cpb:lastCode';
const storeKey = () => `cpb:g:${code}:${uid}`;
function loadJSON(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
let store = { joined: false, ans: {}, seen: {}, res: {}, ack: {} };
const pending = new Map();   // question index -> in-flight answer write
const resultsSeen = new Set(); // questions whose results have reached this phone
// Must match the teacher's rule in closeQuestion(): answers later than timer + 2.5 s don't count.
const GRACE_MS = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const saveStore = () => saveJSON(storeKey(), store);
const total = () => Object.values(store.res).reduce((a, b) => a + b, 0);

function updateMe() {
  const p = loadJSON(PROFILE_KEY, null);
  if (!store.joined || !p) { $('#me').classList.add('hidden'); return; }
  $('#me').classList.remove('hidden');
  $('#meName').textContent = p.first;
  $('#meScore').textContent = `${fmtPts(total())} pts`;
}

function oops(title, msg, btnLabel = 'Try again', action = () => location.reload()) {
  $('#oopsTitle').textContent = title;
  $('#oopsMsg').textContent = msg;
  $('#oopsBtn').textContent = btnLabel;
  $('#oopsBtn').onclick = action;
  showView('oops');
}

/* ---------- Boot ---------- */
F.onAuthStateChanged(auth, async user => {
  if (!user) {
    try { await F.signInAnonymously(auth); }
    catch (e) { oops('Can\'t connect', 'Check your Wi-Fi or data connection, then try again.'); }
    return;
  }
  if (uid === user.uid) return;
  uid = user.uid;
  if (code) startWithCode();
  else {
    // Opened the plain site address: offer the last game this phone joined.
    try { $('#codeInput').value = localStorage.getItem(LAST_CODE_KEY) || ''; } catch { /* ignore */ }
    showView('code');
  }
});

$('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#codeBtn').click(); });
$('#codeBtn').addEventListener('click', () => {
  const c = $('#codeInput').value.trim();
  if (c.length < 4) { $('#codeInput').classList.add('shake'); setTimeout(() => $('#codeInput').classList.remove('shake'), 500); return; }
  code = c;
  history.replaceState(null, '', `?g=${code}${params.has('emu') ? '&emu=1' : ''}`);
  startWithCode();
});

function startWithCode() {
  store = loadJSON(storeKey(), { joined: false, ans: {}, seen: {}, res: {}, ack: {} });
  store.ack = store.ack || {};
  try { localStorage.setItem(LAST_CODE_KEY, code); } catch { /* private mode */ }
  showView('loading');
  if (unsub) unsub();
  let first = true;
  unsub = F.onSnapshot(F.doc(db, 'games', code), snap => {
    if (!snap.exists()) {
      oops('Game not found', `There's no game with code ${code}. Double-check the code on the screen.`,
        'Enter a different code', () => { code = ''; if (unsub) unsub(); showView('code'); });
      return;
    }
    game = snap.data();
    if (first) {
      first = false;
      if (!store.joined) { showProfile(); return; }
    }
    if (store.joined) render();
  }, err => {
    console.error(err);
    oops('Connection hiccup', 'We lost the connection to the game. Tap to reconnect. Your points are safe.');
  });
}

/* ---------- Profile ---------- */
function showProfile() {
  const p = loadJSON(PROFILE_KEY, {});
  $('#first').value = p.first || '';
  $('#last').value = p.last || '';
  $('#sid').value = p.sid || '';
  $('#profileErr').classList.add('hidden');
  showView('profile');
}

$('#changeMe').addEventListener('click', e => { e.preventDefault(); showProfile(); });

$('#profileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const first = clean($('#first').value), last = clean($('#last').value), sid = clean($('#sid').value);
  const err = msg => { const el = $('#profileErr'); el.textContent = msg; el.classList.remove('hidden'); $('#profileForm').classList.add('shake'); setTimeout(() => $('#profileForm').classList.remove('shake'), 500); };
  if (!first || !last) return err('Please enter both your first and last name.');
  if (first.length < 2 && last.length < 2) return err('Please use your full real name.');
  if (!sid) return err('Please enter your Student ID.');
  const btn = e.submitter || $('#profileForm button');
  btn.disabled = true;
  try {
    await F.setDoc(F.doc(db, 'games', code, 'players', uid), {
      name: `${first} ${last}`, studentId: sid, joinedAt: F.serverTimestamp()
    });
    saveJSON(PROFILE_KEY, { first, last, sid });
    store.joined = true; saveStore();
    confetti(60);
    render();
  } catch (ex) {
    console.error(ex);
    err('Couldn\'t join. Check your connection and try again.');
  } finally { btn.disabled = false; }
});

/* ---------- Rendering the game state ---------- */
let lastRendered = '';
function render() {
  updateMe();
  if (!game) return;
  const s = game.status;
  const q = game.q;
  const key = `${s}:${q ? q.idx : ''}:${store.ans[q?.idx] ? 'a' : ''}`;
  if (key === lastRendered) {
    // Same screen (e.g. the teacher added time): just refresh the countdown.
    if (s === 'question' && q && !store.ans[q.idx]) {
      stopTimer();
      startTimer(q, q.type === 'heat' ? $('#heatTimer') : $('#mcTimer'), timeUp(q));
    }
    return;
  }
  lastRendered = key;
  stopTimer();

  if (s === 'lobby') {
    $('#lobbyName').textContent = loadJSON(PROFILE_KEY, {}).first + ' ' + loadJSON(PROFILE_KEY, {}).last;
    showView('lobby');
  } else if (s === 'question' && q) {
    if (store.seen[q.idx] == null) { store.seen[q.idx] = Date.now(); saveStore(); }
    if (store.ans[q.idx]) showLocked('🔒', 'Locked in!', 'Hang tight while everyone else answers…');
    else if (remainingMs(q) <= 0) showLocked('⏰', 'Time\'s up!', 'The answer is coming up on the big screen.');
    else if (q.type === 'heat') showHeat(q);
    else showMC(q);
  } else if (s === 'reveal' && game.reveal) {
    showResult();
  } else if (s === 'ended') {
    showEnded();
  }
}

function remainingMs(q) {
  const seen = store.seen[q.idx] ?? Date.now();
  return q.time * 1000 - (Date.now() - seen);
}

function startTimer(q, fillEl, onDone) {
  const totalMs = q.time * 1000;
  const tick = () => {
    const rem = remainingMs(q);
    const f = Math.max(0, Math.min(1, rem / totalMs));
    fillEl.style.transform = `scaleX(${f})`;
    fillEl.style.backgroundPosition = `${f * 100}% 0`;
    if (rem <= 0) { onDone(); return; }
    timerRaf = requestAnimationFrame(tick);
  };
  tick();
}
const timeUp = q => () => { if (!store.ans[q.idx]) { lastRendered = ''; render(); } };
function stopTimer() { if (timerRaf) cancelAnimationFrame(timerRaf); timerRaf = null; }

function showLocked(emoji, title, sub) {
  $('#lockedEmoji').textContent = emoji;
  $('#lockedTitle').textContent = title;
  $('#lockedSub').textContent = sub;
  showView('locked');
}

function qLabel(q) { return `Question ${q.idx + 1} of ${game.qCount}`; }

/* Multiple choice */
function showMC(q) {
  $('#mcNum').textContent = qLabel(q);
  $('#mcPrompt').textContent = q.prompt || '';
  const box = $('#mcChoices');
  box.className = 'choices' + (q.choices.length === 4 ? ' four' : '');
  box.innerHTML = q.choices.map((c, i) =>
    `<button class="btn choice c${i} pop" style="--i:${i}" data-i="${i}" aria-label="${CHOICE_NAMES[i]}: ${esc(c)}">${SHAPES[i]}<span>${esc(c)}</span></button>`
  ).join('');
  box.querySelectorAll('.choice').forEach(b => b.addEventListener('click', () => {
    if (box.classList.contains('done')) return;
    box.classList.add('done');
    b.classList.add('chosen');
    submit(q, { choice: Number(b.dataset.i) });
  }));
  showView('mc');
  startTimer(q, $('#mcTimer'), timeUp(q));
}

/* Heatmap */
let pin = null;
async function showHeat(q) {
  $('#heatNum').textContent = qLabel(q);
  $('#heatPrompt').textContent = q.prompt || '';
  pin = null;
  $('#heatPin').classList.add('hidden');
  $('#heatSubmit').disabled = true;
  $('#heatLoading').classList.remove('hidden');
  showView('heat');
  startTimer(q, $('#heatTimer'), timeUp(q));
  try {
    let data = imgCache.get(q.imageId);
    if (!data) {
      const snap = await F.getDoc(F.doc(db, 'images', q.imageId));
      data = snap.data()?.data;
      imgCache.set(q.imageId, data);
    }
    $('#heatImg').src = data;
    $('#heatLoading').classList.add('hidden');
  } catch (e) {
    console.error(e);
    toast('Image failed to load. Use the big screen and tap your best guess.');
    $('#heatLoading').classList.add('hidden');
  }
  const wrap = $('#heatWrap');
  wrap.onclick = ev => {
    if (store.ans[q.idx]) return;
    const r = $('#heatImg').getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pin = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    const p = $('#heatPin');
    p.style.left = `${x * 100}%`; p.style.top = `${y * 100}%`;
    p.classList.remove('hidden');
    p.style.animation = 'none'; void p.offsetWidth; p.style.animation = '';
    $('#heatSubmit').disabled = false;
    navigator.vibrate?.(15);
  };
  $('#heatSubmit').onclick = () => { if (pin) submit(q, pin); };
}

/* Submit one answer: create-only, stamped with server time. */
async function submit(q, payload) {
  if (store.ans[q.idx]) return;
  store.ans[q.idx] = payload; saveStore();
  navigator.vibrate?.(25);
  setTimeout(() => { if (game?.status === 'question' && game.q?.idx === q.idx) { lastRendered = ''; render(); } }, 350);
  const write = F.setDoc(F.doc(db, 'games', code, 'answers', `${q.idx}_${uid}`), {
    uid, q: q.idx, ...payload, at: F.serverTimestamp()
  });
  pending.set(q.idx, write);
  try {
    await write;
    // true = the server confirmed before results came out; 'later' = confirmed after (needs a time check).
    store.ack[q.idx] = resultsSeen.has(q.idx) ? 'later' : true; saveStore();
  } catch (e) {
    // permission-denied here means an answer already exists (e.g. two tabs). Keep the first.
    if (e.code === 'permission-denied') { store.ack[q.idx] = true; saveStore(); }
    else {
      console.error(e);
      delete store.ans[q.idx]; saveStore();
      toast('Answer didn\'t send. Try again!');
      lastRendered = ''; render();
    }
  }
}

/* ---------- Results ---------- */
async function arrivedInTime(idx) {
  if (store.ack[idx] === 'late') return false;
  try {
    const snap = await F.getDocFromServer(F.doc(db, 'games', code, 'answers', `${idx}_${uid}`));
    if (!snap.exists()) return false;
    const at = snap.data().at?.toMillis?.();
    const q = game.q;
    const start = q?.idx === idx ? q.startAt?.toMillis?.() : null;
    if (at == null || start == null) return true;
    return at - start <= q.time * 1000 + GRACE_MS;
  } catch (e) {
    console.warn('Could not confirm answer time', e);
    return false;
  }
}

function myRank(list) {
  const i = (list || []).findIndex(t => t.uid === uid && t.pts > 0);  // no badge for 0 points
  return i >= 0 ? i + 1 : 0;
}
const medal = r => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '🏅');

async function showResult() {
  const rv = game.reveal, q = game.q;
  const idx = rv.idx;
  const a0 = store.ans[idx];
  resultsSeen.add(idx);
  let late = false;
  if (a0 && store.ack[idx] !== true) {
    // Results arrived before the server confirmed our answer (weak signal, reconnect, or page reload).
    // Check the server's own timestamp on the answer, using the same cutoff the teacher's laptop uses.
    showView('loading');
    if (pending.has(idx)) await Promise.race([pending.get(idx).catch(() => {}), sleep(4000)]);
    late = !(await arrivedInTime(idx));
    if (game.status !== 'reveal' || game.reveal?.idx !== idx) return;
    store.ack[idx] = late ? 'late' : true; saveStore();
  }
  const a = late ? null : a0;
  const pts = game.pts;
  let correct = false;
  if (a) {
    if (rv.oval) correct = a.x != null && inOval(a.x, a.y, rv.oval);
    else correct = (rv.correct || []).includes(a.choice);
  }
  const earned = a ? pts.part + (correct ? pts.acc : 0) : 0;
  if (store.res[idx] == null && store.seen[idx] != null) { store.res[idx] = earned; saveStore(); }
  const v = $('[data-view="result"]');
  v.classList.toggle('good', correct);
  v.classList.toggle('bad', !correct);
  if (late) {
    v.classList.remove('good'); v.classList.add('bad');
    $('#resEmoji').textContent = '📡';
    $('#resTitle').textContent = 'Didn\'t arrive in time';
    $('#resPts').textContent = '+0';
    $('#resDetail').textContent = 'Your answer reached us after the timer ended (usually a weak signal), so it doesn\'t count. Try switching between Wi-Fi and cellular data.';
  } else if (!a) {
    $('#resEmoji').textContent = '😴';
    $('#resTitle').textContent = 'Missed that one!';
    $('#resPts').textContent = '+0';
    $('#resDetail').textContent = 'Answer the next one to earn participation points.';
  } else if (correct) {
    $('#resEmoji').textContent = ['🎉', '🤩', '🔥', '🙌', '💯'][idx % 5];
    $('#resTitle').textContent = 'Correct!';
    $('#resPts').textContent = `+${fmtPts(earned)}`;
    $('#resDetail').textContent = 'Nailed it.';
  } else {
    $('#resEmoji').textContent = '🙈';
    $('#resTitle').textContent = 'Not quite!';
    $('#resPts').textContent = `+${fmtPts(earned)}`;
    const right = rv.oval ? 'The right spot is circled on the big screen.'
      : `Answer: ${(rv.correct || []).map(i => q?.choices?.[i]).filter(Boolean).join(' or ')}`;
    $('#resDetail').textContent = `You still earned ${fmtPts(pts.part)} for participating. ${right}`;
  }
  const r = myRank(rv.top);
  $('#resRank').classList.toggle('hidden', !r);
  if (r) $('#resRank').textContent = `${medal(r)} You're #${r} on the leaderboard!`;
  $('#resTotal').textContent = fmtPts(total());
  updateMe();
  showView('result');
  if (correct) confetti();
}

function showEnded() {
  const p = loadJSON(PROFILE_KEY, {});
  const r = myRank(game.final?.top);
  $('#endRank').classList.toggle('hidden', !r);
  if (r) $('#endRank').textContent = `${medal(r)} You finished #${r}!`;
  $('#endTotal').textContent = fmtPts(total());
  $('#endWho').textContent = `Recorded for ${p.first} ${p.last} (ID ${p.sid}).`;
  showView('ended');
  if (r && r <= 3) confetti(200);
}

// Re-render on return to the tab (timers may have expired in the background).
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.joined) { lastRendered = ''; render(); } });
