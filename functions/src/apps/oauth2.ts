import { createLogger } from "bunyan";
import express = require("express");
import { Request, Response, NextFunction } from "express";
import bunyanRequest = require("bunyan-request");
import * as boom from "boom";
import cookieParser = require("cookie-parser");
import * as httpStatus from "http-status";
import uuidv5 = require("uuid/v5");
import * as querystring from "querystring";
import moment = require("moment");
import fetch, { Response as FetchResponse } from "node-fetch";
import * as functions from "firebase-functions";
import firebaseApp from "../firebase";
import {
    OAuth2ProviderConfig,
    OAuth2AuthRequestParams,
    OAuth2AuthSuccessResponse,
    OAuth2ErrorResponse,
    OAuth2RefreshRequestParams,
    OAuth2TokenRequestParams,
    OAuth2TokenResponse
} from "../types";
import * as providers from "../oauth2-providers";

const log = createLogger({ name: "oauth2" });

// Where to redirect the browser after a successful oauth2 authentication
// const OAUTH2_RETURN_URI = process.env.OAUTH2_RETURN_URI;
// const OAUTH2_STATE_UUID_NAMESPACE = process.env.OAUTH2_STATE_NAMESPACE;
// const OAUTH2_FIRESTORE_COLLECTION = process.env.OAUTH2_FIRESTORE_COLLECTION;
const OAUTH2_RETURN_URI = functions.config().oauth2.return_uri;
const OAUTH2_STATE_UUID_NAMESPACE = functions.config().oauth2.state.uuid_namespace;
const OAUTH2_FIRESTORE_COLLECTION = functions.config().oauth2.firestore.collections.tokens;
const SECURE_COOKIES = process.env.NODE_ENV === "production";

if (!OAUTH2_RETURN_URI) {
    log.fatal("OAUTH2_RETURN_URI is not defined!");
    throw new Error("OAUTH2_RETURN_URI is not defined!");
}

if (!OAUTH2_STATE_UUID_NAMESPACE) {
    log.fatal("OAUTH2_STATE_UUID_NAMESPACE is not defined!");
    throw new Error("OAUTH2_STATE_UUID_NAMESPACE is not defined!");
}

if (!OAUTH2_FIRESTORE_COLLECTION) {
    log.fatal("OAUTH2_FIRESTORE_COLLECTION is not defined!");
    throw new Error("OAUTH2_FIRESTORE_COLLECTION is not defined!");
}


const createRedirectUri = (req: express.Request) => `${req.protocol}://${req.hostname}/oauth2/${req.params["provider"]}/callback`;


const cookieOptions = (): express.CookieOptions => ({
    httpOnly: true,
    secure: SECURE_COOKIES || "auto"
});


const isOAuth2ErrorResponse = (query: any): query is OAuth2ErrorResponse => {
    return !!query.error;
};


const parseOauth2TokenResponse = async (res: FetchResponse) => {
    const resBody: OAuth2TokenResponse | OAuth2ErrorResponse = await res.json();

    if (res.ok) {
        const okResBody = (resBody as OAuth2TokenResponse)
        log.debug({
            response_status: res.status,
            response_body: {
                access_token: !!okResBody.access_token,
                expires_in: okResBody.expires_in,
                refresh_token: !!okResBody.refresh_token,
                topen_type: okResBody.token_type
            }
        }, "Acquired tokens from provider.");
    } else {
        log.warn({
            response_status: res.status,
            response_body: resBody
        }, "Token request failed.");
    }

    return resBody;
};


const fetchTokensFromProvider = async (provider: OAuth2ProviderConfig, authCode: string, redirectUri: string) => {
    const tokenRequestParams: OAuth2TokenRequestParams = {
        client_id: provider.client_id,
        code: authCode,
        client_secret: provider.client_secret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
    };

    const res = await fetch(provider.token_uri, {
        method: "POST",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: querystring.stringify(tokenRequestParams)
    });

    return parseOauth2TokenResponse(res);
};


const refreshTokensFromProvider = async (provider: OAuth2ProviderConfig, refresh_token: string) => {
    const tokenRefreshParams: OAuth2RefreshRequestParams = {
        client_id: provider.client_id,
        client_secret: provider.client_secret,
        grant_type: "refresh_token",
        refresh_token: refresh_token
    };

    const res = await fetch(provider.token_uri, {
        method: "POST",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: querystring.stringify(tokenRefreshParams)
    });

    return parseOauth2TokenResponse(res);
};


