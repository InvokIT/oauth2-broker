import app from "./firebase-app";
import { ITokens, ITokenStorage } from "../token-storage";

interface FirestoreTokens {
    device_id: string,
    provider: string,
    access_token: string,
    expires_at: number | null,
    refresh_token: string | null
}

export default class FirestoreTokenStorage implements ITokenStorage {
    private readonly collectionName: string;
    
    constructor(collection: string) {
        this.collectionName = collection;
    }

    private collection() {
        return app.firestore().collection(this.collectionName);
    }

    async load(deviceId: string, provider: string): Promise<ITokens | null> {
        const keysToGet = ["access_token", "expires_at", "refresh_token"];

        const r = await this.collection()
            .where("device_id", "==", deviceId)
            .where("provider", "==", provider)
            .limit(1)
            .select(...keysToGet)
            .get();

        if (r.empty) {
            return null;
        } else {
            const doc = r.docs[0];
            return keysToGet.reduce((tokens, key) => {
                tokens[key] = doc.get(key);
                return tokens;
            }, {}) as ITokens;
        }
    }

    async save(deviceId: string, provider: string, tokens: ITokens): Promise<void> {
        const lr = await this.collection()
            .where("device_id", "==", deviceId)
            .where("provider", "==", provider)
            .limit(1)
            .select() // Select no fields, only the document reference
            .get();

        const data = {
            device_id: deviceId,
            provider: provider,
            ...tokens
        } as FirestoreTokens;

        if (lr.empty) {
            await this.collection().add(data);
        } else {
            await lr.docs[0].ref.update(tokens);
        }
    }

    async delete(deviceId: string, provider: string): Promise<void> {
        const r = await this.collection()
            .where("device_id", "==", deviceId)
            .where("provider", "==", provider)
            .select() // Select no fields, only the document reference
            .get();

        if (!r.empty) {
            await Promise.all(r.docs.map(d => d.ref.delete()));
        }
    }
}
