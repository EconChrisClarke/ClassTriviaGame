// Teacher side of Class Poll Bonanza: question editor, hosting, scoring, grade export.
import {
  F, db, auth, USE_EMU, $, $$, esc, showView, popIn, toast, confetti, brandHTML, SHAPES, inOval, fmtPts
} from './common.js';
import qrcode from './vendor/qrcode.mjs';
import { FREE_READS_PER_DAY } from './config.js';

$('#homeLink').innerHTML = brandHTML();
$('#hostBrand').innerHTML = brandHTML();

let user = null;
const DEFAULTS = { part: 0.5, acc: 0.5, time: 20 };
const uidShort = () => Math.random().toString(36).slice(2, 10);

/* ================= Auth ================= */
if (USE_EMU) $('#emuBtn').classList.remove('hidden');

$('#googleBtn').addEventListener('click', async () => {
  try { await F.signInWithPopup(auth, new F.GoogleAuthProvider()); }
  catch (e) { console.error(e); toast(`Sign-in failed: ${e.code || e.message}`); }
});
$('#emuBtn').addEventListener('click', async () => {
  const email = 'teacher@example.com', pw = 'test-password';
  try { await F.signInWithEmailAndPassword(auth, email, pw); }
  catch { await F.createUserWithEmailAndPassword(auth, email, pw); }
});
$('#signOutBtn').addEventListener('click', () => F.signOut(auth));
$('#homeLink').addEventListener('click', e => { e.preventDefault(); if (user) goDash(); });

F.onAuthStateChanged(auth, async u => {
  user = u && !u.isAnonymous ? u : null;
  $('#signOutBtn').classList.toggle('hidden', !user);
  $('#who').textContent = user ? (user.email || '') : '';
  if (!user) { showView('signin'); return; }
  await checkTeacher();
});

async function checkTeacher() {
  showView('loading');
  let ok = false;
  try { ok = (await F.getDoc(F.doc(db, 'teachers', user.uid))).exists(); } catch (e) { console.warn(e); }
  if (!ok) {
    $('#myUid').textContent = user.uid;
    showView('notteacher');
    return;
  }
  const m = location.hash.match(/^#host\/([A-Z0-9]{5})$/);
  if (m) resumeHost(m[1]); else goDash();
}
$('#copyUid').addEventListener('click', () => { navigator.clipboard?.writeText(user.uid); toast('Copied!'); });
$('#recheckBtn').addEventListener('click', checkTeacher);

/* ================= Dashboard ================= */
let quizzes = [];
async function goDash() {
  history.replaceState(null, '', location.pathname + location.search);
  showView('loading');
  const snap = await F.getDocs(F.query(F.collection(db, 'quizzes'), F.where('ownerUid', '==', user.uid)));
  addUsage(snap.size || 1);
  quizzes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  renderQuizList();
  $('#pastList').innerHTML = '';
  showView('dash');
  loadActiveGames();
}

/** Unfinished games get a Resume button at the top of the dashboard (works from any computer). */
async function loadActiveGames() {
  const box = $('#activeList');
  box.innerHTML = '';
  try {
    const snap = await F.getDocs(F.query(F.collection(db, 'games'),
      F.where('ownerUid', '==', user.uid), F.where('active', '==', true)));
    addUsage(snap.size || 1);
    const games = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    box.innerHTML = games.map((g, i) => activeRowHTML(g, i)).join('');
    popIn(box);
  } catch (e) { console.warn('Could not load unfinished games', e); }
}

function gameProgress(g) {
  if (g.status === 'lobby') return 'waiting in the lobby';
  if (g.status === 'question' || g.status === 'reveal') return `on question ${(g.q?.idx ?? 0) + 1} of ${g.qCount}`;
  return g.status;
}

function activeRowHTML(g, i) {
  return `<div class="card pastrow activerow pop" style="--i:${i}">
    <span class="livedot" aria-hidden="true"></span>
    <b class="grow">Game in progress: ${esc(g.title || 'Untitled')}</b>
    <span class="muted small">code ${g.id} · ${gameProgress(g)} · started ${g.createdAt?.toDate?.().toLocaleString() || ''}</span>
    <button class="btn teal sm" data-resume="${g.id}">Resume ▶</button>
    <button class="btn ghost sm" data-dismiss="${g.id}">Dismiss</button>
  </div>`;
}

$('#activeList').addEventListener('click', async e => {
  const r = e.target.closest('[data-resume]');
  if (r) { location.hash = `host/${r.dataset.resume}`; resumeHost(r.dataset.resume); return; }
  const d = e.target.closest('[data-dismiss]');
  if (d) {
    if (!confirm('Hide this unfinished game from the top of your dashboard? Grades so far stay available under Past games.')) return;
    await F.updateDoc(F.doc(db, 'games', d.dataset.dismiss), { active: false });
    d.closest('.activerow').remove();
  }
});

function renderQuizList() {
  const list = $('#quizList');
  if (!quizzes.length) {
    list.innerHTML = `<div class="card empty pop" style="grid-column:1/-1"><div class="emoji float">✏️</div>
      <h3>No question sets yet</h3><p class="muted">Click <b>+ New question set</b> to write your first one.</p></div>`;
    return;
  }
  list.innerHTML = quizzes.map((q, i) => `
    <div class="card quizcard pop" style="--i:${i}">
      <h3>${esc(q.title || 'Untitled set')}</h3>
      <span class="muted small">${q.questions?.length || 0} questions · ${fmtPts(q.settings?.part ?? .5)} + ${fmtPts(q.settings?.acc ?? .5)} pts each</span>
      <div class="row">
        <button class="btn teal sm" data-act="host" data-id="${q.id}">Host ▶</button>
        <button class="btn navy sm" data-act="edit" data-id="${q.id}">Edit</button>
        <button class="btn ghost sm" data-act="dup" data-id="${q.id}">Duplicate</button>
        <button class="btn ghost sm" data-act="del" data-id="${q.id}">Delete</button>
      </div>
    </div>`).join('');
}

$('#quizList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const q = quizzes.find(x => x.id === b.dataset.id);
  if (b.dataset.act === 'edit') openEditor(q);
  if (b.dataset.act === 'host') startHost(q);
  if (b.dataset.act === 'dup') {
    const copy = { ...q, title: `${q.title || 'Untitled'} (copy)`, updatedAt: F.serverTimestamp() };
    delete copy.id;
    await F.addDoc(F.collection(db, 'quizzes'), copy);
    toast('Duplicated!'); goDash();
  }
  if (b.dataset.act === 'del') {
    if (!confirm(`Delete "${q.title || 'Untitled set'}"? Past game grades are kept.`)) return;
    await F.deleteDoc(F.doc(db, 'quizzes', q.id));
    toast('Deleted'); goDash();
  }
});

