import bunyan from "bunyan";
import express, { Response } from "express";
import expressBunyanLogger from "express-bunyan-logger";
import httpStatus from "http-status";
import uuidv5 from "uuid/v5";
import querystring from "querystring";
import moment from "moment";
import { default as fetch, Response as FetchResponse } from "node-fetch";
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

const log = bunyan.createLogger({ name: "oauth2" });

const OAUTH2_RETURN_URI = process.env.OAUTH2_RETURN_URI;
const OAUTH2_STATE_UUID_NAMESPACE = process.env.OAUTH2_STATE_NAMESPACE;
const OAUTH2_FIRESTORE_COLLECTION = process.env.OAUTH2_FIRESTORE_COLLECTION;
const SECURE_COOKIES = process.env.NODE_ENV === "production";

if (!OAUTH2_RETURN_URI) {
    log.fatal("OAUTH2_RETURN_URI is not defined!");
    process.exit(1);
}

if (!OAUTH2_STATE_UUID_NAMESPACE) {
    log.fatal("OAUTH2_STATE_UUID_NAMESPACE is not defined! This is a security risk!");
    process.exit(1);
}

if (!OAUTH2_FIRESTORE_COLLECTION) {
    log.fatal("OAUTH2_FIRESTORE_COLLECTION is not defined!");
    process.exit(1);
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
app.use(expressBunyanLogger());

app.use((req, res, next) => {
    const device_id: string = req.cookies["device_id"] || req.headers["x-device-id"];

    if (!device_id) {
        log.warn({ req }, "device_id not found in request.");
        res.sendStatus(httpStatus.BAD_REQUEST);
        return;
    }

    log.debug({ device_id, req }, "device_id read from request.");

    req["device_id"] = device_id;

    next();
});

app.use((req, res, next) => {
    const device_id: string = req["device_id"];
    const oauth2_state = uuidv5(device_id, OAUTH2_STATE_UUID_NAMESPACE, Buffer.alloc(16)).toString("base64");

    log.debug({ oauth2_state, device_id, req }, "Generated oauth2 state string for device.");

    req["oauth2_state"] = oauth2_state;

    next();
});

app.param("provider", (req, res, next, providerName) => {
    const provider: OAuth2ProviderConfig = providers[providerName];

    if (!provider) {
        log.warn({ req, providerName }, "Provider not found.")
        res.sendStatus(httpStatus.NOT_FOUND);
        return;
    }

    log.debug({ providerName, req }, "providerName read from request and validated.");

    req["provider"] = provider;

    next();
});


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

    res.cookie("device_id", device_id, cookieOptions());

    res.redirect(`${provider.authorization_uri}?${querystring.stringify(requestParams)}`);
});


app.get(":/provider/callback", async (req, res) => {
    const device_id = req["device_id"];
    const provider = req["provider"];
    const providerName = req.params["provider"];
    const oauth2_state = req["oauth2_state"];
    const oauth2_response: OAuth2AuthSuccessResponse | OAuth2ErrorResponse = req.query;

    res.clearCookie("device_id", cookieOptions());

    if (oauth2_response.state !== oauth2_state) {
        // The expected state is wrong. Hack attack?
        log.warn({
            device_id,
            providerName,
            req,
            oauth2_state,
            oauth2_response
        }, "oauth2_response.state was not expected value.");

        res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify({ provider: providerName, error: "invalid_request" })}`);
    } else if (isOAuth2ErrorResponse(oauth2_response)) {
        log.warn({
            device_id,
            providerName,
            req,
            oauth2_response
        }, "OAuth2 provider returned an error.");

        res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify({ provider: providerName, error: oauth2_response.error })}`);
    } else {
        const authCode = oauth2_response.code;
        const tokenRes = await fetchTokensFromProvider(provider, authCode, createRedirectUri(req));

        if (isOAuth2ErrorResponse(tokenRes)) {
            log.warn({
                device_id,
                provider: providerName,
                ...tokenRes
            }, "Received error when exchanging auth code for tokens.");
            res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify({ provider: providerName, error: tokenRes.error })}`);
        } else {
            // Save the tokens
            await saveTokens(device_id, providerName, {
                access_token: tokenRes.access_token,
                expires_in: tokenRes.expires_in || null,
                refresh_token: tokenRes.refresh_token
            });

            log.info({
                device_id,
                provider: providerName,
                access_token: !!tokenRes.access_token,
                expires_in: tokenRes.expires_in,
                refresh_token: !!tokenRes.refresh_token
            }, "Exchanged auth code for tokens.");

            // Return the tokens
            res.redirect(`${OAUTH2_RETURN_URI}#${querystring.stringify({
                provider: providerName,
                access_token: tokenRes.access_token,
                expires_in: tokenRes.expires_in
            })}`);
        }
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
        log.info({ device_id, provider: providerName }, "Refreshing tokens.");
        const tokenRes = await refreshTokensFromProvider(provider, tokens.refresh_token);

        if (isOAuth2ErrorResponse(tokenRes)) {
            log.warn({
                device_id,
                provider: providerName,
                ...tokenRes
            }, "Received an error when refreshing tokens.");

            await deleteTokens(device_id, providerName);
            // TODO http error
            res.json({ error: tokenRes.error });
        } else {
            tokens = {
                access_token: tokenRes.access_token,
                expires_in: tokenRes.expires_in || null,
                refresh_token: tokenRes.refresh_token
            };

            await saveTokens(device_id, providerName, tokens);

            log.info({
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
        res.sendStatus(httpStatus.NOT_FOUND);
    } else {
        res.json({
            access_token: tokens.access_token,
            expires_in: tokens.expires_in
        });
    }
});


export default app;