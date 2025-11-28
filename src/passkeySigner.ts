import { createWebAuthnCredential, toWebAuthnAccount } from 'viem/account-abstraction';

// We infer the type directly from the function to ensure compatibility
// and extend it with our custom 'credentialId' property.
export type WebAuthnSigner = ReturnType<typeof toWebAuthnAccount> & {
    credentialId: string;
};

export const WebAuthnSigner = {
    // 1. Static method to Create/Register a new Passkey
    async create(username: string): Promise<WebAuthnSigner> {
        // Use viem's native helper to create the credential
        const credential = await createWebAuthnCredential({
            name: username,
        });

        // Store credential for future logins
        localStorage.setItem("passkey_credential", JSON.stringify(credential));

        // Create the Account compatible with permissionless/viem
        const account = toWebAuthnAccount({ credential });

        // Return the account augmented with credentialId
        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    },

    // 2. Static method to Login
    async login(): Promise<WebAuthnSigner> {
        const stored = localStorage.getItem("passkey_credential");
        if (!stored) throw new Error("No passkey found. Register first.");

        const credential = JSON.parse(stored);

        const account = toWebAuthnAccount({ credential });

        return {
            ...account,
            credentialId: credential.id,
        } as WebAuthnSigner;
    }
};