$('#newQuizBtn').addEventListener('click', async () => {
  const data = {
    ownerUid: user.uid, title: '', settings: { ...DEFAULTS },
    questions: [newQuestion('mc', DEFAULTS.time)], updatedAt: F.serverTimestamp()
  };
  const ref = await F.addDoc(F.collection(db, 'quizzes'), data);
  openEditor({ id: ref.id, ...data });
});

$('#pastBtn').addEventListener('click', async () => {
  const snap = await F.getDocs(F.query(F.collection(db, 'games'), F.where('ownerUid', '==', user.uid)));
  addUsage(snap.size || 1);
  const games = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  $('#pastList').innerHTML = games.length ? games.map((g, i) => `
    <div class="card pastrow pop" style="--i:${i}">
      <b class="grow">${esc(g.title || 'Untitled')}</b>
      <span class="muted small">${g.createdAt?.toDate?.().toLocaleString() || ''} · code ${g.id} · ${g.playerCount ?? '?'} players · ${g.status === 'ended' ? 'finished' : 'not finished'}</span>
      ${g.status !== 'ended' ? `<button class="btn teal sm" data-resume="${g.id}">Resume ▶</button>` : ''}
      <button class="btn navy sm" data-csv="${g.id}">Download grades</button>
    </div>`).join('') : '<p class="muted">No games yet.</p>';
  popIn($('#pastList'));
});
$('#pastList').addEventListener('click', e => {
  const r = e.target.closest('[data-resume]');
  if (r) { location.hash = `host/${r.dataset.resume}`; resumeHost(r.dataset.resume); return; }
  const b = e.target.closest('[data-csv]');
  if (b) downloadCSV(b.dataset.csv);
});

/* ================= Editor ================= */
let quiz = null;
let saveTimer = null;

function newQuestion(type, time) {
  return {
    id: uidShort(), type, prompt: '', time: time || DEFAULTS.time, imageId: null,
    choices: type === 'mc' ? ['', '', '', ''] : [], correct: type === 'mc' ? [0] : [], oval: null
  };
}

function openEditor(q) {
  quiz = JSON.parse(JSON.stringify({ ...q, updatedAt: null }));
  quiz.settings = { ...DEFAULTS, ...(quiz.settings || {}) };
  quiz.questions = quiz.questions || [];
  $('#quizTitle').value = quiz.title || '';
  $('#setPart').value = quiz.settings.part;
  $('#setAcc').value = quiz.settings.acc;
  $('#setTime').value = quiz.settings.time;
  setSaveState('saved');
  renderQuestions();
  showView('edit');
}

function setSaveState(s) {
  const el = $('#saveState');
  el.classList.toggle('dirty', s !== 'saved');
  el.textContent = s === 'saved' ? 'Saved ✓' : s === 'saving' ? 'Saving…' : 'Unsaved changes';
}

function dirty() {
  setSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

async function save() {
  clearTimeout(saveTimer);
  if (!quiz) return;
  setSaveState('saving');
  const { id, ...data } = quiz;
  data.ownerUid = user.uid;
  data.updatedAt = F.serverTimestamp();
  try { await F.setDoc(F.doc(db, 'quizzes', id), data); setSaveState('saved'); }
  catch (e) { console.error(e); setSaveState('dirty'); toast('Save failed. Check your connection.'); }
}

$('#quizTitle').addEventListener('input', e => { quiz.title = e.target.value; dirty(); });
for (const [sel, key] of [['#setPart', 'part'], ['#setAcc', 'acc'], ['#setTime', 'time']]) {
  $(sel).addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    quiz.settings[key] = v;
    dirty();
  });
}
$('#backBtn').addEventListener('click', async () => { await save(); goDash(); });
$('#hostBtn').addEventListener('click', async () => { await save(); startHost(quiz); });
$('#addMC').addEventListener('click', () => { quiz.questions.push(newQuestion('mc', quiz.settings.time)); renderQuestions(true); dirty(); });
$('#addHeat').addEventListener('click', () => { quiz.questions.push(newQuestion('heat', quiz.settings.time)); renderQuestions(true); dirty(); });

const imageCache = new Map();
async function getImage(id) {
  if (!id) return null;
  if (imageCache.has(id)) return imageCache.get(id);
  const snap = await F.getDoc(F.doc(db, 'images', id));
  addUsage(1);
  const data = snap.data()?.data || null;
  imageCache.set(id, data);
  return data;
}

