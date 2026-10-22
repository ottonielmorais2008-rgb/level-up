import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, OAuthProvider, signInAnonymously, linkWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { initializeFirestore, doc, getDocFromServer, persistentLocalCache, persistentMultipleTabManager, getFirestore } from 'firebase/firestore';
import { getAnalytics, logEvent } from 'firebase/analytics';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
// Firebase web config comes from environment variables (see .env.example).
// These values are not secrets, but keeping them out of the repo lets every
// developer point the app at their own Firebase project.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
  firestoreDatabaseId: import.meta.env.VITE_FIREBASE_DATABASE_ID || '(default)',
};

const app = initializeApp(firebaseConfig);

// Initialize Firebase App Check
// let appCheck;
// if (typeof window !== 'undefined') {
//   try {
//     appCheck = initializeAppCheck(app, {
//       provider: new ReCaptchaV3Provider('dummy-site-key-for-development'), 
//       isTokenAutoRefreshEnabled: true
//     });
//   } catch(e) {
//     console.warn("App Check initialization failed:", e);
//   }
// }

// Analytics
export const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;

// Auth
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const appleProvider = new OAuthProvider('apple.com');

// Firestore with offline persistence
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
}, firebaseConfig.firestoreDatabaseId);

// Messaging
export const messaging = typeof window !== 'undefined' ? (async () => {
  try {
    const msg = getMessaging(app);
    return msg;
  } catch(e) {
    console.warn("Messaging not supported in this environment", e);
    return null;
  }
})() : null;

// Test connection
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error: any) {
    if (error.message && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// Initial Anonymous Signup Logic
export const ensureAuthenticated = async (): Promise<User | null> => {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      if (!user) {
        try {
          const cred = await signInAnonymously(auth);
          resolve(cred.user);
        } catch (error) {
          console.error("Error signing in anonymously:", error);
          resolve(null);
        }
      } else {
        resolve(user);
      }
    });
  });
};

export const linkGoogle = async () => {
  try {
    if (auth.currentUser) {
      if (auth.currentUser.isAnonymous) {
        await linkWithPopup(auth.currentUser, googleProvider);
      } else {
        console.warn("User already linked");
      }
    }
  } catch (e) {
    console.error("Failed to link Google account", e);
    throw e;
  }
};

export const linkApple = async () => {
  try {
    if (auth.currentUser) {
      if (auth.currentUser.isAnonymous) {
        await linkWithPopup(auth.currentUser, appleProvider);
      }
    }
  } catch (e) {
    console.error("Failed to link Apple account", e);
    throw e;
  }
};

