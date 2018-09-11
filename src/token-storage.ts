export interface ITokens {
    access_token: string,
    expires_at: number,
    refresh_token: string | null
}

export interface ITokenStorage {
    load(deviceId: string, provider: string): Promise<ITokens | null>;
    save(deviceId: string, provider: string, tokens: ITokens): Promise<void>;
    delete(deviceId: string, provider: string): Promise<void>;
}

export class MemoryTokenStorage implements ITokenStorage {
    private readonly tokens: { [device_id: string]: null | { [provider: string]: null | ITokens } } = {};

    async load(deviceId: string, provider: string): Promise<ITokens> {
        const deviceTokens = this.tokens[deviceId];

        if (deviceTokens) {
            const providerToken = deviceTokens[provider];

            if (providerToken) {
                return providerToken;
            }
        }

        return null;
    }

    async save(deviceId: string, provider: string, tokens: ITokens): Promise<void> {
        let deviceTokens = this.tokens[deviceId];

        if (!deviceTokens) {
            deviceTokens = this.tokens[deviceId] = {};
        }

        deviceTokens[provider] = tokens;
    }

    async delete(deviceId: string, provider: string): Promise<void> {
        const deviceTokens = this.tokens[deviceId];

        if (deviceTokens && deviceTokens[provider]) {
            delete deviceTokens[provider];
        }
    }
}