function questionIssues(q) {
  const out = [];
  if (!q.prompt.trim()) out.push('Write the question.');
  if (q.type === 'mc') {
    const filled = q.choices.filter(c => c.trim()).length;
    if (filled < 2) out.push('Fill in at least two answer choices.');
    if (!q.correct.length) out.push('Tick at least one correct answer.');
    if (q.choices.some(c => !c.trim())) out.push('Blank choices are removed when you host.');
  } else {
    if (!q.imageId) out.push('Upload an image.');
    else if (!q.oval) out.push('Drag on the image to draw the correct oval.');
  }
  return out;
}

function renderQuestions(scrollToEnd = false) {
  const list = $('#qList');
  list.innerHTML = quiz.questions.map((q, i) => {
    const isMC = q.type === 'mc';
    const times = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
    if (!times.includes(q.time)) times.push(q.time), times.sort((a, b) => a - b);
    return `
    <div class="card qcard pop" data-i="${i}">
      <div class="qcard-head">
        <span class="qbadge">Q${i + 1}</span>
        <div class="seg" role="group" aria-label="Question type">
          <button data-type="mc" class="${isMC ? 'on' : ''}">Multiple choice</button>
          <button data-type="heat" class="${!isMC ? 'on' : ''}">Heatmap</button>
        </div>
        <label class="row small" style="gap:6px">⏱
          <select class="input" data-f="time" style="width:auto;padding:8px 10px">
            ${times.map(t => `<option value="${t}" ${t === q.time ? 'selected' : ''}>${t} sec</option>`).join('')}
          </select></label>
        <span class="grow"></span>
        <button class="btn ghost sm" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn ghost sm" data-act="down" ${i === quiz.questions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn ghost sm" data-act="dup">Duplicate</button>
        <button class="btn ghost sm" data-act="del">Delete</button>
      </div>
      <div class="qgrid">
        <div>
          <textarea class="input" data-f="prompt" placeholder="${isMC ? 'Type your question…' : 'e.g. Tap the equilibrium point'}" maxlength="400">${esc(q.prompt)}</textarea>
          ${isMC ? `<div class="choiceedit">${q.choices.map((c, ci) => `
            <div class="ce c${ci}">
              ${SHAPES[ci]}
              <input class="input" data-choice="${ci}" value="${esc(c)}" placeholder="Answer ${ci + 1}" maxlength="120">
              <input type="checkbox" class="tick" data-correct="${ci}" ${q.correct.includes(ci) ? 'checked' : ''} title="Correct answer" aria-label="Mark answer ${ci + 1} correct">
              ${q.choices.length > 2 ? `<button class="x" data-rmchoice="${ci}" title="Remove choice" aria-label="Remove choice">✕</button>` : ''}
            </div>`).join('')}
          </div>
          ${q.choices.length < 4 ? '<button class="btn ghost sm" data-act="addchoice" style="margin-top:10px">+ Add choice</button>' : ''}
          <p class="hint">Tick ✓ the correct answer. Tick more than one if several count as correct.</p>` : `
          <div class="ovalwrap" style="margin-top:12px">${q.imageId ? '<div class="dots"><i></i><i></i><i></i></div>' : ''}</div>
          ${q.imageId ? '<p class="hint">Click and drag on the image to draw the correct region. Taps inside the oval count as correct. Drag again to redraw.</p>' : ''}`}
          <p class="hint warn issues">${questionIssues(q).join(' ')}</p>
        </div>
        <div>
          <div class="imgbox">
            ${q.imageId && isMC ? '<div class="dots"><i></i><i></i><i></i></div>' : q.imageId ? '<span class="muted small">Image shown at left ←</span>' : `<span class="muted small">${isMC ? 'Optional image<br>(shown on the projector)' : 'Required: the image students tap on'}</span>`}
          </div>
          <div class="row" style="margin-top:10px">
            <label class="btn sm navy">${q.imageId ? 'Replace image' : 'Upload image'}<input type="file" accept="image/*" data-f="image" hidden></label>
            ${q.imageId ? '<button class="btn ghost sm" data-act="rmimg">Remove</button>' : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('') || '<div class="card empty"><p class="muted">No questions yet. Add one below.</p></div>';

  // Fill images asynchronously.
  $$('.qcard', list).forEach(async card => {
    const q = quiz.questions[+card.dataset.i];
    if (!q.imageId) return;
    const src = await getImage(q.imageId);
    if (!src) return;
    if (q.type === 'mc') {
      $('.imgbox', card).innerHTML = `<img src="${src}" alt="">`;
    } else {
      const wrap = $('.ovalwrap', card);
      wrap.innerHTML = `<div class="ovaleditor"><img src="${src}" alt="" draggable="false">
        <svg viewBox="0 0 1 1" preserveAspectRatio="none"><ellipse class="ov" fill="rgba(46,139,122,.25)" stroke="#2E8B7A" stroke-width="3" vector-effect="non-scaling-stroke" stroke-dasharray="8 5"/></svg></div>`;
      wireOval(wrap.firstElementChild, q, card);
    }
  });
  popIn(list);
  if (scrollToEnd) list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function drawOval(svgEl, o) {
  const e = $('.ov', svgEl);
  if (!o) { e.setAttribute('rx', 0); e.setAttribute('ry', 0); return; }
  e.setAttribute('cx', o.cx); e.setAttribute('cy', o.cy); e.setAttribute('rx', o.rx); e.setAttribute('ry', o.ry);
}

function wireOval(ed, q, card) {
  const svg = $('svg', ed);
  drawOval(svg, q.oval);
  let start = null;
  const pt = ev => {
    const r = ed.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) };
  };
  ed.addEventListener('pointerdown', ev => { ev.preventDefault(); ed.setPointerCapture(ev.pointerId); start = pt(ev); });
  ed.addEventListener('pointermove', ev => {
    if (!start) return;
    const p = pt(ev);
    q.oval = { cx: (start.x + p.x) / 2, cy: (start.y + p.y) / 2, rx: Math.abs(p.x - start.x) / 2, ry: Math.abs(p.y - start.y) / 2 };
    drawOval(svg, q.oval);
  });
  ed.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    if (!q.oval || q.oval.rx < 0.01 || q.oval.ry < 0.01) { q.oval = null; drawOval(svg, null); toast('Drag to draw a bigger oval.'); }
    else {
      for (const k of ['cx', 'cy', 'rx', 'ry']) q.oval[k] = Math.round(q.oval[k] * 10000) / 10000;
    }
    $('.issues', card).textContent = questionIssues(q).join(' ');
    dirty();
  });
}

const qOf = el => quiz.questions[+el.closest('.qcard').dataset.i];

$('#qList').addEventListener('input', e => {
  const t = e.target;
  if (!t.closest('.qcard')) return;
  const q = qOf(t);
  if (t.dataset.f === 'prompt') q.prompt = t.value;
  else if (t.dataset.choice != null) q.choices[+t.dataset.choice] = t.value;
  else return;
  $('.issues', t.closest('.qcard')).textContent = questionIssues(q).join(' ');
  dirty();
});

$('#qList').addEventListener('change', async e => {
  const t = e.target;
  if (!t.closest('.qcard')) return;
  const q = qOf(t);
  if (t.dataset.f === 'time') { q.time = +t.value; dirty(); }
  if (t.dataset.correct != null) {
    const ci = +t.dataset.correct;
    q.correct = t.checked ? [...new Set([...q.correct, ci])].sort() : q.correct.filter(x => x !== ci);
    $('.issues', t.closest('.qcard')).textContent = questionIssues(q).join(' ');
    dirty();
  }
  if (t.dataset.f === 'image' && t.files?.[0]) {
    toast('Uploading image…');
    try {
      const { data, w, h } = await compressImage(t.files[0]);
      const ref = await F.addDoc(F.collection(db, 'images'), { ownerUid: user.uid, data, w, h, createdAt: F.serverTimestamp() });
      imageCache.set(ref.id, data);
      q.imageId = ref.id;
      if (q.type === 'heat') q.oval = null;
      renderQuestions(); dirty();
      toast(`Image added (${Math.round(data.length * 0.75 / 1024)} KB)`);
    } catch (ex) { console.error(ex); toast('Image upload failed. Try a smaller JPG or PNG.'); }
  }
});

$('#qList').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !b.closest('.qcard')) return;
  const i = +b.closest('.qcard').dataset.i;
  const q = quiz.questions[i];
  const qs = quiz.questions;
  if (b.dataset.type && b.dataset.type !== q.type) {
    q.type = b.dataset.type;
    if (q.type === 'mc' && q.choices.length < 2) { q.choices = ['', '', '', '']; q.correct = [0]; }
  } else if (b.dataset.act === 'up' && i > 0) [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]];
  else if (b.dataset.act === 'down' && i < qs.length - 1) [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]];
  else if (b.dataset.act === 'dup') qs.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(q)), id: uidShort() });
  else if (b.dataset.act === 'del') { if (!confirm(`Delete question ${i + 1}?`)) return; qs.splice(i, 1); }
  else if (b.dataset.act === 'addchoice' && q.choices.length < 4) q.choices.push('');
  else if (b.dataset.rmchoice != null) {
    const ci = +b.dataset.rmchoice;
    q.choices.splice(ci, 1);
    q.correct = q.correct.filter(x => x !== ci).map(x => (x > ci ? x - 1 : x));
  } else if (b.dataset.act === 'rmimg') { q.imageId = null; q.oval = null; }
  else return;
  renderQuestions(); dirty();
});

/** Shrink an uploaded image so 200 phones can load it quickly (target ≤ ~140 KB). */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let maxSide = 1400, quality = 0.8, data, w, h;
      const c = document.createElement('canvas');
      for (let attempt = 0; attempt < 8; attempt++) {
        const s = Math.min(1, maxSide / Math.max(img.width, img.height));
        w = Math.round(img.width * s); h = Math.round(img.height * s);
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        data = c.toDataURL('image/jpeg', quality);
        if (data.length < 190000) break;
        if (quality > 0.6) quality -= 0.1; else maxSide = Math.round(maxSide * 0.8);
      }
      URL.revokeObjectURL(img.src);
      resolve({ data, w, h });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ================= Usage gauge ================= */
// A running estimate of today's Firestore reads (free tier: 50,000/day, resets at midnight Pacific).
const dayKey = () => 'cpb:reads:' + new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function addUsage(n) {
  let v = 0;
  try { v = +localStorage.getItem(dayKey()) || 0; localStorage.setItem(dayKey(), v + n); } catch { /* ignore */ }
  const total = v + n;
  const el = $('#usage');
  if (el) {
    el.textContent = `≈ ${total.toLocaleString()} / ${FREE_READS_PER_DAY.toLocaleString()} free reads today`;
    el.classList.toggle('warn', total > FREE_READS_PER_DAY * 0.8);
  }
}

/* ================= Hosting ================= */
let H = null;           // host state
let tick = null;

function hostView(name) {
  $$('#host .hv').forEach(v => v.classList.toggle('on', v.dataset.host === name));
  const v = $(`#host .hv[data-host="${name}"]`);
  popIn(v);
}

function joinUrl(code) {
  const base = location.origin + location.pathname.replace(/teacher\.html$/, '');
  return `${base}?g=${code}${USE_EMU ? '&emu=1' : ''}`;
}

function cleanQuestions(qs) {
  return qs.map(q => {
    if (q.type !== 'mc') return q;
    // Drop blank choices, re-index correct answers.
    const keep = q.choices.map((c, i) => [c.trim(), i]).filter(([c]) => c);
    return { ...q, choices: keep.map(([c]) => c), correct: q.correct.map(ci => keep.findIndex(([, i]) => i === ci)).filter(x => x >= 0) };
  });
}

async function startHost(q) {
  const qs = cleanQuestions(q.questions || []);
  const bad = qs.map((x, i) => [i, questionIssues(x).filter(s => !s.startsWith('Blank'))]).filter(([, iss]) => iss.length);
  if (!qs.length) { toast('Add at least one question first.'); return; }
  if (bad.length) { toast(`Question ${bad[0][0] + 1} isn't finished: ${bad[0][1][0]}`, 4000); if (!quiz || quiz.id !== q.id) openEditor(q); return; }

  // Unique 5-character code (no look-alike letters).
  const AL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  for (let tries = 0; tries < 6; tries++) {
    code = Array.from({ length: 5 }, () => AL[Math.floor(Math.random() * AL.length)]).join('');
    if (!(await F.getDoc(F.doc(db, 'games', code))).exists()) break;
  }
  const settings = { ...DEFAULTS, ...(q.settings || {}) };
  const game = {
    ownerUid: user.uid, quizId: q.id, title: q.title || 'Class Poll Bonanza', createdAt: F.serverTimestamp(),
    status: 'lobby', qCount: qs.length, pts: { part: settings.part, acc: settings.acc },
    q: null, reveal: null, final: null, playerCount: 0, active: true
  };
  await F.setDoc(F.doc(db, 'games', code), game);
  await F.setDoc(F.doc(db, 'games', code, 'private', 'quiz'), { questions: qs, settings });
  const scores = { closed: [], qtimes: {}, players: {} };
  await F.setDoc(F.doc(db, 'games', code, 'private', 'scores'), scores);
  enterHost(code, game, qs, scores);
}

async function resumeHost(code) {
  showView('loading');
  try {
    const [g, pq, sc] = await Promise.all([
      F.getDoc(F.doc(db, 'games', code)),
      F.getDoc(F.doc(db, 'games', code, 'private', 'quiz')),
      F.getDoc(F.doc(db, 'games', code, 'private', 'scores'))
    ]);
    addUsage(3);
    if (!g.exists() || g.data().ownerUid !== user.uid) throw new Error('not found');
    enterHost(code, g.data(), pq.data().questions, sc.data() || { closed: [], qtimes: {}, players: {} });
  } catch (e) { console.error(e); toast('Could not resume that game.'); goDash(); }
}

function enterHost(code, game, questions, scores) {
  H = { code, game, questions, scores, players: new Map(), answers: new Map(), unsubP: null, unsubA: null,
    stateWrites: 0, deadline: 0, startAt: 0, closing: false };
  location.hash = `host/${code}`;
  document.body.style.overflow = 'hidden';
  $('#host').classList.remove('hidden');
  $('#hostCorner').textContent = '';
  $('#joinUrl').textContent = joinUrl(code).replace(/^https?:\/\//, '');
  $('#bigCode').textContent = code;
  const qr = qrcode(0, 'M');
  qr.addData(joinUrl(code));
  qr.make();
  $('#qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  addUsage(0);

  // Live player list. Each join is one read for the teacher.
  H.unsubP = F.onSnapshot(F.collection(db, 'games', code, 'players'), snap => {
    addUsage(snap.docChanges().length);
    const fresh = [];
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') H.players.delete(ch.doc.id);
      else { if (!H.players.has(ch.doc.id)) fresh.push(ch.doc.data().name); H.players.set(ch.doc.id, ch.doc.data()); }
    });
    $('#pCount').textContent = H.players.size;
    $('#startBtn').disabled = H.players.size === 0;
    const b = $('#bubbles');
    if (b.childElementCount === 0) {
      b.innerHTML = [...H.players.values()].slice(-120).map(p => `<span class="bubble">${esc(p.name)}</span>`).join('');
    } else {
      fresh.forEach(n => b.insertAdjacentHTML('afterbegin', `<span class="bubble">${esc(n)}</span>`));
      while (b.childElementCount > 120) b.lastElementChild.remove();
    }
    if (H.game.status === 'question') $('#ansCount').textContent = `${H.answers.size}/${H.players.size}`;
  });

  const s = game.status;
  if (s === 'lobby') hostView('lobby');
  else if (s === 'question') resumeQuestion();
  else if (s === 'reveal') { showReveal(game.reveal.idx); }
  else if (s === 'ended') showFinal();
}

function leaveHost() {
  clearInterval(tick);
  H?.unsubP?.(); H?.unsubA?.();
  H = null;
  document.body.style.overflow = '';
  $('#host').classList.add('hidden');
  goDash();
}
$('#exitHost').addEventListener('click', () => {
  if (H && H.game.status !== 'ended' && !confirm('Leave this game? Students\' answers are saved. You can pick it up again with the Resume button on your dashboard, from any computer.')) return;
  leaveHost();
});
$('#doneBtn').addEventListener('click', leaveHost);

async function setGame(patch) {
  Object.assign(H.game, patch);
  H.stateWrites++;
  await F.updateDoc(F.doc(db, 'games', H.code), patch);
  addUsage(H.players.size);  // every phone re-reads the game doc once
}

$('#startBtn').addEventListener('click', () => openQuestion(0));
$('#nextBtn').addEventListener('click', () => {
  const next = (H.scores.closed.length ? Math.max(...H.scores.closed) : -1) + 1;
  if (next < H.questions.length) openQuestion(next); else endGame();
});

/* ----- One question ----- */
async function openQuestion(idx) {
  const qd = H.questions[idx];
  H.answers = new Map();
  H.closing = false;
  $('#hostCorner').textContent = `Join: ${H.code}`;
  const pub = { idx, type: qd.type, prompt: qd.prompt, time: qd.time, startAt: F.serverTimestamp(),
    choices: qd.type === 'mc' ? qd.choices : [], imageId: qd.type === 'heat' ? qd.imageId : null };
  renderQuestionScreen(qd, idx);
  hostView('question');
  H.deadline = Date.now() + qd.time * 1000;
  runTimer();
  await setGame({ status: 'question', q: pub, reveal: null });
  if (qd.type === 'heat') addUsage(H.players.size);  // phones fetch the image
  const g = await F.getDoc(F.doc(db, 'games', H.code));
  addUsage(1);
  H.game.q = g.data().q;
  H.startAt = g.data().q.startAt.toMillis();
  listenAnswers(idx);
}

function resumeQuestion() {
  const q = H.game.q;
  const qd = H.questions[q.idx];
  H.startAt = q.startAt?.toMillis?.() || Date.now();
  H.deadline = H.startAt + q.time * 1000;
  $('#hostCorner').textContent = `Join: ${H.code}`;
  renderQuestionScreen(qd, q.idx);
  hostView('question');
  runTimer();
  listenAnswers(q.idx);
}

function listenAnswers(idx) {
  H.unsubA?.();
  H.unsubA = F.onSnapshot(F.query(F.collection(db, 'games', H.code, 'answers'), F.where('q', '==', idx)), snap => {
    addUsage(snap.docChanges().length || 1);
    snap.docChanges().forEach(ch => { if (ch.type !== 'removed') H.answers.set(ch.doc.id, ch.doc.data()); });
    $('#ansCount').textContent = `${H.answers.size}/${H.players.size}`;
    if (!H.closing && H.players.size > 0 && H.answers.size >= H.players.size) {
      $('#ringNum').textContent = '✓';
      closeQuestion(600);
    }
  });
}

async function renderQuestionScreen(qd, idx) {
  $('#hQnum').textContent = `Question ${idx + 1} of ${H.questions.length}`;
  $('#hPrompt').textContent = qd.prompt;
  $('#ansCount').textContent = `0/${H.players.size}`;
  const body = $('#hBody');
  body.innerHTML = '';
  const src = await getImage(qd.imageId);
  if (qd.type === 'heat') {
    body.innerHTML = `<div class="heatbig pop"><img src="${src || ''}" alt=""></div>
      <p class="muted center">📱 Tap the spot on your phone!</p>`;
  } else {
    body.innerHTML = `${src ? `<img class="qimg pop" src="${src}" alt="">` : ''}
      <div class="tiles">${qd.choices.map((c, i) => `<div class="tile c${i} pop" style="--i:${i}">${SHAPES[i]}<span>${esc(c)}</span></div>`).join('')}</div>`;
  }
  popIn(body);
}

function runTimer() {
  clearInterval(tick);
  const total = () => H.game.q?.time || 20;
  const step = () => {
    if (!H) return clearInterval(tick);
    const rem = Math.max(0, H.deadline - Date.now());
    const secs = Math.ceil(rem / 1000);
    if (!H.closing) $('#ringNum').textContent = secs;
    $('#ringFg').style.strokeDashoffset = 326.7 * (1 - rem / (total() * 1000));
    $('#ring').classList.toggle('low', secs <= 5 && rem > 0);
    if (rem <= 0 && !H.closing) { $('#ringNum').textContent = '⏰'; closeQuestion(1500); }
  };
  step();
  tick = setInterval(step, 200);
}

$('#addTime').addEventListener('click', async () => {
  if (!H || H.closing || H.game.status !== 'question') return;
  H.deadline += 10000;
  H.game.q = { ...H.game.q, time: H.game.q.time + 10 };
  H.stateWrites++;
  await F.updateDoc(F.doc(db, 'games', H.code), { 'q.time': H.game.q.time });
  addUsage(H.players.size);
});
$('#endNow').addEventListener('click', () => { if (H && !H.closing) closeQuestion(800); });

/* Close: wait a moment for in-flight answers, then score and reveal. */
async function closeQuestion(graceMs) {
  if (H.closing) return;
  H.closing = true;
  clearInterval(tick);
  $('#ring').classList.remove('low');
  await new Promise(r => setTimeout(r, graceMs));
  H.unsubA?.(); H.unsubA = null;

  const q = H.game.q, qd = H.questions[q.idx];
  const idx = q.idx, limitMs = q.time * 1000;
  const sc = H.scores;
  const pts = H.game.pts;
  sc.qtimes[idx] = q.time;
  // Make sure every joined player has a row, even with no answers.
  for (const [uid, p] of H.players) {
    sc.players[uid] = sc.players[uid] || { n: p.name, s: p.studentId, r: {} };
    sc.players[uid].n = p.name; sc.players[uid].s = p.studentId;
  }
  for (const a of H.answers.values()) {
    const at = a.at?.toMillis?.();
    if (at == null) continue;
    const ms = at - H.startAt;
    if (ms > limitMs + 2500) continue;  // too late
    const pl = sc.players[a.uid] = sc.players[a.uid] || { n: '(unknown)', s: '', r: {} };
    const correct = qd.type === 'heat' ? inOval(a.x, a.y, qd.oval) : qd.correct.includes(a.choice);
    const rec = { p: pts.part + (correct ? pts.acc : 0), ms: Math.max(0, Math.min(ms, limitMs)), c: correct ? 1 : 0 };
    if (qd.type === 'heat') { rec.x = a.x; rec.y = a.y; } else rec.ch = a.choice;
    pl.r[idx] = rec;
  }
  if (!sc.closed.includes(idx)) sc.closed.push(idx);

  const ranked = rankPlayers();
  const top = ranked.slice(0, 5).map(p => ({ uid: p.uid, name: p.n, pts: Math.round(p.total * 100) / 100 }));
  const reveal = qd.type === 'heat' ? { idx, oval: qd.oval, correct: null, top } : { idx, correct: qd.correct, oval: null, top };
  await Promise.all([
    setGame({ status: 'reveal', reveal, playerCount: Object.keys(sc.players).length }),
    F.setDoc(F.doc(db, 'games', H.code, 'private', 'scores'), sc)
  ]);
  showReveal(idx);
}

/** Rank by total points, then by total answer time (missed questions count as the full timer). */
function rankPlayers() {
  const sc = H.scores;
  return Object.entries(sc.players).map(([uid, p]) => {
    let total = 0, time = 0, nc = 0;
    for (const qi of sc.closed) {
      const r = p.r[qi];
      if (r) { total += r.p; time += r.ms; nc += r.c; } else time += (sc.qtimes[qi] || 20) * 1000;
    }
    return { uid, n: p.n, s: p.s, total, time, nc };
  }).sort((a, b) => b.total - a.total || a.time - b.time);
}

function showReveal(idx) {
  const qd = H.questions[idx];
  const sc = H.scores;
  const recs = Object.values(sc.players).map(p => p.r[idx]).filter(Boolean);
  $('#hostCorner').textContent = `Join: ${H.code}`;
  $('#rQnum').textContent = `Question ${idx + 1} of ${H.questions.length}`;
  $('#rPrompt').textContent = qd.prompt;
  const nRight = recs.filter(r => r.c).length;
  $('#rStat').textContent = `${nRight} of ${recs.length} correct (${recs.length ? Math.round(100 * nRight / recs.length) : 0}%)`;
  const body = $('#rBody');
  if (qd.type === 'heat') {
    body.innerHTML = `<div class="heatbig pop"><img alt=""><canvas></canvas></div>`;
    getImage(qd.imageId).then(src => {
      const img = $('img', body);
      img.onload = () => drawHeat($('canvas', body), img, recs, qd.oval);
      img.src = src;
    });
  } else {
    const counts = qd.choices.map((_, i) => recs.filter(r => r.ch === i).length);
    const max = Math.max(1, ...counts);
    body.innerHTML = `<div class="tiles">${qd.choices.map((c, i) => `
      <div class="tile c${i} pop ${qd.correct.includes(i) ? 'right' : 'wrong'}" style="--i:${i}">
        <div class="bar" data-w="${(100 * counts[i] / max).toFixed(1)}"></div>
        ${SHAPES[i]}<span>${esc(c)}</span><span class="count">${counts[i]}</span>
      </div>`).join('')}</div>`;
    setTimeout(() => $$('.bar', body).forEach(b => { b.style.width = b.dataset.w + '%'; }), 120);
  }
  const last = idx >= H.questions.length - 1;
  $('#nextBtn').textContent = last ? 'Final results 🏁' : 'Next question ▶';
  hostView('reveal');
  if (recs.length && nRight / recs.length >= 0.8) confetti(90);
}

/** Heat overlay: blur every tap into a density field, colour it, then outline the correct oval. */
function drawHeat(canvas, img, recs, oval) {
  const W = img.naturalWidth, Hh = img.naturalHeight;
  const scale = Math.min(1, 900 / Math.max(W, Hh));
  const w = Math.round(W * scale), h = Math.round(Hh * scale);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const off = document.createElement('canvas'); off.width = w; off.height = h;
  const o = off.getContext('2d');
  const rad = Math.max(14, Math.round(Math.min(w, h) * 0.06));
  for (const r of recs) {
    if (r.x == null) continue;
    const x = r.x * w, y = r.y * h;
    const g = o.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const px = o.getImageData(0, 0, w, h);
  const d = px.data;
  const ramp = [[46, 139, 122], [232, 163, 61], [199, 30, 29]];
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a < 0.02) { d[i + 3] = 0; continue; }
    const t = Math.min(1, a * 1.6);
    const seg = t < 0.5 ? 0 : 1, f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const c0 = ramp[seg], c1 = ramp[seg + 1];
    d[i] = c0[0] + (c1[0] - c0[0]) * f; d[i + 1] = c0[1] + (c1[1] - c0[1]) * f; d[i + 2] = c0[2] + (c1[2] - c0[2]) * f;
    d[i + 3] = Math.round(Math.min(0.85, 0.25 + t * 0.7) * 255);
  }
  ctx.putImageData(px, 0, 0);
  if (oval) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(oval.cx * w, oval.cy * h, oval.rx * w, oval.ry * h, 0, 0, Math.PI * 2);
    ctx.lineWidth = 7; ctx.strokeStyle = '#111827'; ctx.stroke();
    ctx.lineWidth = 4; ctx.setLineDash([12, 8]); ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
  }
}

