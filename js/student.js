// Student (phone) side of Class Poll Bonanza.
// Reads: one listener on the game doc (1 read per state change), one image read per heatmap
// question, plus an occasional catch-up read when the connection looks stuck.
// Writes: the player doc, and one answer doc per question (updated if the student changes it).
import {
  F, db, auth, $, esc, showView, toast, confetti, brandHTML, SHAPES, CHOICE_NAMES,
  heatOvals, heatHits, answerPins, fmtPts
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
const CLOCK_KEY = 'cpb:clockOffset';
const storeKey = () => `cpb:g:${code}:${uid}`;
function loadJSON(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
const freshStore = () => ({ joined: false, ans: {}, seen: {}, res: {}, ack: {} });
let store = freshStore();
const saveStore = () => saveJSON(storeKey(), store);
const total = () => Object.values(store.res).reduce((a, b) => a + b, 0);

const pending = new Map();      // question index -> latest in-flight answer write
const writeSeq = new Map();     // question index -> number of the latest write
const resultsSeen = new Set();  // questions whose results have reached this phone
// Must match the teacher's rule in closeQuestion(): answers later than timer + 2.5 s don't count.
const GRACE_MS = 2500;
const AUTO_SUBMIT_LEAD_MS = 600;  // send an unsent heatmap answer just before time runs out
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Server clock ----------
   Every phone counts down to the same moment the teacher's laptop does: the question's server
   start time plus its timer. clockOffset = server time - this phone's time. */
let clockOffset = loadJSON(CLOCK_KEY, null);
const serverNow = () => Date.now() + (clockOffset ?? 0);

async function syncClock() {
  try {
    const ref = F.doc(db, 'games', code, 'players', uid);
    const t0 = Date.now();
    await F.updateDoc(ref, { joinedAt: F.serverTimestamp() });
    const t1 = Date.now();
    const snap = await F.getDocFromServer(ref);
    const srv = snap.data()?.joinedAt?.toMillis?.();
    if (srv) { clockOffset = Math.round(srv - (t0 + t1) / 2); saveJSON(CLOCK_KEY, clockOffset); }
  } catch (e) { console.warn('Clock sync skipped', e); }
}

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
  store = { ...freshStore(), ...loadJSON(storeKey(), {}) };
  try { localStorage.setItem(LAST_CODE_KEY, code); } catch { /* private mode */ }
  showView('loading');
  listen(true);
  if (store.joined) syncClock().then(() => { lastRendered = ''; render(); });
}

/* ---------- Live connection ---------- */
let lastSnapAt = Date.now();
function listen(isFirst = false) {
  if (unsub) unsub();
  let first = isFirst;
  unsub = F.onSnapshot(F.doc(db, 'games', code), { includeMetadataChanges: true }, snap => {
    lastSnapAt = Date.now();
    setConn(!snap.metadata.fromCache);
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return;  // not sure yet; wait for the server
      oops('Game not found', `There's no game with code ${code}. Double-check the code on the screen.`,
        'Enter a different code', () => { code = ''; if (unsub) unsub(); showView('code'); });
      return;
    }
    game = snap.data();
    if (first) {
      first = false;
      if (!store.joined) { showProfile(); return; }
    }
    if (store.joined && !profileOpen) render();
  }, err => {
    console.error(err);
    oops('Connection hiccup', 'We lost the connection to the game. Tap to reconnect. Your points are safe.');
  });
}

function setConn(ok) { $('#conn').classList.toggle('hidden', ok || !store.joined); }

/* If the phone slept, switched apps or lost signal, fetch the latest state directly from the
   server instead of waiting for the live connection to recover on its own. */
let resyncing = false, lastResync = 0;
async function resync() {
  if (!code || !uid || !store.joined || resyncing) return;
  resyncing = true; lastResync = Date.now();
  try {
    const snap = await F.getDocFromServer(F.doc(db, 'games', code));
    if (snap.exists()) {
      const fresh = snap.data();
      const stale = !game || fresh.status !== game.status || fresh.q?.idx !== game.q?.idx
        || fresh.q?.startAt?.toMillis?.() !== game.q?.startAt?.toMillis?.();
      game = fresh;
      lastSnapAt = Date.now();
      setConn(true);
      if (stale) listen();   // the live connection had fallen behind: restart it
      if (!profileOpen) render();
    }
  } catch (e) { console.warn('Resync failed', e); }
  finally { resyncing = false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  keepAwake();
  resync();
});
window.addEventListener('online', resync);
window.addEventListener('pageshow', e => { if (e.persisted) resync(); });
// Watchdog: no news for 45 s while the page is open? Double-check with the server.
setInterval(() => {
  if (!document.hidden && Date.now() - lastSnapAt > 45000 && Date.now() - lastResync > 45000) resync();
}, 5000);

