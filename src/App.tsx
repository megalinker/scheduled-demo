import { useState, useEffect } from "react";
import {
  type Address,
  parseEther,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { publicClient, rhinestoneConfig } from "./clients";
import { WebAuthnSigner } from "./passkeySigner";
import "./App.css";
import { createRhinestoneAccount, type RhinestoneAccount, type Session } from "@rhinestone/sdk";
import { installModule } from "@rhinestone/sdk/actions";
import { enableSession } from "@rhinestone/sdk/actions/smart-sessions";

// ABI for Nexus/Safe to check for installed modules
const MODULE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "cursor", type: "address" },
      { internalType: "uint256", name: "size", type: "uint256" }
    ],
    name: "getValidatorsPaginated",
    outputs: [
      { internalType: "address[]", name: "array", type: "address[]" },
      { internalType: "address", name: "next", type: "address" }
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SENTINEL_ADDRESS = "0x0000000000000000000000000000000000000001";
const SMART_SESSIONS_VALIDATOR_ADDRESS = "0x00000000008bdaba73cd9815d79069c247eb4bda";

// Helper to handle BigInt serialization for LocalStorage
const serializeSession = (key: Hex, session: any) => {
  return JSON.stringify({ key, session }, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
};

function App() {
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);
  const [rhinestoneAccount, setRhinestoneAccount] = useState<RhinestoneAccount | null>(null);
  const [accountAddress, setAccountAddress] = useState<Address | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [moduleStatus, setModuleStatus] = useState<{ hasValidator: boolean; hasExecutor: boolean } | null>(null);
  const [hasStoredSession, setHasStoredSession] = useState(false);

  const addLog = (msg: string) => setLogs((prev) => [...prev, msg]);

  // Check for stored session on load
  useEffect(() => {
    const stored = localStorage.getItem("demo_session_data");
    if (stored) setHasStoredSession(true);
  }, []);

  // --- NEW HELPER: Fetch Balance ---
  const logCurrentBalance = async (label: string = "Current Balance") => {
    if (!accountAddress) return 0n;
    try {
      const balance = await publicClient.getBalance({ address: accountAddress });
      const formatted = formatEther(balance);
      addLog(`💰 ${label}: ${formatted} ETH`);
      return balance;
    } catch (e) {
      addLog(`Failed to fetch balance: ${e}`);
      return 0n;
    }
  };

  // 1. Authentication & Account Setup
  const handleAuth = async (mode: "register" | "login") => {
    try {
      setLoading(true);

      const uniqueUsername = `demo-user-${Date.now()}`;
      const webAuthnSigner = mode === "register"
        ? await WebAuthnSigner.create(uniqueUsername)
        : await WebAuthnSigner.login();

      setSigner(webAuthnSigner);
      addLog(`Passkey authenticated. Credential ID: ${webAuthnSigner.credentialId.slice(0, 10)}...`);

      addLog("Initializing Rhinestone SDK and Nexus Account...");

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'nexus' },
        owners: {
          type: 'passkey',
          accounts: [webAuthnSigner],
        },
        sessions: [],
      });

      setRhinestoneAccount(account);
      const address = account.getAddress();
      setAccountAddress(address);
      addLog(`Nexus Address Calculated: ${address}`);

      // Log initial balance upon connection
      const balance = await publicClient.getBalance({ address });
      addLog(`Initial Balance: ${formatEther(balance)} ETH`);

      addLog("Rhinestone Account Client Ready (Sponsored).");

    } catch (e: any) {
      addLog(`Error: ${e.message}`);
      console.error("Full error object:", e);
    } finally {
      setLoading(false);
    }
  };

  // 2. Deploy account
  const sendFirstTx = async () => {
    if (!rhinestoneAccount || !accountAddress) return;
    setLoading(true);
    try {
      addLog("Checking if account is deployed...");
      const code = await publicClient.getBytecode({ address: accountAddress });

      if (!code) {
        addLog("Account not deployed yet. Deployment will happen with this transaction.");
      } else {
        addLog("Account is already deployed.");
      }

      await logCurrentBalance("Balance before deployment");

      addLog("Sending a simple transaction to trigger deployment...");

      const result = await rhinestoneAccount.sendTransaction({
        chain: publicClient.chain,
        calls: [{
          to: accountAddress,
          value: 0n,
          data: '0x',
        }],
        sponsored: true,
      });

      addLog(`Transaction sent! Intent ID: ${result.id}`);
      addLog("Waiting for execution...");

      await rhinestoneAccount.waitForExecution(result);
      addLog("Transaction confirmed. Account is deployed.");
    } catch (e: any) {
      console.error("Full error object:", e);
      addLog(`Error sending transaction: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 3. Create, Store, and Install Session
  const installScheduledTransfer = async () => {
    if (!rhinestoneAccount) return;
    setLoading(true);
    try {
      // Logic Check: Do we have funds?
      const currentBalance = await logCurrentBalance("Check Balance for Session");
      const transferAmount = parseEther("0.00001");

      if (currentBalance < transferAmount) {
        addLog("⚠️ WARNING: Account balance is lower than the intended transfer amount. Please fund your Smart Account address displayed above.");
      }

      addLog("Generating new session key...");

      const sessionPrivateKey = generatePrivateKey();
      const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);

      const targetAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth

      addLog(`Session Scope: Allow transfer of ${formatEther(transferAmount)} ETH to ${targetAddress.slice(0, 6)}...`);
      addLog(`Ephemeral Session Key: ${sessionKeyAccount.address}`);

      const session: Session = {
        owners: {
          type: 'ecdsa',
          accounts: [sessionKeyAccount],
        },
        chain: publicClient.chain,
        policies: [{ type: 'sudo' }],
        actions: [
          {
            target: targetAddress,
            selector: '0x00000000', // Native transfer
            policies: [
              { type: 'value-limit', limit: transferAmount },
              { type: 'usage-limit', limit: 1n } // One time use
            ],
          },
        ],
      };

      addLog("Saving session credentials to local storage...");
      const sessionForStorage = {
        ...session,
        owners: { type: 'ecdsa', accounts: [] }
      };
      localStorage.setItem("demo_session_data", serializeSession(sessionPrivateKey, sessionForStorage));
      setHasStoredSession(true);

      addLog("Sending transaction to install Smart Sessions module and enable session...");

      // We batch two actions:
      // 1. Install the Smart Sessions Validator module on the account (required to use it for signatures)
      // 2. Enable the specific session permission on the validator
      const result = await rhinestoneAccount.sendTransaction({
        chain: publicClient.chain,
        calls: [
          installModule({
            type: "validator",
            address: SMART_SESSIONS_VALIDATOR_ADDRESS,
            initData: "0x", // No init data required for installation
          }),
          enableSession(session)
        ],
        sponsored: true,
      });

      addLog(`Installation sent! ID: ${result.id}`);
      await rhinestoneAccount.waitForExecution(result);
      addLog("✅ Session Installed. You can now execute the transfer without the Passkey.");

    } catch (e: any) {
      console.error("Full error object:", e);
      addLog(`Error installing session: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 4. Execute using the Stored Session (No Passkey needed)
  const executeScheduledTransfer = async () => {
    if (!rhinestoneAccount) return;
    setLoading(true);
    try {
      addLog("Retrieving session from storage...");
      const storedData = localStorage.getItem("demo_session_data");
      if (!storedData) throw new Error("No session found in storage");

      const { key, session: sessionConfig } = JSON.parse(storedData);
      const sessionOwner = privateKeyToAccount(key);

      const session: Session = {
        ...sessionConfig,
        chain: publicClient.chain,
        owners: {
          type: 'ecdsa',
          accounts: [sessionOwner]
        },
        actions: sessionConfig.actions.map((a: any) => ({
          ...a,
          policies: a.policies.map((p: any) => ({
            ...p,
            limit: p.limit ? BigInt(p.limit) : undefined
          }))
        }))
      };

      // --- LOG BALANCE BEFORE ---
      await logCurrentBalance("Balance BEFORE Transfer");

      addLog("Executing transfer using Session Key...");

      const targetAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const transferAmount = parseEther("0.00001"); // Matched amount in installScheduledTransfer

      const result = await rhinestoneAccount.sendUserOperation({
        chain: publicClient.chain,
        calls: [{
          to: targetAddress,
          value: transferAmount,
          data: '0x'
        }],
        signers: {
          type: 'session',
          session: session
        }
      });

      addLog(`Execution sent via Session! UserOp Hash: ${result.hash}`);

      await rhinestoneAccount.waitForExecution(result);

      addLog("✅ Transfer Successful! Verified via Smart Session.");

      // --- LOG BALANCE AFTER ---
      await logCurrentBalance("Balance AFTER Transfer");

      localStorage.removeItem("demo_session_data");
      setHasStoredSession(false);

    } catch (e: any) {
      console.error("Full error object:", e);
      addLog(`Execution failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const checkModules = async () => {
    if (!accountAddress) return;
    setLoading(true);
    try {
      addLog("Reading installed modules...");
      const code = await publicClient.getBytecode({ address: accountAddress });
      if (!code) {
        addLog("Account not deployed yet.");
        return;
      }

      const [modules] = await publicClient.readContract({
        address: accountAddress,
        abi: MODULE_ABI,
        functionName: "getValidatorsPaginated",
        args: [SENTINEL_ADDRESS, 10n]
      });

      const hasValidator = modules.length > 0;
      setModuleStatus({ hasValidator, hasExecutor: hasValidator });
      addLog(`Found ${modules.length} validators: ${modules.join(", ")}`);

    } catch (e: any) {
      addLog(`Error checking modules: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>Nexus + Passkeys + Sessions</h1>
        <div className="subtitle">Gasless Modular Smart Account Demo</div>
      </header>

      <div className="auth-section">
        {!signer ? (
          <>
            <button className="primary" onClick={() => handleAuth("register")} disabled={loading}>
              Register New Passkey
            </button>
            <button onClick={() => handleAuth("login")} disabled={loading}>
              Login Existing
            </button>
          </>
        ) : (
          <div className="logged-in-badge">
            <span>●</span> Passkey Active
          </div>
        )}
      </div>

      {signer && (
        <div className="dashboard-card">
          <h3>Account Actions</h3>

          <div className="address-container">
            <span className="label">Nexus Address:</span>
            <code className="address-text">{accountAddress || "Calculating..."}</code>
          </div>

          <div className="action-grid">
            <button className="primary" onClick={sendFirstTx} disabled={loading || !rhinestoneAccount}>
              1. Deploy Account
            </button>

            <button onClick={installScheduledTransfer} disabled={loading || !rhinestoneAccount || hasStoredSession}>
              2. Create & Store Session
            </button>

            <button
              className={hasStoredSession ? "primary" : ""}
              onClick={executeScheduledTransfer}
              disabled={loading || !rhinestoneAccount || !hasStoredSession}
            >
              3. Execute with Session
            </button>

            <button onClick={checkModules} disabled={loading || !rhinestoneAccount}>
              Verify Modules
            </button>
          </div>
        </div>
      )}

      {moduleStatus && (
        <div className="dashboard-card">
          <h4>On-Chain Status</h4>
          <div className="status-grid">
            <div className="status-item">
              <span>Validators Installed</span>
              <span className={`status-value ${moduleStatus.hasValidator ? "status-success" : "status-error"}`}>
                {moduleStatus.hasValidator ? "YES" : "NO"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="console-container">
        {logs.length === 0 && <div className="log-entry">System ready. Waiting for actions...</div>}
        {logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
      </div>
    </div>
  );
}

export default App;