$('#toBoard').addEventListener('click', () => {
  const ranked = rankPlayers();
  const idx = H.game.reveal?.idx ?? Math.max(...H.scores.closed);
  $('#boardSub').textContent = `After ${H.scores.closed.length} of ${H.questions.length} questions · ${ranked.length} players`;
  $('#boardList').innerHTML = ranked.slice(0, 10).map((p, i) => {
    const r = H.scores.players[p.uid].r[idx];
    return `<div class="brow pop" style="--i:${i}"><span class="rk">#${i + 1}</span><span class="nm">${esc(p.n)}</span>
      ${r?.c ? '<span class="up">✓ +' + fmtPts(r.p) + '</span>' : ''}<span class="pt">${fmtPts(p.total)}</span></div>`;
  }).join('') || '<p class="center muted">No answers yet.</p>';
  hostView('board');
});

async function endGame() {
  const ranked = rankPlayers();
  const top = ranked.slice(0, 10).map(p => ({ uid: p.uid, name: p.n, pts: Math.round(p.total * 100) / 100 }));
  for (const [uid, p] of H.players) {
    if (!H.scores.players[uid]) H.scores.players[uid] = { n: p.name, s: p.studentId, r: {} };
  }
  await Promise.all([
    setGame({ status: 'ended', final: { top }, playerCount: Object.keys(H.scores.players).length, active: false }),
    F.setDoc(F.doc(db, 'games', H.code, 'private', 'scores'), H.scores)
  ]);
  showFinal();
}

