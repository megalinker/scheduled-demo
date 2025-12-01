import {
    type Address,
    bytesToHex,
    encodeAbiParameters,
    type Hex,
    hexToBytes,
    keccak256,
    type Chain
} from 'viem';
import { arbitrum, arbitrumSepolia, base, baseSepolia, optimism, optimismSepolia, polygon } from 'viem/chains';

// --- (This code is correct from the previous step) ---

interface WebAuthnSignatureData {
    authenticatorData: Hex;
    clientDataJSON: string;
    challengeIndex: bigint;
    typeIndex: bigint;
    r: bigint;
    s: bigint;
}

export function parsePublicKey(publicKey: Hex | Uint8Array): {
    x: bigint;
    y: bigint;
} {
    const bytes =
        typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey;
    const offset = bytes.length === 65 ? 1 : 0;
    const x = bytes.slice(offset, 32 + offset);
    const y = bytes.slice(32 + offset, 64 + offset);
    return {
        x: BigInt(bytesToHex(x)),
        y: BigInt(bytesToHex(y)),
    };
}

export function parseSignature(signature: Hex | Uint8Array): {
    r: bigint;
    s: bigint;
} {
    const bytes =
        typeof signature === 'string' ? hexToBytes(signature) : signature;
    const r = bytes.slice(0, 32);
    const s = bytes.slice(32, 64);
    return {
        r: BigInt(bytesToHex(r)),
        s: BigInt(bytesToHex(s)),
    };
}

export function generateCredentialId(
    pubKeyX: bigint,
    pubKeyY: bigint,
    account: Address,
) {
    return keccak256(
        encodeAbiParameters(
            [
                { type: 'uint256' },
                { type: 'uint256' },
                { type: 'address' },
            ],
            [pubKeyX, pubKeyY, account],
        ),
    );
}

export function packSignatures(
    credIds: Hex[],
    usePrecompile: boolean,
    webAuthns: WebAuthnSignatureData[],
): Hex {
    const credIdsAndWebAuthns = credIds.map((credId, index) => ({
        credId,
        webAuthn: webAuthns[index],
    }));

    // --- THE CRITICAL FIX: Sort numerically to match on-chain behavior ---
    credIdsAndWebAuthns.sort((a, b) => {
        const aBigInt = BigInt(a.credId);
        const bBigInt = BigInt(b.credId);
        if (aBigInt < bBigInt) return -1;
        if (aBigInt > bBigInt) return 1;
        return 0;
    });

    // --- OLD INCORRECT CODE ---
    // credIdsAndWebAuthns.sort((a, b) => a.credId.localeCompare(b.credId));

    const sortedCredIds = credIdsAndWebAuthns.map(({ credId }) => credId);
    const sortedWebAuthns = credIdsAndWebAuthns.map(({ webAuthn }) => webAuthn);

    return encodeAbiParameters(
        [
            { type: 'bytes32[]', name: 'credIds' },
            { type: 'bool', name: 'usePrecompile' },
            {
                type: 'tuple[]',
                name: 'webAuthns',
                components: [
                    { type: 'bytes', name: 'authenticatorData' },
                    { type: 'string', name: 'clientDataJSON' },
                    { type: 'uint256', name: 'challengeIndex' },
                    { type: 'uint256', name: 'typeIndex' },
                    { type: 'uint256', name: 'r' },
                    { type: 'uint256', name: 's' },
                ],
            },
        ],
        [sortedCredIds, usePrecompile, sortedWebAuthns],
    );
}

export function isRip7212SupportedNetwork(chain: Chain) {
    const supportedChains: Chain[] = [
        optimism,
        optimismSepolia,
        polygon,
        base,
        baseSepolia,
        arbitrum,
        arbitrumSepolia,
    ];
    return supportedChains.some(c => c.id === chain.id);
}