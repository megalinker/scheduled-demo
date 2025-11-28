# Safe + Passkeys + ERC-7579 Demo

A modern Account Abstraction (ERC-4337) demonstration built with **React**, **Viem**, and **Permissionless.js**.

This project demonstrates how to create a **Safe (v1.4.1)** Smart Account authenticated via **WebAuthn (Passkeys)**, sponsor gas fees using a Paymaster, and install the **ERC-7579 Adapter** to make the Safe compatible with the modular smart account standard.

## ⚡ Features

*   **Passkey Authentication:** Register and login using FaceID, TouchID, or YubiKeys (powered by native WebAuthn).
*   **Safe Smart Account:** Automatically computes and deploys a Safe v1.4.1 address based on the Passkey signer.
*   **Gasless Transactions:** All transactions are sponsored by the Pimlico Verifying Paymaster.
*   **Modular Architecture:** Demonstrates how to install the **Safe 7579 Adapter** module on-chain.
*   **Module Inspector:** View installed Safe modules and verify adapter status directly from the UI.
*   **Interactive Console:** Real-time in-app logs to understand the step-by-step blockchain interactions.

## 🛠 Tech Stack

*   **Frontend:** React, TypeScript, Vite
*   **Blockchain Interaction:** [Viem](https://viem.sh/)
*   **Account Abstraction:** [Permissionless.js](https://docs.permissionless.js.org/)
*   **Smart Accounts:** Safe v1.4.1
*   **Infrastructure:** [Pimlico](https://pimlico.io/) (Bundler & Paymaster)
*   **Chain:** Base Sepolia (Testnet)

## 🚀 Getting Started

### Prerequisites

*   Node.js (v18+)
*   A [Pimlico](https://dashboard.pimlico.io/) API Key (for Base Sepolia).
*   A Base Sepolia RPC URL (you can use a public one or a provider like Alchemy/Infura).

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/megalinker/safe-passkey-4337-7579
    cd safe-passkey-4337-7579
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

3.  **Environment Configuration:**
    Create a `.env` file in the root directory based on the following template:

    ```env
    # .env
    VITE_PIMLICO_API_KEY=your_pimlico_api_key_here
    VITE_BASE_SEPOLIA_RPC=https://sepolia.base.org
    ```

4.  **Run the application:**
    ```bash
    npm run dev
    ```

5.  Open your browser to `http://localhost:5173`.

## 📖 Usage Guide

1.  **Register:** Click **"Register New Passkey"**. Your browser will prompt you to create a passkey (TouchID/FaceID).
    *   *Note: Credentials are stored in `localStorage` for this demo.*
2.  **Login:** If you refresh the page, click **"Login Existing"** to restore your session.
3.  **Deploy & Install:** Click **"Deploy & Install 7579"**.
    *   This sends a UserOperation.
    *   If the Safe isn't deployed yet, it deploys the Safe **and** installs the adapter in a single batch (or sequential logic depending on the bundler).
    *   The transaction is gasless (sponsored).
4.  **Verify:** Click **"Verify Modules"**.
    *   The app queries the blockchain (`getModulesPaginated`).
    *   It checks if the Safe 7579 Adapter address is present in the module list.

## 🧩 Key Components

### `src/App.tsx`
The main UI logic. It handles the flow of authentication, initializing the `SmartAccountClient`, and constructing the transaction to call `enableModule` on the Safe contract.

### `src/passkeySigner.ts`
A wrapper around Viem's `toWebAuthnAccount`. It handles the creation and retrieval of WebAuthn credentials using the browser's native API and stores the Credential ID in LocalStorage to simulate a persistent user session.

### `src/clients.ts`
Initializes the Viem `PublicClient` and the Permissionless `PimlicoClient`. This is where the connection to the Bundler and Paymaster is established.

### `src/constants.ts`
Contains critical contract addresses:
*   **Entrypoint v0.7**
*   **Safe 7579 Adapter:** `0x7579d6Dd6F1e9F57729a59049174ed6Fd7fC0003` (Rhinestone Adapter).

## ⚠️ Important Notes

*   **Browser Support:** Passkeys require a secure context (HTTPS) or `localhost`. This might not work on HTTP over a local network IP.
*   **Testnet Only:** This is configured for **Base Sepolia**. Do not use real funds.
*   **Demo Storage:** Passkey credentials are stored in `localStorage`. In a production app, you should store the `credentialId` in a backend database mapped to the user.

## 📄 License

MIT