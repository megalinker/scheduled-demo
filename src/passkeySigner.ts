import { createWebAuthnCredential, toWebAuthnAccount } from 'viem/account-abstraction';

// Helper to log BigInts
const jsonLog = (label: string, data: any) => {
    console.log(`[PasskeySigner] ${label}:`, JSON.stringify(data, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v
        , 2));
};

export type WebAuthnSigner = ReturnType<typeof toWebAuthnAccount> & {
    credentialId: string;
};

export const WebAuthnSigner = {
    // 1. Static method to Create/Register a new Passkey
    async create(username: string): Promise<WebAuthnSigner> {
        console.log(`[PasskeySigner] Creating new credential for user: ${username}`);

        // Use viem's native helper to create the credential
        const credential = await createWebAuthnCredential({
            name: username,
        });

        jsonLog("Raw Created Credential", credential);

        // Store credential for future logins
        localStorage.setItem("passkey_credential", JSON.stringify(credential));

        // Create the Account compatible with permissionless/viem
        const account = toWebAuthnAccount({ credential });

        jsonLog("Generated WebAuthn Account Object", {
            type: account.type,
            publicKey: account.publicKey,
            id: account.id
        });

        // Return the account augmented with credentialId
        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    },

    // 2. Static method to Login
    async login(): Promise<WebAuthnSigner> {
        console.log("[PasskeySigner] Attempting login...");
        const stored = localStorage.getItem("passkey_credential");

        if (!stored) {
            console.error("[PasskeySigner] No credential found in localStorage");
            throw new Error("No passkey found. Register first.");
        }

        const credential = JSON.parse(stored);
        jsonLog("Retrieved Stored Credential", credential);

        const account = toWebAuthnAccount({ credential });

        jsonLog("Reconstructed WebAuthn Account Object", {
            type: account.type,
            publicKey: account.publicKey,
            id: account.id
        });

        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    }
};