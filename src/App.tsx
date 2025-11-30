import { useState, useEffect } from "react";
import {
  type Address,
  formatEther,
  type Hex,
  toHex,
  hexToBigInt
} from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { publicClient, rhinestoneConfig } from "./clients";
import { WebAuthnSigner } from "./passkeySigner";
import "./App.css";
import { createRhinestoneAccount, type RhinestoneAccount } from "@rhinestone/sdk";

// --- TYPES ---
type StoredSafe = {
  name: string;
  address: Address;
  salt: Hex; // Storing as Hex is fine, we convert to BigInt for usage
  owners: string[]; // list of usernames
};

// --- CONSTANTS ---
const SAFES_STORAGE_KEY = "demo_app_safes";
const USER_1 = "User 1";
const USER_2 = "User 2";

function App() {
  // Auth State
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);

  // Safe Management State
  const [storedSafes, setStoredSafes] = useState<StoredSafe[]>([]);
  const [activeSafe, setActiveSafe] = useState<RhinestoneAccount | null>(null);
  const [activeSafeAddress, setActiveSafeAddress] = useState<Address | null>(null);
  const [isCreatingSafe, setIsCreatingSafe] = useState(false);

  // Dashboard State
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<string>("0");

  const addLog = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Load Safes from Storage on Mount
  useEffect(() => {
    const saved = localStorage.getItem(SAFES_STORAGE_KEY);
    if (saved) {
      setStoredSafes(JSON.parse(saved));
    }
  }, []);

  // --- 1. AUTHENTICATION ---

  const handleAuth = async (username: string) => {
    try {
      setLoading(true);
      const isRegistered = WebAuthnSigner.isRegistered(username);

      let webAuthnSigner: WebAuthnSigner;

      if (isRegistered) {
        addLog(`Logging in as ${username}...`);
        webAuthnSigner = await WebAuthnSigner.login(username);
      } else {
        addLog(`Registering new passkey for ${username}...`);
        webAuthnSigner = await WebAuthnSigner.register(username);
      }

      setSigner(webAuthnSigner);
      setCurrentUser(username);
      addLog(`Authenticated as ${username}`);

      // Reset active safe on user switch
      setActiveSafe(null);
      setActiveSafeAddress(null);

    } catch (e: any) {
      addLog(`Auth Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setSigner(null);
    setCurrentUser(null);
    setActiveSafe(null);
    setLogs([]);
  };

  // --- 2. SAFE CREATION & SELECTION ---

  const createNewSafe = async (addCoOwner: boolean) => {
    if (!signer || !currentUser) return;
    setLoading(true);
    setIsCreatingSafe(true);

    try {
      // 1. Generate a random 32-byte salt (Hex)
      const saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      // 2. Convert to BigInt for the Safe 'nonce' parameter
      const nonceBigInt = hexToBigInt(saltHex);

      const safeName = `Safe #${storedSafes.length + 1} (${currentUser}'s)`;

      addLog(`Initializing new Safe: ${safeName}`);

      const owners: any[] = [signer];
      const ownerNames = [currentUser];

      // Handle Co-Owner (User 2)
      if (addCoOwner) {
        const user2Cred = WebAuthnSigner.getCredential(USER_2);
        if (!user2Cred) {
          throw new Error("User 2 is not registered yet. Cannot add as co-owner.");
        }
        // Reconstruct User 2's account object from stored credential
        const user2Account = toWebAuthnAccount({ credential: user2Cred });
        owners.push(user2Account);
        ownerNames.push(USER_2);
        addLog("Added User 2 as initial co-owner.");
      }

      // Initialize Rhinestone Account
      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: {
          type: 'safe',
          nonce: nonceBigInt // Safe uses 'nonce' (BigInt) inside the account object
        },
        owners: {
          type: 'passkey',
          accounts: owners
        },
      });

      const address = account.getAddress();

      // Store Metadata
      const newSafeMeta: StoredSafe = {
        name: safeName,
        address,
        salt: saltHex, // Store as Hex to easily save in localStorage
        owners: ownerNames
      };

      const updatedSafes = [...storedSafes, newSafeMeta];
      setStoredSafes(updatedSafes);
      localStorage.setItem(SAFES_STORAGE_KEY, JSON.stringify(updatedSafes));

      addLog(`Safe Created! Address: ${address}`);

      // Automatically select the new safe
      setActiveSafe(account);
      setActiveSafeAddress(address);

    } catch (e: any) {
      console.error(e);
      addLog(`Creation Error: ${e.message}`);
    } finally {
      setLoading(false);
      setIsCreatingSafe(false);
    }
  };

  const selectSafe = async (safeMeta: StoredSafe) => {
    if (!signer || !currentUser) return;
    setLoading(true);
    addLog(`Loading Safe: ${safeMeta.name}...`);

    try {
      // 1. Reconstruct the full list of owners to ensure the InitCode (and Address) matches
      const allOwners = safeMeta.owners.map((username) => {
        const cred = WebAuthnSigner.getCredential(username);
        if (!cred) throw new Error(`Credential for ${username} missing from localStorage`);
        return toWebAuthnAccount({ credential: cred });
      });

      // 2. Convert stored Hex salt back to BigInt
      const nonceBigInt = hexToBigInt(safeMeta.salt);

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: {
          type: 'safe',
          nonce: nonceBigInt
        },
        owners: {
          type: 'passkey',
          accounts: allOwners // Pass ALL original owners, not just the current signer
        },
      });

      const address = account.getAddress();

      if (address !== safeMeta.address) {
        addLog(`⚠️ CRITICAL: Address mismatch! Expected ${safeMeta.address}, got ${address}`);
      } else {
        addLog("Safe loaded successfully.");
      }

      setActiveSafe(account);
      setActiveSafeAddress(address);
      fetchBalance(address);

    } catch (e: any) {
      console.error(e);
      addLog(`Selection Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchBalance = async (addr: Address) => {
    try {
      const bal = await publicClient.getBalance({ address: addr });
      setBalance(formatEther(bal));
    } catch (e) {
      console.error(e);
    }
  };

  // --- 3. SAFE ACTIONS ---

  const deploySafe = async () => {
    if (!activeSafe || !activeSafeAddress || !signer) return; // Ensure signer exists
    setLoading(true);
    try {
      addLog("Checking deployment status...");
      const code = await publicClient.getBytecode({ address: activeSafeAddress });
      if (code) {
        addLog("Safe is already deployed.");
        setLoading(false);
        return;
      }

      addLog("Deploying Safe...");

      const tx = await activeSafe.sendTransaction({
        chain: publicClient.chain,
        calls: [{ to: activeSafeAddress, value: 0n, data: "0x" }],
        sponsored: true,
        // 🔑 FIX: Explicitly tell the SDK to ONLY use the current user's passkey
        signers: {
          type: 'owner',
          kind: 'passkey',
          accounts: [signer]
        }
      });

      addLog(`Deploy Intent: ${tx.id}`);
      await activeSafe.waitForExecution(tx);
      addLog("✅ Safe Deployed successfully.");
    } catch (e: any) {
      console.error(e);
      addLog(`Deploy Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // --- RENDER HELPERS ---

  if (!currentUser) {
    return (
      <div className="app-container">
        <header><h1>Safe Multi-User Demo</h1></header>
        <div className="auth-card dashboard-card">
          <h3>Select User</h3>
          <p className="subtitle">Choose a persona to test with. Data is stored in localStorage.</p>
          <div className="action-grid">
            <button
              className="primary"
              onClick={() => handleAuth(USER_1)}
              disabled={loading}
            >
              {WebAuthnSigner.isRegistered(USER_1) ? `Login as ${USER_1}` : `Register ${USER_1}`}
            </button>
            <button
              className="primary"
              onClick={() => handleAuth(USER_2)}
              disabled={loading}
            >
              {WebAuthnSigner.isRegistered(USER_2) ? `Login as ${USER_2}` : `Register ${USER_2}`}
            </button>
          </div>
        </div>
        <div className="console-container">
          {logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
        </div>
      </div>
    );
  }

  // Logged In View
  return (
    <div className="app-container">
      <header>
        <h1>Safe Multi-User Demo</h1>
        <div className="auth-section">
          <div className="logged-in-badge">👤 {currentUser}</div>
          <button onClick={logout} className="small">Logout</button>
        </div>
      </header>

      {/* SAFE LIST / CREATION */}
      {!activeSafe && (
        <div className="dashboard-card">
          <h3>My Safes</h3>

          {storedSafes.length > 0 ? (
            <div className="safe-list">
              {storedSafes.map((safe, idx) => (
                <div key={idx} className="status-item safe-item" onClick={() => selectSafe(safe)}>
                  <div>
                    <div className="safe-name">{safe.name}</div>
                    <div className="safe-addr">{safe.address.slice(0, 8)}...{safe.address.slice(-6)}</div>
                  </div>
                  <button disabled={loading}>Select</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="subtitle">No Safes found locally.</p>
          )}

          <hr style={{ borderColor: 'var(--border-color)', margin: '1.5rem 0' }} />

          <h3>Create New Safe</h3>
          <div className="create-section">
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  id="addCoOwner"
                  disabled={currentUser === USER_2 || !WebAuthnSigner.isRegistered(USER_2)}
                />
                <span>Add {USER_2} as signer immediately?</span>
              </label>
              {currentUser !== USER_2 && !WebAuthnSigner.isRegistered(USER_2) && (
                <small style={{ color: 'var(--text-secondary)', marginLeft: '1.5rem' }}>
                  (Register User 2 first to enable this)
                </small>
              )}
            </div>

            <button
              className="primary"
              onClick={() => {
                const cb = document.getElementById('addCoOwner') as HTMLInputElement;
                createNewSafe(cb?.checked || false);
              }}
              disabled={loading || isCreatingSafe}
            >
              {isCreatingSafe ? "Creating..." : "+ Create New Safe"}
            </button>
          </div>
        </div>
      )}

      {/* ACTIVE SAFE DASHBOARD */}
      {activeSafe && activeSafeAddress && (
        <div className="dashboard-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Active Safe</h3>
            <button onClick={() => { setActiveSafe(null); setActiveSafeAddress(null); }}>Back to List</button>
          </div>

          <div className="address-container">
            <span className="label">Address:</span>
            <code className="address-text">{activeSafeAddress}</code>
          </div>
          <div className="status-item">
            <span>Balance:</span>
            <span className="status-value">{balance} ETH</span>
          </div>

          <div className="action-grid" style={{ marginTop: '1.5rem' }}>
            <button className="primary" onClick={deploySafe} disabled={loading}>
              Deploy Safe
            </button>
            <button onClick={() => fetchBalance(activeSafeAddress)} disabled={loading}>
              Refresh Balance
            </button>
          </div>
        </div>
      )}

      <div className="console-container">
        {logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
      </div>
    </div>
  );
}

export default App;