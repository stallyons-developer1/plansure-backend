const admin = require("firebase-admin");

let firebaseApp = null;

const initializeFirebase = () => {
  if (firebaseApp) return firebaseApp;

  console.log("[Firebase] Checking config...");
  console.log(
    "[Firebase] PROJECT_ID:",
    process.env.FIREBASE_PROJECT_ID ? "SET" : "MISSING",
  );
  console.log(
    "[Firebase] CLIENT_EMAIL:",
    process.env.FIREBASE_CLIENT_EMAIL ? "SET" : "MISSING",
  );
  console.log(
    "[Firebase] PRIVATE_KEY:",
    process.env.FIREBASE_PRIVATE_KEY
      ? `SET (${process.env.FIREBASE_PRIVATE_KEY.length} chars)`
      : "MISSING",
  );

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    console.log("[Firebase] Missing required config - skipping initialization");
    return null;
  }

  try {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (privateKey && privateKey.includes("\\n")) {
      privateKey = privateKey.replace(/\\n/g, "\n");
      console.log("[Firebase] Converted escaped \\n to newlines");
    }

    if (privateKey && privateKey.includes("\\\\n")) {
      privateKey = privateKey.replace(/\\\\n/g, "\n");
      console.log("[Firebase] Converted double-escaped \\\\n to newlines");
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
    });
    console.log("[Firebase] Admin SDK initialized successfully!");
    return firebaseApp;
  } catch (error) {
    console.error("[Firebase] Init error:", error.message);
    return null;
  }
};

const getMessaging = () => {
  console.log(
    "[Firebase] getMessaging called, firebaseApp exists:",
    !!firebaseApp,
  );
  if (!firebaseApp) {
    console.log("[Firebase] Attempting to initialize...");
    initializeFirebase();
  }
  if (!firebaseApp) {
    console.log("[Firebase] Still no firebaseApp after init attempt");
    return null;
  }
  console.log("[Firebase] Returning messaging instance");
  return admin.messaging();
};

module.exports = { initializeFirebase, getMessaging, admin };
