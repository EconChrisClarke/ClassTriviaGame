# Class Poll Bonanza

A Kahoot-style live quiz game for big classes (built and tested for 200+ students), in the EconChrisClarke house style.

- **Students:** https://econchrisclarke.github.io/ClassTriviaGame/ (or scan the QR code on the projector)
- **Teacher:** https://econchrisclarke.github.io/ClassTriviaGame/teacher.html

Hosted free on GitHub Pages; live answers go through Firebase Firestore on the free Spark plan.

## What it does

- **Two question types:** multiple choice (2 to 4 answers, one or more correct) and **heatmap**, where students tap an image and a tap inside the oval you drew counts as correct.
- **Grading per question:** 0.5 points for answering plus 0.5 for being correct by default, adjustable per question set.
- **Leaderboard:** shows the top 10 after each question. Ties go to whoever answered faster in total; a missed question counts as the full timer.
- **Adjustable timer** per question, plus **+10 seconds** and **End now** buttons while it runs. A question closes early once everyone has answered.
- **Student identity:** students give their first name, last name and Student ID, with a reminder that real names are required for credit.
- **Grades CSV:** rank, last name, first name, student ID, points per question, participation, accuracy, total and answer time. If a student joins on two devices, the rows are merged by Student ID, keeping the best result for each question.
- **Recovery:** a refreshed phone or teacher laptop picks up where it left off.
- **Usage gauge:** the teacher screen shows an estimate of today's free database reads (the limit is 50,000 per day and resets at midnight Pacific). A 15-question game with 200 students uses roughly 13,000 to 16,000.

## One-time setup (Firebase console)

1. **Rules:** go to Firestore Database → **Rules**, paste in the whole of [`firestore.rules`](firestore.rules), and click **Publish**.
2. **Anonymous sign-in:** go to Authentication → Sign-in method → **Add new provider → Anonymous → Enable**. Students are signed in invisibly, so each one can only submit their own answers.
3. **Google sign-in:** this should already be enabled. Under Authentication → Settings → Authorized domains, `econchrisclarke.github.io` must be listed.
4. **Register yourself as teacher:** open the teacher page and sign in with Google. It will show your user ID along with step-by-step instructions for adding it to a `teachers` collection. You only do this once.

## GitHub Pages

Go to the repo's Settings → **Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. The site goes live a minute or two later.

## Files

| Path | What |
|---|---|
| `index.html`, `js/student.js`, `css/student.css` | Student phone site |
| `teacher.html`, `js/teacher.js`, `css/teacher.css` | Teacher editor, projector host screens and grade export |
| `js/common.js`, `css/app.css` | Shared Firebase setup, animations, brand |
| `js/config.js` | Firebase web config. This is not a secret; access is controlled by the rules |
| `firestore.rules` | Security rules. Students can't see correct answers, others' answers or grades |
| `js/vendor/` | Bundled Firebase SDK and QR code library, so there are no third-party script requests |
| `tools/loadtest.mjs` | Simulates 200 students against the **local emulator** |

## Testing locally

```bash
npm i firebase firebase-tools
npx firebase emulators:start --only firestore,auth --project class-poll-bonanza
python3 -m http.server 8000
```

Then open `http://localhost:8000/teacher.html?emu=1`. In `?emu=1` mode the site talks to the local emulator instead of the real database. Simulate a class with `node tools/loadtest.mjs CODE 200`.