/* Keep the screen on during the game so the phone doesn't sleep and drop the connection. */
let wakeLock = null;
async function keepAwake() {
  if (!store.joined || !('wakeLock' in navigator) || document.hidden) return;
  try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}

/* ---------- Profile (join, or fix a misspelled name / ID at any time) ---------- */
let profileOpen = false;
function showProfile() {
  const p = loadJSON(PROFILE_KEY, {});
  $('#first').value = p.first || '';
  $('#last').value = p.last || '';
  $('#sid').value = p.sid || '';
  $('#profileErr').classList.add('hidden');
  $('#profileTitle').textContent = store.joined ? 'Fix your name or ID' : 'Who are you?';
  $('#profileSubmit').textContent = store.joined ? 'Save changes ✓' : 'I\'m ready! 🎉';
  $('#profileCancel').classList.toggle('hidden', !store.joined);
  profileOpen = true;
  showView('profile');
}
function closeProfile() { profileOpen = false; lastRendered = ''; render(); }

$('#changeMe').addEventListener('click', e => { e.preventDefault(); showProfile(); });
$('#me').addEventListener('click', () => { if (store.joined) showProfile(); });
$('#profileCancel').addEventListener('click', closeProfile);

$('#profileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const first = clean($('#first').value), last = clean($('#last').value), sid = clean($('#sid').value);
  const err = msg => { const el = $('#profileErr'); el.textContent = msg; el.classList.remove('hidden'); $('#profileForm').classList.add('shake'); setTimeout(() => $('#profileForm').classList.remove('shake'), 500); };
  if (!first || !last) return err('Please enter both your first and last name.');
  if (first.length < 2 && last.length < 2) return err('Please use your full real name.');
  if (!sid) return err('Please enter your Student ID.');
  const btn = $('#profileSubmit');
  btn.disabled = true;
  const wasJoined = store.joined;
  try {
    await F.setDoc(F.doc(db, 'games', code, 'players', uid), {
      name: `${first} ${last}`, studentId: sid, joinedAt: F.serverTimestamp()
    });
    saveJSON(PROFILE_KEY, { first, last, sid });
    store.joined = true; saveStore();
    if (wasJoined) toast(`Saved! You're ${first} ${last} (ID ${sid}).`);
    else { confetti(60); keepAwake(); syncClock(); }
    closeProfile();
  } catch (ex) {
    console.error(ex);
    err('Couldn\'t save. Check your connection and try again.');
  } finally { btn.disabled = false; }
});

/* ---------- Rendering the game state ---------- */
let lastRendered = '';
function render() {
  updateMe();
  if (!game || profileOpen) return;
  const s = game.status;
  const q = game.q;
  const key = `${s}:${q ? q.idx : ''}:${q?.startAt?.toMillis?.() ?? ''}`;
  if (key === lastRendered) {
    // Same screen (e.g. the teacher added time): just refresh the countdown.
    if (s === 'question' && q && currentQ) { currentQ = q; startTimer(q); }
    else if (s === 'question' && q && remainingMs(q) > 0) { lastRendered = ''; render(); }  // time added after time-up
    return;
  }
  lastRendered = key;
  stopTimer();
  currentQ = null;

  if (s === 'lobby') {
    const p = loadJSON(PROFILE_KEY, {});
    $('#lobbyName').textContent = `${p.first} ${p.last}`;
    showView('lobby');
  } else if (s === 'question' && q) {
    if (remainingMs(q) <= 0) showTimeUp(q);
    else if (q.type === 'heat') showHeat(q);
    else showMC(q);
  } else if (s === 'reveal' && game.reveal) {
    showResult();
  } else if (s === 'ended') {
    showEnded();
  }
}

/** Time left on this question, measured against the server clock (same deadline as the teacher). */
function remainingMs(q) {
  const totalMs = q.time * 1000;
  const start = q.startAt?.toMillis?.();
  if (clockOffset != null && start) return Math.min(totalMs, start + totalMs - serverNow());
  // Fallback before the clock is synced: count from when this phone first saw the question.
  const k = `${q.idx}@${start ?? ''}`;
  if (store.seen[k] == null) { store.seen[k] = Date.now(); saveStore(); }
  return totalMs - (Date.now() - store.seen[k]);
}

