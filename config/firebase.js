const admin = require("firebase-admin");

let firebaseApp = null;

const initializeFirebase = () => {
  if (firebaseApp) return firebaseApp;

  console.log("[Firebase] Checking config...");
  console.log("[Firebase] PROJECT_ID:", process.env.FIREBASE_PROJECT_ID ? "SET" : "MISSING");
  console.log("[Firebase] CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL ? "SET" : "MISSING");
  console.log("[Firebase] PRIVATE_KEY:", process.env.FIREBASE_PRIVATE_KEY ? `SET (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` : "MISSING");

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    console.log("[Firebase] Missing required config - skipping initialization");
    return null;
  }

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
    console.log("[Firebase] Admin SDK initialized");
    return firebaseApp;
  } catch (error) {
    console.error("[Firebase] Init error:", error.message);
    return null;
  }
};

const getMessaging = () => {
  if (!firebaseApp) initializeFirebase();
  if (!firebaseApp) return null;
  return admin.messaging();
};

module.exports = { initializeFirebase, getMessaging, admin };