const saveTokens = async (device_id: string, providerName: string, tokens: { access_token: string, expires_in: number, refresh_token: string }) => {
    const collection = firebaseApp.firestore().collection(OAUTH2_FIRESTORE_COLLECTION);

    const docId = `${device_id}:${providerName}`;
    const docRef = collection.doc(docId);

    const data = {
        device_id,
        provider: providerName,
        access_token: tokens.access_token,
        expires_at: tokens.expires_in ? moment.utc().add(tokens.expires_in, "seconds").toDate() : null,
        refresh_token: tokens.refresh_token
    };

    await docRef.set(data);
};


const loadTokens = async (device_id: string, providerName: string) => {
    const collection = firebaseApp.firestore().collection(OAUTH2_FIRESTORE_COLLECTION);

    const docId = `${device_id}:${providerName}`;
    const docRef = collection.doc(docId);
    const doc = await docRef.get();

    return doc.exists ? {
        access_token: doc.get("access_token"),
        expires_in: doc.get("expires_at") ? moment(doc.get("expires_at") as Date).diff(moment(), "seconds") : null,
        refresh_token: (doc.get("refresh_token") as string)
    } : null;
};


const deleteTokens = async (device_id: string, providerName: string) => {
    const collection = firebaseApp.firestore().collection(OAUTH2_FIRESTORE_COLLECTION);

    const docId = `${device_id}:${providerName}`;
    const docRef = collection.doc(docId);

    await docRef.delete();
}


const app = express();
app.set("trust proxy", true);
app.use(bunyanRequest({
    logger: log
}));
app.use(cookieParser());

// Middleware to read the device_id from the request and set it on the request object.
app.use((req, res, next) => {
    req.log.debug({ }, "Reading device_id from request.");

    const device_id: string = req.cookies["device_id"] || req.headers["x-device-id"];

    if (!device_id) {
        req.log.debug({ req }, "Request did not contain a device_id.");
        next(boom.badRequest("device_id not defined."))
    } else {
        req.log.debug({ device_id, req }, "device_id read from request.");
        req["device_id"] = device_id;
        next();
    }
});

// Middleware to calculate and set the oauth2 state for a device_id on the request
app.use((req, res, next) => {
    const device_id: string = req["device_id"];
    const oauth2_state = uuidv5(device_id, OAUTH2_STATE_UUID_NAMESPACE, Buffer.alloc(16)).toString("base64");

    req.log.debug({ oauth2_state, device_id, req }, "Generated oauth2 state string for device.");
    req["oauth2_state"] = oauth2_state;
    next();
});

// Middleware to parse the provider param and inject it on the request
app.param("provider", (req, res, next, providerName) => {
    const provider: OAuth2ProviderConfig = providers[providerName];

    if (!provider) {
        next(boom.notFound("Unknown provider."));
    } else {
        req.log.debug({ providerName, req }, "providerName read from request and validated.");
        req["provider"] = provider;
        next();
    }
});

// Error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    boom.boomify(err);

    if (err.isServer) {
        req.log.error({ req, err, stack: err.stack }, "Request caused an error.");
    } else {
        req.log.warn({ req, err }, "Request caused an error.")
    }

    res.status(err.output.statusCode).json(err.output.payload);
});


// Redirect the client to the provider's oauth2 screen
app.get("/:provider/auth", (req, res) => {
    const device_id = req["device_id"];
    const provider = req["provider"];
    const oauth2_state = req["oauth2_state"];

    const requestParams: OAuth2AuthRequestParams = {
        client_id: provider.client_id,
        redirect_uri: createRedirectUri(req),
        response_type: "code",
        scope: provider.scope,
        state: oauth2_state
    };

    // Store the device_id in a cookie so the callback handler will know about it.
    res.cookie("device_id", device_id, cookieOptions());

    res.redirect(`${provider.authorization_uri}?${querystring.stringify(requestParams)}`);
});


