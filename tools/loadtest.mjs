// Simulates a classroom of students against the LOCAL Firebase emulator (never the real project).
// Each fake student signs in anonymously, joins, listens to the game doc like a phone does,
// and answers each question after a random delay (some answer wrong, a few never answer).
//
// Usage (from a folder where `firebase` is installed):
//   node tools/loadtest.mjs GAMECODE [numStudents=200]
import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, onSnapshot, serverTimestamp, getDoc } from 'firebase/firestore';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';

const code = process.argv[2];
const N = +(process.argv[3] || 200);
if (!code) { console.error('usage: node loadtest.mjs CODE [N]'); process.exit(1); }

const cfg = { apiKey: 'demo-key', projectId: 'class-poll-bonanza', authDomain: 'localhost', appId: 'x' };
const FIRST = ['Ava', 'Ben', 'Chloe', 'Diego', 'Emma', 'Farah', 'Gus', 'Hana', 'Ivan', 'Jada', 'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Priya'];
const LAST = ['Nguyen', 'Smith', 'Garcia', 'Kim', 'Patel', 'Lopez', 'Brown', 'Chen', 'Ali', 'Jones', 'Davis', 'Rossi'];

let answered = 0, errors = 0, statesSeen = 0;
async function student(i) {
  const app = initializeApp(cfg, `s${i}`);
  const db = getFirestore(app);
  const auth = getAuth(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { user } = await signInAnonymously(auth);
  const uid = user.uid;
  await setDoc(doc(db, 'games', code, 'players', uid), {
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}${i}`,
    studentId: String(11000000 + i).padStart(9, '0'), joinedAt: serverTimestamp()
  });
  const skill = Math.random();          // how often this student is right
  const lazy = Math.random() < 0.05;    // never answers
  const done = new Set();
  onSnapshot(doc(db, 'games', code), async snap => {
    statesSeen++;
    const g = snap.data();
    if (!g || g.status !== 'question' || !g.q || done.has(g.q.idx) || lazy) return;
    const q = g.q; done.add(q.idx);
    if (q.type === 'heat') await getDoc(doc(db, 'images', q.imageId));
    const delay = 500 + Math.random() * Math.min(q.time * 1000 * 0.6, 8000);
    setTimeout(async () => {
      const right = Math.random() < skill;
      const payload = q.type === 'heat'
        ? (right ? { x: 0.5 + (Math.random() - .5) * .1, y: 0.5 + (Math.random() - .5) * .1 } : { x: Math.random(), y: Math.random() })
        : { choice: right ? 0 : Math.floor(Math.random() * q.choices.length) };
      try {
        await setDoc(doc(db, 'games', code, 'answers', `${q.idx}_${uid}`), { uid, q: q.idx, ...payload, at: serverTimestamp() });
        answered++;
      } catch (e) { errors++; console.error('answer failed', e.code); }
    }, delay);
  });
}

const t0 = Date.now();
for (let i = 0; i < N; i += 20) {
  await Promise.all(Array.from({ length: Math.min(20, N - i) }, (_, k) => student(i + k).catch(e => { errors++; console.error(e.code || e.message); })));
}
console.log(`${N} students joined in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
setInterval(() => console.log(`answers sent: ${answered}, game-state reads: ${statesSeen}, errors: ${errors}`), 5000);
