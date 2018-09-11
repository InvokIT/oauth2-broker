type RefreshToken = string;

export interface ITokenStorage {
    load(deviceId: string, provider: string): Promise<RefreshToken | null>;
    save(deviceId: string, provider: string, refreshToken: RefreshToken): Promise<void>
    delete(deviceId: string, provider: string): Promise<void>
}
