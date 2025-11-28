import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const PIMLICO_API_KEY = import.meta.env.VITE_PIMLICO_API_KEY;
const BASE_SEPOLIA_RPC = import.meta.env.VITE_BASE_SEPOLIA_RPC;

export const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC),
});

// Configuration for the Rhinestone SDK
export const rhinestoneConfig = {
    bundler: {
        type: 'pimlico',
        apiKey: PIMLICO_API_KEY!,
    },
    paymaster: {
        type: 'pimlico',
        apiKey: PIMLICO_API_KEY!,
    },
    provider: {
        type: 'custom',
        urls: {
            [baseSepolia.id]: BASE_SEPOLIA_RPC!,
        }
    }
} as const;