import { ITokens, ITokenStorage } from "../token-storage";

export default class FirestoreTokenStorage implements ITokenStorage {
    constructor() {
        
    }

    async load(deviceId: string, provider: string): Promise<ITokens> {
        throw new Error("Method not implemented.");
    }
    
    async save(deviceId: string, provider: string, tokens: ITokens): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async delete(deviceId: string, provider: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

}
