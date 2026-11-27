# Class Poll Bonanza — notes for Claude

## Owner's standing preferences
- **Auto-merge:** after making a change the owner asked for, test it (see below), open the PR, and merge it
  into `main` yourself without asking. GitHub Pages deploys `main` automatically.
- If a change also needs something done in the Firebase console (e.g. new `firestore.rules`), say so
  clearly after merging, with step-by-step instructions. The owner is not a developer.

## What this is
A live classroom quiz game (200+ students per section) in the EconChrisClarke house style.
Static site on GitHub Pages + Firebase (Firestore, free Spark plan; Anonymous auth for students,
Google auth for the teacher). See README.md for files and setup.

## Testing before merging
Use the local emulator, never the real project:
- `npx firebase emulators:start --only firestore,auth --project class-poll-bonanza` (with `firestore.rules`)
- `python3 -m http.server 8000`, then open `teacher.html?emu=1` / `?g=CODE&emu=1`
- `tools/loadtest.mjs CODE 200` simulates students. Drive teacher + phones with Playwright and check the grades CSV.

## Things to keep in mind
- Free tier: ~50k reads/day. Phones listen to one game doc; don't add per-second or per-answer updates to it.
- Teacher's late-answer cutoff (timer + 2.5 s) must match `GRACE_MS` in `js/student.js`.
- `js/vendor/firebase.js` is built from `tools/firebase-entry.js` with esbuild; add new SDK functions there.