// Handle the callback from a provider's oauth2 screen
app.get(":/provider/callback", async (req, res) => {
    const device_id = req["device_id"];
    const provider = req["provider"];
    const providerName = req.params["provider"];
    const oauth2_state = req["oauth2_state"];
    const oauth2_response: OAuth2AuthSuccessResponse | OAuth2ErrorResponse = req.query;

    res.clearCookie("device_id", cookieOptions());

    let responseParams = null;

    try {
        if (oauth2_response.state !== oauth2_state) {
            // The expected state is wrong. Hack attack?
            req.log.warn({
                device_id,
                providerName,
                req,
                oauth2_state,
                oauth2_response
            }, "oauth2_response.state was not expected value.");

            throw new Error("invalid_request");
        } else if (isOAuth2ErrorResponse(oauth2_response)) {
            req.log.warn({
                device_id,
                providerName,
                req,
                oauth2_response
            }, "OAuth2 provider returned an error.");

            throw new Error(oauth2_response.error);
        } else {
            const authCode = oauth2_response.code;
            const tokenRes = await fetchTokensFromProvider(provider, authCode, createRedirectUri(req));

            if (isOAuth2ErrorResponse(tokenRes)) {
                req.log.warn({
                    device_id,
                    provider: providerName,
                    ...tokenRes
                }, "Received error when exchanging auth code for tokens.");

                throw new Error(tokenRes.error);
            } else {
                // Save the tokens
                try {
                    await saveTokens(device_id, providerName, {
                        access_token: tokenRes.access_token,
                        expires_in: tokenRes.expires_in || null,
                        refresh_token: tokenRes.refresh_token
                    });

                    req.log.info({
                        device_id,
                        provider: providerName,
                        access_token: !!tokenRes.access_token,
                        expires_in: tokenRes.expires_in,
                        refresh_token: !!tokenRes.refresh_token
                    }, "Exchanged auth code for tokens.");

                    // Return the tokens
                    responseParams = {
                        provider: providerName,
                        access_token: tokenRes.access_token,
                        expires_in: tokenRes.expires_in
                    };
                } catch (err) {
                    req.log.error({
                        device_id,
                        provider: providerName,
                        ...tokenRes,
                        err
                    }, "Error saving tokens!");

                    throw new Error("server_error");
                }
            }
        }

        res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify(responseParams)}`);
    } catch (err) {
        res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify({
            provider: providerName,
            error: err.message
        })}`);
    }

});

app.get(":/provider/tokens", async (req, res) => {
    const device_id = req["device_id"];
    const provider = req["provider"];
    const providerName = req.params["provider"];

    let tokens = await loadTokens(device_id, providerName);

    const tokenExpired = tokens && tokens.expires_in !== null && tokens.expires_in < 60 * 1;

    if (!tokens) {
        // We have no tokens!
        res.sendStatus(httpStatus.NOT_FOUND);
    } else if (tokens.refresh_token && tokenExpired) {
        // Token expires soon but we have a refresh token!
        req.log.info({ device_id, provider: providerName }, "Refreshing tokens.");
        const tokenRes = await refreshTokensFromProvider(provider, tokens.refresh_token);

        if (isOAuth2ErrorResponse(tokenRes)) {
            req.log.warn({
                device_id,
                provider: providerName,
                ...tokenRes
            }, "Received an error when refreshing tokens.");

            await deleteTokens(device_id, providerName);

            throw boom.badGateway(tokenRes.error);
        } else {
            tokens = {
                access_token: tokenRes.access_token,
                expires_in: tokenRes.expires_in || null,
                refresh_token: tokenRes.refresh_token
            };

            await saveTokens(device_id, providerName, tokens);

            req.log.info({
                device_id,
                provider: providerName,
                access_token: !!tokens.access_token,
                expires_in: tokens.expires_in,
                refresh_token: !!tokens.refresh_token
            }, "Refreshed and saved new tokens.")

            res.json({
                access_token: tokens.access_token,
                expires_in: tokens.expires_in
            });
        }
    } else if (tokenExpired) {
        // Token is expired and we have no refresh token :(
        await deleteTokens(device_id, providerName);
        throw boom.notFound();
    } else {
        res.json({
            access_token: tokens.access_token,
            expires_in: tokens.expires_in
        });
    }
});


export default app;
