import bunyan from "bunyan";
import fetch from "node-fetch";
import httpStatus from "http-status";
import Koa from "koa";
import koaBunyanLogger from "koa-bunyan-logger";
import Router from "koa-router";
import querystring from "querystring";
import uuidv5 from "uuid/v5";
import * as oauth2Providers from "./oauth2-providers";
import FirebaseTokenStorage from "./firebase/token-storage";

interface IOAuth2AuthRequestParams {
    client_id: string,
    redirect_uri: string,
    response_type: "code",
    scope: string,
    state: string
};

interface IOAuth2AuthSuccessResponse {
    code: string,
    state: string
}

interface IOAuth2ErrorResponse {
    error: "invalid_request"
    | "unauthorized_client"
    | "access_denied"
    | "unsupported_response_type"
    | "invalid_scope"
    | "server_error"
    | "temporarily_unavailable",
    error_description?: string,
    error_uri?: string,
    state: string
}

interface IOAuth2TokenRequestParams {
    client_id: string,
    client_secret: string,
    code: string,
    grant_type: "authorization_code",
    redirect_uri: string
}

interface IOAuth2RefreshRequestParams {
    client_id: string,
    client_secret: string,
    refresh_token: string,
    grant_type: "refresh_token",
}

interface IOAuth2TokenResponse {
    access_token: string,
    expires_in: string | null,
    refresh_token: string | null,
    token_type: "Bearer"
}

const logger = bunyan.createLogger({ name: "index" });

const APP_RETURN_URI = process.env.APP_RETURN_URI;
const SECURE_COOKIES = process.env.NODE_ENV === "production";
const UUID_NAMESPACE = process.env.UUID_NAMESPACE;
const FIRESTORE_TOKEN_COLLECTION = process.env.FIRESTORE_TOKEN_COLLECTION;

if (!APP_RETURN_URI) {
    logger.error("APP_RETURN_URI is not defined!");
    process.exit(1);
}

const createOAuth2State = (deviceId: string) => uuidv5(deviceId, UUID_NAMESPACE, Buffer.alloc(16)).toString("base64");

const isOAuth2ErrorResponse = (res: any): res is IOAuth2ErrorResponse => {
    return !!res.error;
}

const tokenStorage = new FirebaseTokenStorage(FIRESTORE_TOKEN_COLLECTION);

const app = new Koa();
app.proxy = true;

app.use(koaBunyanLogger());
app.use((koaBunyanLogger as any).requestIdContext());
app.use((koaBunyanLogger as any).requestLogger({
    updateLogFields: function (fields) {
        fields.device_id = this.get("X-Device-Id") || this.cookies.get("device-id");
    }
}));

// Read device id from header and set it on ctx.state
app.use((ctx, next) => {
    const headerField = "X-Device-Id";

    const device_id = ctx.get(headerField) || ctx.cookies.get("device-id");

    ctx.assert(!!device_id, httpStatus.BAD_REQUEST, "Missing device id.");

    ctx.state.device_id = device_id;

    return next();
});

const router = new Router();

router.param("provider", (providerName, ctx, next) => {
    ctx.assert(providerName in oauth2Providers, httpStatus.NOT_FOUND);

    ctx.state.provider = oauth2Providers[providerName];

    return next();
});

const createRedirectUri = (ctx: Koa.Context) => `${ctx.request.protocol}://${ctx.request.host}/callback/${ctx.params.provider}`;

router.get("/auth/:provider", async (ctx, next) => {
    // ctx.router available
    const provider: oauth2Providers.OAuth2ProviderConfig = ctx.state.provider;
    const device_id = ctx.state.device_id;

    const state = createOAuth2State(device_id);

    const requestParams: IOAuth2AuthRequestParams = {
        client_id: provider.client_id,
        redirect_uri: createRedirectUri(ctx),
        response_type: "code",
        scope: provider.scope,
        state: state
    }

    ctx.cookies.set("device-id", device_id, { secure: SECURE_COOKIES });

    ctx.redirect(`${provider.authorization_uri}?${querystring.stringify(requestParams)}`);
});

