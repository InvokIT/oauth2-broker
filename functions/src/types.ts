export interface OAuth2ProviderConfig {
    authorization_uri: string,
    client_id: string,
    client_secret: string,
    // user_uri: string,
    revoke_uri: string,
    scope: string | null,
    token_uri: string,
    [proprietary: string]: string
}

export interface OAuth2AuthRequestParams {
    client_id: string,
    redirect_uri: string,
    response_type: "code",
    scope: string,
    state: string
};

export interface OAuth2AuthSuccessResponse {
    code: string,
    state: string
}

export interface OAuth2ErrorResponse {
    error: "invalid_request"
    | "unauthorized_client"
    | "access_denied"
    | "unsupported_response_type"
    | "invalid_scope"
    | "server_error"
    | "temporarily_unavailable",
    error_description?: string,
    error_uri?: string,
    state?: string
}

export interface OAuth2TokenRequestParams {
    client_id: string,
    client_secret: string,
    code: string,
    grant_type: "authorization_code",
    redirect_uri: string
}

export interface OAuth2RefreshRequestParams {
    client_id: string,
    client_secret: string,
    refresh_token: string,
    grant_type: "refresh_token",
}

export interface OAuth2TokenResponse {
    access_token: string,
    expires_in: number | null,
    refresh_token: string | null,
    token_type: "Bearer"
}
