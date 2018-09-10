import { randomBytes as _randomBytes } from "crypto";
import Koa from "koa";
import pify from "pify";
import Router from "koa-router";
import querystring from "querystring";
import * as oauth2Providers from "./oauth2-providers";

const randomBytes = pify(_randomBytes);

const STATE_SIZE = 128;

interface OAuth2RequestParams {
    client_id: string,
    redirect_uri: string,
    response_type: "code",
    scope: string,
    state: string
};

const app = new Koa();
app.proxy = true;

const router = new Router();

router.param("provider", (providerName, ctx, next) => {
    ctx.assert(providerName in oauth2Providers, 404);

    ctx.state.provider = oauth2Providers[providerName];

    return next();
});

router.use((ctx, next) => {
    // TODO Read device id from header and set it on ctx.state
});

router.get("/auth/:provider", async (ctx, next) => {
    // ctx.router available
    const provider: oauth2Providers.OAuth2ProviderConfig = ctx.state.provider;

    const state = (await randomBytes(STATE_SIZE)).toString("base64");

    const requestParams: OAuth2RequestParams = {
        client_id: provider.client_id,
        redirect_uri: `${ctx.request.protocol}://${ctx.request.host}/callback/${ctx.params.provider}`,
        response_type: "code",
        scope: provider.scope,
        state: state
    }

    ctx.cookies.set("oauth2-state", state, {secure: true});
    ctx.cookies.set("device-id", );

    ctx.redirect(`${provider.authorization_uri}?${querystring.stringify(requestParams)}`);
});

router.get("/callback/:provider", (ctx, next) => {

});

router.get("/token/:provider", (ctx, next) => {

});

app
    .use(router.routes())
    .use(router.allowedMethods());