function showFinal() {
  const ranked = rankPlayers();
  const pod = [ranked[1], ranked[0], ranked[2]];
  $('#podium').innerHTML = pod.map((p, i) => p ? `
    <div class="pod p${[2, 1, 3][i]}"><div class="nm">${esc(p.n)}</div><div class="blk">${[2, 1, 3][i]}</div><div class="pt">${fmtPts(p.total)} pts</div></div>` : '<div class="pod"></div>').join('');
  $('#finalList').innerHTML = ranked.slice(3, 10).map((p, i) => `
    <div class="brow pop" style="--i:${i + 4}"><span class="rk">#${i + 4}</span><span class="nm">${esc(p.n)}</span><span class="pt">${fmtPts(p.total)}</span></div>`).join('');
  $('#hostCorner').textContent = '';
  hostView('final');
  setTimeout(() => confetti(220), 2000);
}
$('#csvBtn').addEventListener('click', () => downloadCSV(H.code, H));

/* ================= Grades export ================= */
async function downloadCSV(code, live) {
  let scores, questions, game;
  if (live) { scores = live.scores; questions = live.questions; game = live.game; }
  else {
    const [g, pq, sc] = await Promise.all([
      F.getDoc(F.doc(db, 'games', code)),
      F.getDoc(F.doc(db, 'games', code, 'private', 'quiz')),
      F.getDoc(F.doc(db, 'games', code, 'private', 'scores'))
    ]);
    addUsage(3);
    game = g.data(); questions = pq.data()?.questions || []; scores = sc.data() || { closed: [], players: {}, qtimes: {} };
  }
  const closed = [...scores.closed].sort((a, b) => a - b);
  // Merge rows that share a student ID (same student on two devices): keep the best result per question.
  const byId = new Map();
  for (const [uid, p] of Object.entries(scores.players)) {
    const key = (p.s || '').toLowerCase().replace(/\s+/g, '') || `uid:${uid}`;
    const row = byId.get(key) || { names: new Set(), sid: p.s, r: {} };
    row.names.add(p.n);
    for (const [qi, rec] of Object.entries(p.r || {})) {
      if (!row.r[qi] || rec.p > row.r[qi].p || (rec.p === row.r[qi].p && rec.ms < row.r[qi].ms)) row.r[qi] = rec;
    }
    byId.set(key, row);
  }
  const pts = game.pts || { part: 0.5, acc: 0.5 };
  const rows = [...byId.values()].map(row => {
    let part = 0, acc = 0, time = 0, answered = 0, correct = 0;
    const perQ = closed.map(qi => {
      const r = row.r[qi];
      if (!r) { time += (scores.qtimes[qi] || 20) * 1000; return 0; }
      answered++; part += pts.part; if (r.c) { correct++; acc += pts.acc; } time += r.ms;
      return r.p;
    });
    const names = [...row.names];
    const [first, ...rest] = names[0].split(' ');
    return { name: names[0], first, last: rest.join(' '), alsoAs: names.slice(1).join('; '), sid: row.sid, perQ, part, acc, total: part + acc, answered, correct, time };
  }).sort((a, b) => b.total - a.total || a.time - b.time);

  const head = ['Rank', 'Last name', 'First name', 'Full name as typed', 'Student ID',
    ...closed.map(qi => `Q${qi + 1}`), 'Participation', 'Accuracy', 'Total points', 'Max possible',
    'Questions answered', 'Questions correct', 'Total answer time (s)', 'Also joined as'];
  const maxPossible = closed.length * (pts.part + pts.acc);
  // Excel strips leading zeros from IDs like 011234567; ="..." keeps them as text.
  const sidCell = sid => (/^0\d+$/.test(sid || '') ? { raw: `="${sid}"` } : sid);
  const lines = [head, ...rows.map((r, i) => [i + 1, r.last, r.first, r.name, sidCell(r.sid), ...r.perQ.map(fmtNum),
    fmtNum(r.part), fmtNum(r.acc), fmtNum(r.total), fmtNum(maxPossible), r.answered, r.correct, (r.time / 1000).toFixed(1), r.alsoAs])];
  const csv = lines.map(l => l.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const date = game.createdAt?.toDate?.().toISOString().slice(0, 10) || new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `grades-${date}-${(game.title || 'game').replace(/[^\w-]+/g, '_').slice(0, 40)}-${code}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Downloaded grades for ${rows.length} students`);
}
const fmtNum = n => String(Math.round(n * 1000) / 1000);
function csvCell(v) {
  if (v && v.raw) return v.raw;
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;  // keep spreadsheets from running typed "formulas"
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

window.addEventListener('beforeunload', e => {
  if (quiz && $('#saveState').classList.contains('dirty')) { save(); e.preventDefault(); }
});