let currentQ = null;
function startTimer(q) {
  stopTimer();
  const fillEl = q.type === 'heat' ? $('#heatTimer') : $('#mcTimer');
  const totalMs = q.time * 1000;
  let autoSent = false;
  const tick = () => {
    const rem = remainingMs(q);
    const f = Math.max(0, Math.min(1, rem / totalMs));
    fillEl.style.transform = `scaleX(${f})`;
    fillEl.style.backgroundPosition = `${f * 100}% 0`;
    if (!autoSent && rem <= AUTO_SUBMIT_LEAD_MS) { autoSent = true; autoSubmit(q); }
    if (rem <= 0) { timerRaf = null; showTimeUp(q); return; }
    timerRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopTimer() { if (timerRaf) cancelAnimationFrame(timerRaf); timerRaf = null; }

function showTimeUp(q) {
  currentQ = null;
  const a = store.ans[q.idx];
  $('#lockedEmoji').textContent = '⏰';
  $('#lockedTitle').textContent = 'Time\'s up!';
  $('#lockedSub').textContent = a ? 'Your answer is locked in. Results are coming up on the big screen…'
    : 'No answer this time. Results are coming up on the big screen…';
  showView('locked');
}

function qLabel(q) { return `Question ${q.idx + 1} of ${game.qCount}`; }

/* Multiple choice: tap to answer; tap another to change it until time runs out. */
function showMC(q) {
  currentQ = q;
  $('#mcNum').textContent = qLabel(q);
  $('#mcPrompt').textContent = q.prompt || '';
  const box = $('#mcChoices');
  box.className = 'choices' + (q.choices.length === 4 ? ' four' : '');
  box.innerHTML = q.choices.map((c, i) =>
    `<button class="btn choice c${i} pop" style="--i:${i}" data-i="${i}" aria-label="${CHOICE_NAMES[i]}: ${esc(c)}">${SHAPES[i]}<span>${esc(c)}</span></button>`
  ).join('');
  const mark = () => {
    const a = store.ans[q.idx];
    box.classList.toggle('done', !!a);
    box.querySelectorAll('.choice').forEach(b => b.classList.toggle('chosen', a?.choice === Number(b.dataset.i)));
    $('#mcStatus').textContent = a ? '✓ Answer sent! Tap a different one to change it.' : '';
  };
  box.querySelectorAll('.choice').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.i);
    if (remainingMs(q) <= 0 || store.ans[q.idx]?.choice === i) return;
    submit(q, { choice: i }).then(mark);
    mark();
  }));
  mark();
  showView('mc');
  startTimer(q);
}

/* Heatmap: one pin, or two for a two-dot question. Pins can be moved and re-sent until time
   runs out; whatever is on the image when time runs out is sent automatically. */
let pins = [];
let pinsDirty = false;
function placePinEl(el, p) {
  el.style.left = `${p.x * 100}%`; el.style.top = `${p.y * 100}%`;
  el.classList.remove('hidden');
  const s = el.firstElementChild;
  s.style.animation = 'none'; void s.offsetWidth; s.style.animation = '';
}
const pinsPayload = need => (need === 1 && pins.length === 1 ? pins[0] : { x: pins.map(p => p.x), y: pins.map(p => p.y) });

