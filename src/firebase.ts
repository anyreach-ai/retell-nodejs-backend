import admin from 'firebase-admin';
import * as fs from 'fs';

// Path to your service account key JSON file
const serviceAccountPath = '../call-transcription-service-account-key.json';

// Check if the file exists and is readable

const serviceAccount = require(serviceAccountPath);

// Ensure the environment variable is set
if (!process.env.FIREBASE_PROJECT_ID) {
  throw new Error('FIREBASE_PROJECT_ID environment variable is not set');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();

export { db, admin };
