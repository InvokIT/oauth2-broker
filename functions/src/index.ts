import * as functions from 'firebase-functions';
import express from "express";
import * as apps from "./apps";

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });

Object.keys(apps).forEach(appName => {
    exports[appName] = functions.https.onRequest(apps[appName]);
});
