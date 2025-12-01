import { createWebAuthnCredential, toWebAuthnAccount, type WebAuthnAccount as ViemWebAuthnAccount } from 'viem/account-abstraction';
import type { Hash } from 'viem';

const USERS_STORAGE_KEY = "demo_app_users";

type ExtendedWebAuthnSigner = Omit<ViemWebAuthnAccount, 'sign'> & {
    sign: (args: { hash: Hash; clientDataJSON?: string }) => ReturnType<ViemWebAuthnAccount['sign']>;
    credentialId: string;
};

// Use our new, more accurate type.
export type WebAuthnSigner = ExtendedWebAuthnSigner;

export const WebAuthnSigner = {
    // Check if a user is already registered
    isRegistered(username: string): boolean {
        const store = JSON.parse(localStorage.getItem(USERS_STORAGE_KEY) || "{}");
        return !!store[username];
    },

    // Get raw credential (useful for adding User 2 as owner without logging them in)
    getCredential(username: string) {
        const store = JSON.parse(localStorage.getItem(USERS_STORAGE_KEY) || "{}");
        return store[username];
    },

    // 1. Register a specific user (User 1 or User 2)
    async register(username: string): Promise<WebAuthnSigner> {
        console.log(`[PasskeySigner] Registering ${username}...`);

        const credential = await createWebAuthnCredential({
            name: username,
        });

        // Save to dictionary
        const store = JSON.parse(localStorage.getItem(USERS_STORAGE_KEY) || "{}");
        store[username] = credential;
        localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(store));

        const account = toWebAuthnAccount({ credential });

        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    },

    // 2. Login as a specific user
    async login(username: string): Promise<WebAuthnSigner> {
        console.log(`[PasskeySigner] Logging in as ${username}...`);
        const store = JSON.parse(localStorage.getItem(USERS_STORAGE_KEY) || "{}");
        const credential = store[username];

        if (!credential) {
            throw new Error(`User ${username} not found. Please register first.`);
        }

        const account = toWebAuthnAccount({ credential });

        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    }
};