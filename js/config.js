// Firebase web config for the "Class Poll Bonanza" project.
// This is not a secret: Google designs it to live in public web pages.
// Access is controlled by the rules in firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDnMKDhlO1TVtjdhZXOEc41UzlixNZcBqQ",
  authDomain: "class-poll-bonanza.firebaseapp.com",
  projectId: "class-poll-bonanza",
  storageBucket: "class-poll-bonanza.firebasestorage.app",
  messagingSenderId: "70997910355",
  appId: "1:70997910355:web:c7ccb043d41996e2c037a6"
};

// Free-tier daily limits, used by the teacher's usage gauge.
export const FREE_READS_PER_DAY = 50000;
export const FREE_WRITES_PER_DAY = 20000;
