import { useState, useEffect } from "react";
import {
  type Address,
  parseEther,
  formatEther,
  type Hex
} from "viem";
import { hexToBytes, bytesToBigInt } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { publicClient, rhinestoneConfig } from "./clients";
import { WebAuthnSigner } from "./passkeySigner";
import { addOwner as addPasskeyOwner, changeThreshold } from "@rhinestone/sdk/actions/passkeys";
import "./App.css";
import { createRhinestoneAccount, type RhinestoneAccount, type Session } from "@rhinestone/sdk";
import { enableSession } from "@rhinestone/sdk/actions/smart-sessions";
import { installModule } from "@rhinestone/sdk/actions";

type TxProposal = {
  id: string;
  description: string;
  calls: {
    to: Address;
    value: bigint;
    data: Hex;
  }[];
};

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

// --- DEBUG HELPER ---
const debugLog = (label: string, data?: any) => {
  if (data === undefined) {
    console.log(`%c[DEBUG] ${label}`, "color: #00bcd4; font-weight: bold;");
  } else {
    console.log(
      `%c[DEBUG] ${label}:`, "color: #00bcd4; font-weight: bold;",
      JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
    );
  }
};

// Helper to handle BigInt serialization for LocalStorage
const serializeSession = (key: Hex, session: any) => {
  const data = JSON.stringify({ key, session }, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  debugLog("Serialized Session Data for Storage", data);
  return data;
};

const getPasskeyCoords = (publicKey: Hex) => {
  debugLog("Parsing Passkey Public Key", publicKey);
  const bytes = hexToBytes(publicKey); // Uint8Array
  const x = bytesToBigInt(bytes.slice(0, 32));
  const y = bytesToBigInt(bytes.slice(32, 64));
  debugLog("Passkey Coords", { x, y });
  return { x, y };
};

function App() {
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);
  const [rhinestoneAccount, setRhinestoneAccount] = useState<RhinestoneAccount | null>(null);
  const [accountAddress, setAccountAddress] = useState<Address | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [moduleStatus, setModuleStatus] = useState<{ hasValidator: boolean; hasExecutor: boolean } | null>(null);
  const [hasStoredSession, setHasStoredSession] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<TxProposal | null>(null);


  const addLog = (msg: string) => setLogs((prev) => [...prev, msg]);

  // Check for stored session on load
  useEffect(() => {
    const stored = localStorage.getItem("demo_session_data");
    if (stored) {
      debugLog("Found existing session in localStorage", stored);
      setHasStoredSession(true);
    }
  }, []);

  // --- NEW HELPER: Fetch Balance ---
  const logCurrentBalance = async (label: string = "Current Balance") => {
    if (!accountAddress) return 0n;
    try {
      const balance = await publicClient.getBalance({ address: accountAddress });
      const formatted = formatEther(balance);
      addLog(`💰 ${label}: ${formatted} ETH`);
      debugLog(`Balance [${label}]`, { raw: balance, formatted });
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
      debugLog(`--- AUTH STARTED (${mode}) ---`);

      const uniqueUsername = `demo-user-${Date.now()}`;
      debugLog("Username", uniqueUsername);

      const webAuthnSigner = mode === "register"
        ? await WebAuthnSigner.create(uniqueUsername)
        : await WebAuthnSigner.login();

      setSigner(webAuthnSigner);
      debugLog("WebAuthn Signer Ready", {
        credentialId: webAuthnSigner.credentialId,
        publicKey: webAuthnSigner.publicKey
      });

      addLog(`Passkey authenticated. Credential ID: ${webAuthnSigner.credentialId.slice(0, 10)}...`);

      addLog("Initializing Rhinestone SDK and Safe Account...");

      const accountConfig = {
        ...rhinestoneConfig,
        account: {
          type: 'safe' as const,
        },
        owners: {
          type: 'passkey' as const,
          accounts: [webAuthnSigner],
        },
        sessions: [],
      };

      debugLog("createRhinestoneAccount Config", accountConfig);

      const account = await createRhinestoneAccount(accountConfig);

      debugLog("Rhinestone Account Object Created", account);

      setRhinestoneAccount(account);
      const address = account.getAddress();
      setAccountAddress(address);

      debugLog("Calculated Smart Account Address", address);
      addLog(`Safe Account Address: ${address}`);

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
    debugLog("--- DEPLOY ACCOUNT CLICKED ---");

    try {
      addLog("Checking if account is deployed...");
      const code = await publicClient.getBytecode({ address: accountAddress });
      debugLog("Account Bytecode", code);

      if (!code) {
        addLog("Account not deployed yet. Deployment will happen with this transaction.");
      } else {
        addLog("Account is already deployed.");
      }

      await logCurrentBalance("Balance before deployment");

      addLog("Sending a simple transaction to trigger deployment...");

      const txPayload = {
        chain: publicClient.chain,
        calls: [{
          to: accountAddress,
          value: 0n,
          data: '0x' as Hex,
        }],
        sponsored: true,
      };
      debugLog("Deploy Transaction Payload", txPayload);

      const result = await rhinestoneAccount.sendTransaction(txPayload);

      debugLog("Deploy Transaction Result (UserOp Hash)", result);
      addLog(`Transaction sent! Intent ID: ${result.id}`);
      addLog("Waiting for execution...");

      const receipt = await rhinestoneAccount.waitForExecution(result);
      debugLog("Deploy Execution Receipt", receipt);

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
    if (!rhinestoneAccount || !accountAddress) return;
    setLoading(true);
    debugLog("--- INSTALL SESSION CLICKED ---");

    try {
      // 1) Check balance (same as before)
      const transferAmount = parseEther("0.00001");
      const currentBalance = await logCurrentBalance("Check Balance for Session");

      if (currentBalance < transferAmount) {
        addLog(
          "⚠️ WARNING: Account balance is lower than the intended transfer amount. Please fund your Smart Account address displayed above."
        );
      }

      // 2) Build session in memory (DO NOT store it yet)
      addLog("Generating new session key...");

      const sessionPrivateKey = generatePrivateKey();
      debugLog("🔑 GENERATED SESSION PRIVATE KEY (Ephemeral)", sessionPrivateKey);

      const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
      debugLog("Session Account Address", sessionKeyAccount.address);

      const targetAddress =
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth

      addLog(
        `Session Scope: Allow transfer of ${formatEther(
          transferAmount
        )} ETH to ${targetAddress.slice(0, 6)}...`
      );
      addLog(`Ephemeral Session Key: ${sessionKeyAccount.address}`);

      const session: Session = {
        owners: {
          type: "ecdsa",
          accounts: [sessionKeyAccount],
        },
        chain: publicClient.chain,
        policies: [{ type: "sudo" }],
        actions: [
          {
            target: targetAddress,
            // Native transfer selector for Smart Sessions
            selector: "0x00000000",
            policies: [
              { type: "value-limit", limit: transferAmount },
              { type: "usage-limit", limit: 1n }, // One time use
            ],
          },
        ],
      };

      debugLog("Constructed Session Object", session);

      // 3) Check if Smart Sessions validator is already installed
      addLog("Checking if Smart Sessions validator is already installed...");
      let validators: Address[] = [];

      try {
        const [modules] = await publicClient.readContract({
          address: accountAddress,
          abi: MODULE_ABI,
          functionName: "getValidatorsPaginated",
          // Sentinel pattern used by Nexus
          args: [SENTINEL_ADDRESS as Address, 10n],
        });

        validators = modules as Address[];
        debugLog("Fetched On-Chain Validators", validators);
      } catch (err) {
        debugLog("Error reading validators (expected if undeployed)", err);
        addLog(
          "Could not read validators (account may be freshly deployed). Assuming no Smart Sessions validator installed."
        );
      }

      const hasSmartSessionsValidator = validators.some(
        (v) => v.toLowerCase() === SMART_SESSIONS_VALIDATOR_ADDRESS.toLowerCase()
      );

      const calls: any[] = [];

      if (!hasSmartSessionsValidator) {
        addLog(
          "Smart Sessions validator not found. Installing it on the account..."
        );
        const installCall = installModule({
          type: "validator",
          address: SMART_SESSIONS_VALIDATOR_ADDRESS,
          initData: "0x", // No init data required
        });
        debugLog("Adding installModule Call", installCall);
        calls.push(installCall);
      } else {
        addLog(
          "Smart Sessions validator already installed. Skipping installation."
        );
      }

      addLog("Enabling session on-chain...");
      const enableSessionCall = enableSession(session);
      debugLog("Adding enableSession Call", enableSessionCall);
      calls.push(enableSessionCall);

      addLog(
        "Sending transaction to install (if needed) and enable the session..."
      );

      const txPayload = {
        chain: publicClient.chain,
        calls,
        sponsored: true,
      };
      debugLog("Session Installation TX Payload", txPayload);

      const result = await rhinestoneAccount.sendTransaction(txPayload);

      debugLog("Session Installation Result (UserOp Hash)", result);
      addLog(`Installation / enableSession intent sent! ID: ${result.id}`);

      const receipt = await rhinestoneAccount.waitForExecution(result);
      debugLog("Session Installation Receipt", receipt);

      addLog(
        "✅ Session Installed / Enabled. You can now execute the transfer without the Passkey."
      );

      // 4) Only save to localStorage AFTER on-chain success
      addLog("Saving session credentials to local storage...");
      const sessionForStorage = {
        ...session,
        owners: { type: "ecdsa", accounts: [] }, // strip accounts before storing
      };

      debugLog("Session Object stripped for storage", sessionForStorage);

      localStorage.setItem(
        "demo_session_data",
        serializeSession(sessionPrivateKey as Hex, sessionForStorage)
      );
      setHasStoredSession(true);
    } catch (e: any) {
      console.error("Full error object:", e);
      addLog(`Error installing session: ${e.message}`);

      // Make sure we don’t keep a stale session flag around
      localStorage.removeItem("demo_session_data");
      setHasStoredSession(false);
    } finally {
      setLoading(false);
    }
  };

  const addExtraPasskeyOwner = async () => {
    if (!rhinestoneAccount) return;
    setLoading(true);

    try {
      addLog("Creating a new passkey for an extra owner...");

      // Create a *new* passkey credential (on this or another device)
      const newSigner = await WebAuthnSigner.create(
        `demo-coowner-${Date.now()}`
      );

      addLog(
        `New passkey co-owner registered. Credential ID: ${newSigner.credentialId.slice(
          0,
          10
        )}...`
      );

      // Convert the passkey's public key into (x, y) coords
      const { x: pubKeyX, y: pubKeyY } = getPasskeyCoords(
        newSigner.publicKey as Hex
      );

      const requiresUV = false; // or true if you want to enforce user verification

      addLog("Sending tx to add passkey co-owner to the multisig...");

      // On-chain: add this passkey as an owner in the WebAuthn validator
      const tx = await rhinestoneAccount.sendTransaction({
        chain: publicClient.chain,
        calls: [addPasskeyOwner(pubKeyX, pubKeyY, requiresUV)],
        sponsored: true,
      });

      addLog(`addOwner intent sent! ID: ${tx.id}`);
      await rhinestoneAccount.waitForExecution(tx);

      addLog("✅ Extra passkey owner added to the account (multisig-ready).");

    } catch (e: any) {
      console.error("Full error object (addExtraPasskeyOwner):", e);
      addLog(`Error adding passkey owner: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 4. Execute using the Stored Session (No Passkey needed)
  const executeScheduledTransfer = async () => {
    if (!rhinestoneAccount) return;
    setLoading(true);
    debugLog("--- EXECUTE SESSION CLICKED ---");

    try {
      addLog("Retrieving session from storage...");
      const storedData = localStorage.getItem("demo_session_data");
      debugLog("Raw Stored Data", storedData);

      if (!storedData) throw new Error("No session found in storage");

      const { key, session: sessionConfig } = JSON.parse(storedData);
      debugLog("Parsed Storage Data (Key)", key);
      debugLog("Parsed Storage Data (Config)", sessionConfig);

      const sessionOwner = privateKeyToAccount(key);
      debugLog("Restored Session Account Address", sessionOwner.address);

      // Rebuild the Session with proper BigInts & owner
      const parsedActions =
        (sessionConfig.actions ?? []).map((a: any) => ({
          ...a,
          policies: a.policies.map((p: any) => ({
            ...p,
            limit: p.limit ? BigInt(p.limit) : undefined,
          })),
        }));

      const session: Session = {
        ...sessionConfig,
        chain: publicClient.chain,
        owners: {
          type: "ecdsa",
          accounts: [sessionOwner],
        },
        actions: parsedActions,
      };

      debugLog("Fully Reconstructed Session Object", session);

      // Take target + amount from the session itself (so it ALWAYS matches)
      if (!session.actions || session.actions.length === 0) {
        throw new Error("Session has no actions configured");
      }

      // Take target + amount from the first action
      const action = session.actions[0] as any;
      const targetAddress = action.target as Address;
      const transferAmount =
        (action.policies.find((p: any) => p.type === "value-limit")?.limit as bigint) ??
        parseEther("0.00001");

      debugLog("Extracted Action Details", { targetAddress, transferAmount });

      await logCurrentBalance("Balance BEFORE Transfer");

      addLog("Executing transfer using Session Key...");

      const userOpPayload = {
        chain: publicClient.chain,
        calls: [
          {
            to: targetAddress,
            value: transferAmount,
            // 🔑 IMPORTANT: use the same selector allowed in the session
            data: action.selector,
          },
        ],
        signers: {
          type: "session" as const,
          session,
        },
      };

      debugLog("sendUserOperation Payload", userOpPayload);

      const result = await rhinestoneAccount.sendUserOperation(userOpPayload);

      debugLog("Execution Result (UserOp Hash)", result);
      addLog(`Execution sent via Session! UserOp Hash: ${result.hash}`);

      const receipt = await rhinestoneAccount.waitForExecution(result);
      debugLog("Execution Receipt", receipt);

      addLog("✅ Transfer Successful! Verified via Smart Session.");

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

  const setThresholdToTwo = async () => {
    if (!rhinestoneAccount) return;
    setLoading(true);

    try {
      addLog("Updating passkey multisig threshold to 2-of-N...");

      const tx = await rhinestoneAccount.sendTransaction({
        chain: publicClient.chain,
        calls: [changeThreshold(2)], // 2-of-N
        sponsored: true,
      });

      addLog(`changeThreshold intent sent! ID: ${tx.id}`);
      await rhinestoneAccount.waitForExecution(tx);

      addLog("✅ Threshold updated to 2-of-N. You now need 2 valid passkey signatures per tx.");
    } catch (e: any) {
      console.error("setThresholdToTwo error:", e);
      addLog(`Error changing threshold: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const refreshOwners = async () => {
    if (!rhinestoneAccount) return;

    try {
      const owners = await rhinestoneAccount.getOwners(publicClient.chain);
      addLog(
        `Owners: ${owners?.accounts.length} | threshold: ${owners?.threshold.toString()}`
      );
    } catch (e: any) {
      console.error("refreshOwners error:", e);
      addLog(`Error fetching owners: ${e.message}`);
    }
  };

  const proposeTransfer = async () => {
    if (!accountAddress) {
      addLog("Cannot propose tx: account address missing.");
      return;
    }

    const transferAmount = parseEther("0.00002");
    const target = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address; // vitalik.eth

    const proposal: TxProposal = {
      id: `proposal-${Date.now()}`,
      description: `Send ${formatEther(transferAmount)} ETH to ${target.slice(0, 6)}...`,
      calls: [
        {
          to: target,
          value: transferAmount,
          data: "0x" as Hex,
        },
      ],
    };

    setPendingProposal(proposal);
    addLog(`📄 Proposal created: ${proposal.id} — ${proposal.description}`);

    // In a real app, you'd also sync this proposal to a backend / DB
    // so User 2 can see it from a different device.
  };

  const approveAndExecuteProposal = async () => {
    if (!rhinestoneAccount) {
      addLog("No Rhinestone account available.");
      return;
    }
    if (!pendingProposal) {
      addLog("No pending proposal to execute.");
      return;
    }
    if (!signer) {
      addLog("No active passkey signer.");
      return;
    }

    setLoading(true);
    try {
      await logCurrentBalance("Balance BEFORE proposed tx");

      addLog(
        `User approving proposal ${pendingProposal.id} — ${pendingProposal.description}`
      );

      const result = await rhinestoneAccount.sendTransaction({
        chain: publicClient.chain,
        calls: pendingProposal.calls,
        // For passkeys multisig the SDK will route to the WebAuthn validator.
        // For threshold=1, this single signer is enough.
        sponsored: true,
      });

      addLog(`Multisig tx sent! Intent ID: ${result.id}`);
      await rhinestoneAccount.waitForExecution(result);
      addLog("✅ Proposed transaction executed.");

      await logCurrentBalance("Balance AFTER proposed tx");

      setPendingProposal(null);
    } catch (e: any) {
      console.error("approveAndExecuteProposal error:", e);
      addLog(`Error executing proposal: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const checkModules = async () => {
    if (!accountAddress) return;
    setLoading(true);
    debugLog("--- VERIFY MODULES CLICKED ---");

    try {
      addLog("Reading installed validators...");
      const code = await publicClient.getBytecode({ address: accountAddress });
      debugLog("Account Bytecode", code);

      if (!code) {
        addLog("Account not deployed yet.");
        return;
      }

      const [modules] = await publicClient.readContract({
        address: accountAddress,
        abi: MODULE_ABI,
        functionName: "getValidatorsPaginated",
        args: [SENTINEL_ADDRESS as Address, 10n],
      });

      debugLog("Raw Modules Response", modules);

      const validators = modules as Address[];
      const hasSmartSessionsValidator = validators.some(
        (m) => m.toLowerCase() === SMART_SESSIONS_VALIDATOR_ADDRESS.toLowerCase()
      );

      debugLog("Parsed Validators List", validators);
      debugLog("Smart Session Validator Detected?", hasSmartSessionsValidator);

      setModuleStatus({
        hasValidator: hasSmartSessionsValidator,
        hasExecutor: hasSmartSessionsValidator,
      });

      if (validators.length === 0) {
        addLog("No validators installed.");
      } else {
        addLog(`Found validators: ${validators.join(", ")}`);
      }
    } catch (e: any) {
      debugLog("Error checking modules", e);
      addLog(`Error checking modules: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>Safe + Passkeys + Sessions</h1>
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
            <span className="label">Safe Address:</span>
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

            <button onClick={addExtraPasskeyOwner} disabled={loading || !rhinestoneAccount}>
              Add Extra Passkey Owner (Multisig)
            </button>

            {/* NEW: Multisig config */}
            <button onClick={setThresholdToTwo} disabled={loading || !rhinestoneAccount}>
              Set Threshold to 2-of-N
            </button>
            <button onClick={refreshOwners} disabled={loading || !rhinestoneAccount}>
              Refresh Owners / Threshold
            </button>

            {/* NEW: Proposal / approval */}
            <button onClick={proposeTransfer} disabled={loading || !rhinestoneAccount}>
              Propose Transfer (User 1)
            </button>
            <button
              onClick={approveAndExecuteProposal}
              disabled={loading || !rhinestoneAccount || !pendingProposal}
            >
              Approve & Execute Proposal (User 2)
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