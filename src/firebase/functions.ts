import functions from "firebase-functions";
import firebaseApp from "./firebase-app";
import FirestoreTokenStorage from "./token-storage";
import oauth2App from "../oauth2-app";

const FIRESTORE_TOKEN_COLLECTION = process.env.FIRESTORE_TOKEN_COLLECTION;

if (!FIRESTORE_TOKEN_COLLECTION) {
    throw new Error("FIRESTORE_TOKEN_COLLECTION is not defined!");
}

const tokenStorage = new FirestoreTokenStorage(FIRESTORE_TOKEN_COLLECTION);

const app = oauth2App(tokenStorage);

functions.https.onRequest(app);
