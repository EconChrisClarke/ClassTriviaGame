// Entry point for the vendored Firebase bundle (js/vendor/firebase.js).
// Rebuild with: npx esbuild tools/firebase-entry.js --bundle --format=esm --minify --outfile=js/vendor/firebase.js
export { initializeApp } from 'firebase/app';
export {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc,
  addDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp,
  getDocs, Timestamp, writeBatch, deleteField
} from 'firebase/firestore';
export {
  getAuth, connectAuthEmulator, signInAnonymously, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword
} from 'firebase/auth';
