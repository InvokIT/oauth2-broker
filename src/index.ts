import bunyan from "bunyan";
import { randomBytes as _randomBytes } from "crypto";
import fetch from "node-fetch";
import httpStatus from "http-status";
import Koa from "koa";
import pify from "pify";
import koaBunyanLogger from "koa-bunyan-logger";
import Router from "koa-router";
import querystring from "querystring";
import * as oauth2Providers from "./oauth2-providers";

const randomBytes = pify(_randomBytes);

const STATE_SIZE = 128;

interface OAuth2AuthRequestParams {
    client_id: string,
    redirect_uri: string,
    response_type: "code",
    scope: string,
    state: string
};

interface OAuth2AuthSuccessResponse {
    code: string,
    state: string
}

interface OAuth2ErrorResponse {
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

interface OAuth2TokenRequestParams {
    client_id: string,
    client_secret: string,
    code: string,
    grant_type: "authorization_code",
    redirect_uri: string
}

interface OAuth2TokenResponse {
    access_token: string,
    expires_in?: number,
    refresh_token: string,
    token_type: "Bearer"
}

const APP_RETURN_URI = process.env.APP_RETURN_URI;

const logger = bunyan.createLogger({ name: "index" });

if (!APP_RETURN_URI) {
    logger.error("APP_RETURN_URI is not defined!");
    process.exit(1);
}

const isOAuth2ErrorResponse = (res: any): res is OAuth2ErrorResponse => {
    return !!res.error;
}

const app = new Koa();
app.proxy = true;

app.use(koaBunyanLogger());
app.use((koaBunyanLogger as any).requestIdContext());
app.use((koaBunyanLogger as any).requestLogger({
    updateLogFields: function (fields) {
        fields.device_id = this.request.get("X-Device-Id");
    }
}));

// Read device id from header and set it on ctx.state
app.use((ctx, next) => {
    const headerField = "X-Device-Id";

    const deviceId = ctx.get(headerField) || ctx.cookies.get("device-id");

    ctx.assert(deviceId, httpStatus.BAD_REQUEST, "Missing device id.");

    ctx.state.deviceId = deviceId;

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

    const state = (await randomBytes(STATE_SIZE)).toString("base64");

    const requestParams: OAuth2AuthRequestParams = {
        client_id: provider.client_id,
        redirect_uri: createRedirectUri(ctx),
        response_type: "code",
        scope: provider.scope,
        state: state
    }

    ctx.cookies.set("oauth2-state", state, { secure: true });
    ctx.cookies.set("device-id", ctx.state.deviceId);

    ctx.redirect(`${provider.authorization_uri}?${querystring.stringify(requestParams)}`);
});

router.get("/callback/:provider", async (ctx, next) => {
    const oauthResponse: OAuth2AuthSuccessResponse | OAuth2ErrorResponse = ctx.query;

    const cookieState = ctx.cookies.get("oauth2-state");
    const deviceId = ctx.cookies.get("device-id");
    const providerName = ctx.params.provider;

    // Clear cookies
    ctx.cookies.set("oauth2-state");
    ctx.cookies.set("device-id");

    const responseState = oauthResponse.state;

    if (cookieState !== responseState) {
        logger.warn({
            device_id: deviceId,
            oauth_provider: providerName,
            oauth_response: oauthResponse,
            cookie_state: cookieState
        }, "cookieState did not match responseState.");

        ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ error: "unequal_state" })}`);
        return;
    } else if (isOAuth2ErrorResponse(oauthResponse)) {
        logger.warn({
            device_id: deviceId,
            oauth_provider: providerName,
            oauth_response: oauthResponse
        }, "OAuth2 provider returned an error.");

        ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ error: oauthResponse.error })}`);
        return;
    } else {
        const authCode = oauthResponse.code;
        const provider: oauth2Providers.OAuth2ProviderConfig = ctx.state.provider;
        const tokenRequestParams: OAuth2TokenRequestParams = {
            client_id: provider.client_id,
            code: authCode,
            client_secret: provider.client_secret,
            grant_type: "authorization_code",
            redirect_uri: createRedirectUri(ctx)
        };

        const res = await fetch(provider.token_uri, {
            body: querystring.stringify(tokenRequestParams),
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            method: "POST"
        });

        const resBody: OAuth2TokenResponse | OAuth2ErrorResponse = await res.json();

        if (res.ok) {
            const { access_token, expires_in, refresh_token } = (resBody as OAuth2TokenResponse);
            // TODO Save tokens and redirect client
            // tokenStorage.save({ provider: providerName, device: deviceId, refreshToken: refresh_token });
            ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ provider: provider, access_token: access_token })}`);
        } else {
            const errorCode = (resBody as OAuth2ErrorResponse).error;
            logger.warn({
                device_id: deviceId,
                oauth_provider: providerName,
                oauth_token_response_status: res.status,
                oauth_token_response_error: errorCode
            }, "OAuth2 token request failed.");

            ctx.redirect(`${APP_RETURN_URI}#${querystring.stringify({ provider: provider, error: errorCode })}`);
            return;
        }
    }
});

router.get("/token/:provider", (ctx, next) => {
    // TODO Load refresh_token then request a new access_token and return that
});

app
    .use(router.routes())
    .use(router.allowedMethods());
