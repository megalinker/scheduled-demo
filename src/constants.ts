import { getAddress } from "viem";

export const CHAIN_ID = 84532; // Base Sepolia

// We use getAddress() to ensure these are valid, checksummed addresses 
// to prevent runtime errors in viem.
export const ENTRYPOINT_ADDRESS_V07 = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");

// Safe 1.4.1 Singleton
export const SAFE_SINGLETON_ADDRESS = getAddress("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");

// Safe 4337 Module (Canonical)
export const SAFE_4337_MODULE_ADDRESS = getAddress("0x75cf11467937ce3F2f357CE24ffc9437809C64c5");

// Safe 7579 Adapter (Rhinestone Adapter for Safe)
export const SAFE_7579_ADAPTER_ADDRESS = getAddress("0x7579d6Dd6F1e9F57729a59049174ed6Fd7fC0003");