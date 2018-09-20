"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions = require("firebase-functions");
const express_1 = require("express");
// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });
const oauth2App = express_1.default();
exports.oauth2 = functions.https.onRequest(oauth2App);
//# sourceMappingURL=index.js.map