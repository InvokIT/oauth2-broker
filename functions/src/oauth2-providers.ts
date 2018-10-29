import { createLogger } from "bunyan";
import { config } from "firebase-functions";
import { OAuth2ProviderConfig } from "./types";

const logger = createLogger({ name: "oauth2-providers" });


export const dropbox: OAuth2ProviderConfig = {
    authorization_uri: "https://www.dropbox.com/oauth2/authorize",
    // client_id: process.env.DROPBOX_CLIENT_ID,
    // client_secret: process.env.DROPBOX_CLIENT_SECRET,
    client_id: config().oauth2.providers.dropbox.client_id,
    client_secret: config().oauth2.providers.dropbox.client_secret,
    force_reapprove: "true",
    // user_uri: "https://api.dropboxapi.com/2/users/get_current_account",
    revoke_uri: "https://api.dropboxapi.com/2/auth/token/revoke",
    scope: null,
    token_uri: "https://api.dropboxapi.com/oauth2/token"
};

if (!dropbox.client_id || !dropbox.client_secret) {
    logger.error({
        client_id: dropbox.client_id, client_secret: !!dropbox.client_secret
    }, "Missing dropbox client_id or client_secret. Dropbox auth will likely not work!");
}


export const google: OAuth2ProviderConfig = {
    access_type: "offline",
    authorization_uri: "https://accounts.google.com/o/oauth2/v2/auth",
    // client_id: process.env.GOOGLE_CLIENT_ID,
    // client_secret: process.env.GOOGLE_CLIENT_SECRET,
    client_id: config().oauth2.providers.google.client_id,
    client_secret: config().oauth2.providers.google.client_secret,
    prompt: "select_account",
    // user_uri: "",
    revoke_uri: "https://accounts.google.com/o/oauth2/revoke",
    scope: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/photoslibrary.readonly",
    token_uri: "https://www.googleapis.com/oauth2/v4/token"
};

if (!google.client_id || !google.client_secret) {
    logger.error({
        client_id: google.client_id, client_secret: !!google.client_secret
    }, "Missing google client_id or client_secret. Google auth will likely not work!");
}