router.get("/callback/:provider", async (ctx, next) => {
    const oauthResponse: IOAuth2AuthSuccessResponse | IOAuth2ErrorResponse = ctx.query;

    const device_id = ctx.state.device_id;
    const providerName = ctx.params.provider;

    // Clear cookies
    ctx.cookies.set("oauth2-state");
    ctx.cookies.set("device-id");

    const responseState = oauthResponse.state;

    if (createOAuth2State(device_id) !== responseState) {
        // The expected state is wrong. Hack attack?
        logger.warn({
            device_id,
            oauth_provider: providerName,
            oauth_response: oauthResponse
        }, "responseState was not expected value.");

        ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ error: "invalid_request" })}`);
        return;
    } else if (isOAuth2ErrorResponse(oauthResponse)) {
        logger.warn({
            device_id,
            oauth_provider: providerName,
            oauth_response: oauthResponse
        }, "OAuth2 provider returned an error.");

        ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ provider: providerName, error: oauthResponse.error })}`);
        return;
    } else {
        const authCode = oauthResponse.code;
        const provider: oauth2Providers.OAuth2ProviderConfig = ctx.state.provider;
        const tokenRequestParams: IOAuth2TokenRequestParams = {
            client_id: provider.client_id,
            code: authCode,
            client_secret: provider.client_secret,
            grant_type: "authorization_code",
            redirect_uri: createRedirectUri(ctx)
        };

        const res = await fetch(provider.token_uri, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: querystring.stringify(tokenRequestParams)
        });

        const resBody: IOAuth2TokenResponse | IOAuth2ErrorResponse = await res.json();

        if (res.ok) {
            const { access_token, expires_in, refresh_token } = (resBody as IOAuth2TokenResponse);

            // Save tokens and redirect client
            await tokenStorage.save(device_id, providerName, {
                access_token,
                expires_at: expires_in ? (Date.now() / 1000) - 5 + parseInt(expires_in) : null,
                refresh_token
            });

            ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ provider: providerName, access_token, expires_in })}`);
        } else {
            const errorCode = (resBody as IOAuth2ErrorResponse).error;
            logger.warn({
                device_id,
                oauth_provider: providerName,
                oauth_token_response_status: res.status,
                oauth_token_response_error: errorCode
            }, "OAuth2 token request failed.");

            ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ provider: providerName, error: errorCode })}`);
        }
    }
});

router.get("/token/:provider", async (ctx, next) => {
    const providerName = ctx.params.provider;
    const device_id = ctx.state.device_id;

    // Load refresh_token then request a new access_token and return that
    const tokens = await tokenStorage.load(device_id, providerName);
    const provider: oauth2Providers.OAuth2ProviderConfig = ctx.state.provider;

    if (tokens) {
        if (tokens.expires_at > Date.now()) {
            // If the access_token is still valid, just return that
            ctx.response.body = { access_token: tokens.access_token, expires_in: tokens.expires_at - (Date.now() / 1000) };
        } else if (tokens.refresh_token) {
            // Try to request a new access token
            const res = await fetch(provider.token_uri, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: querystring.stringify({
                    client_id: provider.client_id,
                    client_secret: provider.client_secret,
                    grant_type: "refresh_token",
                    refresh_token: tokens.refresh_token
                } as IOAuth2RefreshRequestParams)
            });

            const resBody: IOAuth2TokenResponse | IOAuth2ErrorResponse = await res.json();

            if (res.ok) {
                const { access_token, expires_in, refresh_token } = (resBody as IOAuth2TokenResponse);

                await tokenStorage.save(device_id, providerName, {
                    access_token,
                    expires_at: expires_in ? (Date.now() / 1000) - 5 + parseInt(expires_in) : null,
                    refresh_token
                });

                ctx.response.body = { access_token, expires_in };
            } else {
                // TODO Provider denied refreshing the tokens
            }
        } else {
            // We can't request a new token, the user has to authorize again
        }
    } else {
        ctx.response.body = { error: "unauthorized_client" };
    }
});

app
    .use(router.routes())
    .use(router.allowedMethods());

const port = parseInt(process.env.PORT || "8080");
logger.info({ port }, "Started up and listening.")
app.listen(port);