async function showHeat(q) {
  currentQ = q;
  const need = q.dots === 2 ? 2 : 1;
  $('#heatNum').textContent = qLabel(q);
  $('#heatPrompt').textContent = q.prompt || '';
  $('#heatHint').textContent = need === 2
    ? 'Drop 2 pins: tap two spots. Tap again to move the closer pin.'
    : 'Tap the picture to drop your pin. Tap again to move it.';
  // Restore a previously sent answer (e.g. after a refresh or a re-opened question).
  pins = answerPins(store.ans[q.idx]).map(([x, y]) => ({ x, y }));
  pinsDirty = false;
  $('#heatPin').classList.add('hidden');
  $('#heatPin2').classList.add('hidden');
  pins.forEach((p, i) => placePinEl(i === 0 ? $('#heatPin') : $('#heatPin2'), p));
  const refresh = () => {
    const sent = !!store.ans[q.idx];
    const btn = $('#heatSubmit');
    btn.disabled = pins.length < need || (sent && !pinsDirty);
    btn.textContent = sent && !pinsDirty ? '✓ Sent! Move a pin to change it'
      : sent ? 'Send my new answer 📍' : need === 2 ? 'Lock in both pins 📍📍' : 'Lock it in 📍';
    $('#heatReset').classList.toggle('hidden', need < 2 || !pins.length);
  };
  refresh();
  $('#heatLoading').classList.remove('hidden');
  showView('heat');
  startTimer(q);
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
    if (remainingMs(q) <= 0) return;
    const r = $('#heatImg').getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const p = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    let slot = pins.length;
    if (slot >= need) {
      // All pins placed: move whichever is closer to the tap.
      const d = pp => (pp.x - p.x) ** 2 + (pp.y - p.y) ** 2;
      slot = need === 1 ? 0 : (d(pins[0]) <= d(pins[1]) ? 0 : 1);
    }
    pins[slot] = p;
    pinsDirty = true;
    placePinEl(slot === 0 ? $('#heatPin') : $('#heatPin2'), p);
    refresh();
    navigator.vibrate?.(15);
  };
  $('#heatReset').onclick = ev => {
    ev.stopPropagation();
    pins = []; pinsDirty = true;
    $('#heatPin').classList.add('hidden'); $('#heatPin2').classList.add('hidden');
    refresh();
  };
  $('#heatSubmit').onclick = async () => {
    if (pins.length < need) return;
    pinsDirty = false; refresh();
    await submit(q, pinsPayload(need));
    refresh();
  };
}

/* Time is nearly up: send whatever is on screen if it hasn't been sent yet. */
function autoSubmit(q) {
  if (currentQ?.idx !== q.idx || q.type !== 'heat') return;  // multiple choice sends on every tap
  if (!pinsDirty || !pins.length) return;
  pinsDirty = false;
  submit(q, pinsPayload(q.dots === 2 ? 2 : 1));
}

/* Send (or re-send) this question's answer, stamped with server time. */
async function submit(q, payload) {
  const idx = q.idx;
  const prev = store.ans[idx];
  store.ans[idx] = payload;
  store.ack[idx] = false;
  saveStore();
  navigator.vibrate?.(25);
  const seq = (writeSeq.get(idx) || 0) + 1;
  writeSeq.set(idx, seq);
  const write = F.setDoc(F.doc(db, 'games', code, 'answers', `${idx}_${uid}`), {
    uid, q: idx, ...payload, at: F.serverTimestamp()
  });
  pending.set(idx, write);
  try {
    await write;
    if (writeSeq.get(idx) !== seq) return;   // a newer change superseded this one
    // true = the server confirmed before results came out; 'later' = confirmed after (needs a time check).
    store.ack[idx] = resultsSeen.has(idx) ? 'later' : true; saveStore();
  } catch (e) {
    if (writeSeq.get(idx) !== seq) return;
    console.error(e);
    if (e.code === 'permission-denied' && prev) {
      // Changing answers isn't allowed by the published rules: the first answer stands.
      store.ans[idx] = prev; store.ack[idx] = true; saveStore();
      toast('Couldn\'t change your answer. Your first answer still counts.');
    } else if (e.code === 'permission-denied') {
      store.ack[idx] = true; saveStore();   // an answer already exists (e.g. another tab)
    } else {
      if (prev) store.ans[idx] = prev; else delete store.ans[idx];
      store.ack[idx] = !!prev; saveStore();
      toast('Answer didn\'t send. Try again!');
    }
    if (currentQ?.idx === idx) { lastRendered = ''; render(); }
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
  // Same scoring as the teacher: each heatmap oval that gets a pin earns its share of accuracy points.
  const ovals = rv.oval ? heatOvals(rv) : [];
  let share = 0;
  if (a) share = rv.oval ? heatHits(a, ovals) / ovals.length : ((rv.correct || []).includes(a.choice) ? 1 : 0);
  const correct = share === 1, partial = share > 0 && share < 1;
  const earned = a ? pts.part + pts.acc * share : 0;
  store.res[idx] = earned; saveStore();   // re-opened questions overwrite the earlier result
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
  } else if (partial) {
    v.classList.add('good'); v.classList.remove('bad');
    $('#resEmoji').textContent = '👍';
    $('#resTitle').textContent = 'Half right!';
    $('#resPts').textContent = `+${fmtPts(earned)}`;
    $('#resDetail').textContent = 'One of your two pins landed in a right spot. Both right spots are circled on the big screen.';
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
