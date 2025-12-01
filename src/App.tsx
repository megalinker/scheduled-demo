import { useState, useEffect } from "react";
import {
  type Address,
  formatEther,
  type Hex,
  toHex,
  hexToBigInt,
  hexToBytes,
  bytesToBigInt,
  concat
} from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { addOwner as addPasskeyOwner, changeThreshold } from "@rhinestone/sdk/actions/passkeys";
import { publicClient, rhinestoneConfig } from "./clients";
import { WebAuthnSigner } from "./passkeySigner";
import "./App.css";
import { createRhinestoneAccount, type RhinestoneAccount } from "@rhinestone/sdk";

// --- TYPES ---

type StoredSafe = {
  name: string;
  address: Address;
  salt: Hex;
  genesisOwner: string; // The owner used to derive the address
  currentOwners: string[]; // The actual owners on-chain
  threshold: number;
  isDeployed: boolean;
};

type ProposalSignature = {
  signerName: string;
  signature: Hex;
};

type PendingProposal = {
  id: string;
  safeAddress: Address;
  description: string;
  calls: { to: Address; value: bigint; data: Hex }[];
  signatures: ProposalSignature[];
  nonce: string;
  preparedUserOp: any;
};

// --- CONSTANTS ---
const SAFES_STORAGE_KEY = "demo_app_safes";
const PROPOSALS_STORAGE_KEY = "demo_app_proposals";
const USER_1 = "User 1";
const USER_2 = "User 2";

// --- HELPERS ---

const restoreUserOpBigInts = (op: any) => {
  if (!op) return op;
  const bigIntFields = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value'];
  const newOp = { ...op };
  bigIntFields.forEach(field => {
    if (newOp[field] && typeof newOp[field] === 'string') {
      newOp[field] = hexToBigInt(newOp[field] as Hex);
    }
  });
  return newOp;
};

const getPasskeyCoords = (publicKey: Hex) => {
  const bytes = hexToBytes(publicKey);
  const x = bytesToBigInt(bytes.slice(0, 32));
  const y = bytesToBigInt(bytes.slice(32, 64));
  return { x, y };
};

function App() {
  // Auth State
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);

  // Safe Management State
  const [storedSafes, setStoredSafes] = useState<StoredSafe[]>([]);
  const [activeSafe, setActiveSafe] = useState<RhinestoneAccount | null>(null);
  const [activeSafeAddress, setActiveSafeAddress] = useState<Address | null>(null);
  const [activeSafeThreshold, setActiveSafeThreshold] = useState<number>(1);

  // Creation Form
  const [creationThreshold, setCreationThreshold] = useState(1);

  // Proposals
  const [proposals, setProposals] = useState<PendingProposal[]>([]);

  // Dashboard
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<string>("0");

  const addLog = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // --- INITIALIZATION ---

  useEffect(() => {
    const savedSafes = localStorage.getItem(SAFES_STORAGE_KEY);
    if (savedSafes) setStoredSafes(JSON.parse(savedSafes));

    const savedProposals = localStorage.getItem(PROPOSALS_STORAGE_KEY);
    if (savedProposals) {
      const parsed = JSON.parse(savedProposals);
      const restored = parsed.map((p: PendingProposal) => ({
        ...p,
        preparedUserOp: {
          ...p.preparedUserOp,
          userOperation: restoreUserOpBigInts(p.preparedUserOp.userOperation)
        }
      }));
      setProposals(restored);
    }
  }, []);

  useEffect(() => {
    const serialized = JSON.stringify(proposals, (_, v) => typeof v === 'bigint' ? toHex(v) : v);
    localStorage.setItem(PROPOSALS_STORAGE_KEY, serialized);
  }, [proposals]);


  // --- 1. AUTHENTICATION ---

  const handleAuth = async (username: string) => {
    try {
      setLoading(true);
      const isRegistered = WebAuthnSigner.isRegistered(username);

      let webAuthnSigner: WebAuthnSigner;
      if (isRegistered) {
        webAuthnSigner = await WebAuthnSigner.login(username);
      } else {
        webAuthnSigner = await WebAuthnSigner.register(username);
      }

      setSigner(webAuthnSigner);
      setCurrentUser(username);
      addLog(`Authenticated as ${username}`);

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

  // --- 2. SAFE CREATION (Deploy + Upgrade) ---

  const createNewSafe = async (addCoOwner: boolean) => {
    if (!signer || !currentUser) return;
    setLoading(true);

    try {
      const saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const nonceBigInt = hexToBigInt(saltHex);

      // 1. Initialize as 1-of-1 (Genesis Config)
      addLog("Initializing genesis configuration (1-of-1)...");

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: nonceBigInt },
        owners: {
          type: 'passkey',
          accounts: [signer],
          threshold: 1
        },
      });

      const address = account.getAddress();
      const safeName = `Safe #${storedSafes.length + 1}`;
      addLog(`Calculated Address: ${address}`);

      // 2. Prepare the calls
      let calls: any[] = [];
      const finalOwners = [currentUser];

      if (addCoOwner) {
        addLog("Preparing upgrade transaction (Add User 2)...");
        const user2Cred = WebAuthnSigner.getCredential(USER_2);
        if (!user2Cred) throw new Error("User 2 not registered locally.");

        const { x, y } = getPasskeyCoords(user2Cred.publicKey as Hex);

        // 🔑 FIX: Added 'false' for requireUserVerification
        calls.push(addPasskeyOwner(x, y, false));
        finalOwners.push(USER_2);
      }

      // Change Threshold Call (if needed)
      if (creationThreshold > 1) {
        addLog(`Preparing threshold upgrade to ${creationThreshold}...`);
        calls.push(changeThreshold(creationThreshold));
      }

      // If no upgrade needed, just empty call to trigger deploy
      if (calls.length === 0) {
        calls.push({ to: address, value: 0n, data: "0x" });
      }

      // 3. Send Transaction (Deploy + Upgrade in one go)
      addLog("🚀 Sending Deployment + Setup Transaction...");

      const tx = await account.sendTransaction({
        chain: publicClient.chain,
        calls: calls,
        sponsored: true
      });

      addLog(`Transaction sent! ID: ${tx.id}`);
      await account.waitForExecution(tx);
      addLog("✅ Safe Deployed & Configured!");

      // 4. Save Metadata
      const newSafeMeta: StoredSafe = {
        name: safeName,
        address,
        salt: saltHex,
        genesisOwner: currentUser,
        currentOwners: finalOwners,
        threshold: creationThreshold,
        isDeployed: true
      };

      const updatedSafes = [...storedSafes, newSafeMeta];
      setStoredSafes(updatedSafes);
      localStorage.setItem(SAFES_STORAGE_KEY, JSON.stringify(updatedSafes));

      selectSafe(newSafeMeta);

    } catch (e: any) {
      console.error(e);
      addLog(`Creation Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const selectSafe = async (safeMeta: StoredSafe) => {
    if (!signer || !currentUser) return;
    setLoading(true);
    addLog(`Loading Safe: ${safeMeta.name}...`);

    try {
      // 🔑 CRITICAL: Always initialize with the GENESIS owner (User 1) and Threshold 1
      // This ensures the SDK derives the same Address and InitCode as when it was created.
      // The on-chain state (2-of-2) is handled by our proposal logic.

      const genesisCred = WebAuthnSigner.getCredential(safeMeta.genesisOwner);
      if (!genesisCred) throw new Error("Genesis credential missing");
      const genesisAccount = toWebAuthnAccount({ credential: genesisCred });

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: hexToBigInt(safeMeta.salt) },
        owners: {
          type: 'passkey',
          accounts: [genesisAccount],
          threshold: 1 // Keep as 1 for address derivation
        },
      });

      const address = account.getAddress();
      if (address !== safeMeta.address) {
        addLog(`⚠️ Address Mismatch! Expected ${safeMeta.address}, got ${address}`);
      }

      setActiveSafe(account);
      setActiveSafeAddress(address);
      setActiveSafeThreshold(safeMeta.threshold); // Use the stored threshold for UI logic
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

  // --- 3. MULTI-SIG PROPOSAL LOGIC ---

  const createProposal = async () => {
    if (!activeSafe || !activeSafeAddress || !signer) return;
    setLoading(true);

    try {
      addLog("Preparing proposal...");

      // 1. Prepare UserOp
      // Use current signer for preparation
      const preparedOp = await activeSafe.prepareUserOperation({
        chain: publicClient.chain,
        calls: [{ to: activeSafeAddress, value: 0n, data: "0x" as Hex }],
        signers: {
          type: 'owner',
          kind: 'passkey',
          accounts: [signer]
        }
      });

      // 2. Sign
      addLog("Signing with current user...");
      const signedOp = await activeSafe.signUserOperation(preparedOp);

      const newProposal: PendingProposal = {
        id: `proposal-${Date.now()}`,
        safeAddress: activeSafeAddress,
        description: "Zero Transfer (Test)",
        calls: [{ to: activeSafeAddress, value: 0n, data: "0x" }],
        signatures: [{ signerName: currentUser!, signature: signedOp.signature }],
        nonce: preparedOp.userOperation.nonce.toString(),
        preparedUserOp: preparedOp
      };

      setProposals(prev => [...prev, newProposal]);
      addLog(`📄 Proposal created! Signatures: 1/${activeSafeThreshold}`);

      if (activeSafeThreshold === 1) {
        await executeProposal(newProposal, [signedOp.signature]);
      }

    } catch (e: any) {
      console.error(e);
      addLog(`Proposal Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const signProposal = async (proposal: PendingProposal) => {
    if (!activeSafe || !signer || !currentUser) return;

    if (proposal.signatures.find(s => s.signerName === currentUser)) {
      addLog("You have already signed this proposal.");
      return;
    }

    setLoading(true);
    try {
      addLog(`Signing proposal as ${currentUser}...`);

      // 🔑 Force SDK to use current signer for this specific op
      const opForSigning = {
        ...proposal.preparedUserOp,
        transaction: {
          ...proposal.preparedUserOp.transaction,
          signers: {
            type: 'owner',
            kind: 'passkey',
            accounts: [signer]
          }
        }
      };

      const signedOp = await activeSafe.signUserOperation(opForSigning);

      const updatedProposals = proposals.map(p => {
        if (p.id === proposal.id) {
          const updatedP = {
            ...p,
            signatures: [...p.signatures, { signerName: currentUser!, signature: signedOp.signature }]
          };
          addLog(`Signed! Total: ${updatedP.signatures.length}/${activeSafeThreshold}`);
          return updatedP;
        }
        return p;
      });

      setProposals(updatedProposals);

      const currentProposal = updatedProposals.find(p => p.id === proposal.id);
      if (currentProposal && currentProposal.signatures.length >= activeSafeThreshold) {
        const allSigs = currentProposal.signatures.map(s => s.signature);
        await executeProposal(currentProposal, allSigs);
      }

    } catch (e: any) {
      console.error(e);
      addLog(`Signing Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const executeProposal = async (proposal: PendingProposal, signatures: Hex[]) => {
    if (!activeSafe) return;
    setLoading(true);
    addLog("🚀 Executing transaction on-chain...");

    try {
      // Concatenate signatures
      const combinedSignature = concat(signatures);

      const signedOpData = {
        ...proposal.preparedUserOp,
        signature: combinedSignature
      };

      const result = await activeSafe.submitUserOperation(signedOpData);

      addLog(`UserOp Sent! Hash: ${result.hash}`);
      await activeSafe.waitForExecution(result);
      addLog("✅ Transaction Executed Successfully!");

      setProposals(prev => prev.filter(p => p.id !== proposal.id));

    } catch (e: any) {
      console.error(e);
      addLog(`Execution Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // --- RENDER ---

  if (!currentUser) {
    return (
      <div className="app-container">
        <header><h1>Safe Multi-Sig Demo</h1></header>
        <div className="auth-card dashboard-card">
          <h3>Select User</h3>
          <div className="action-grid">
            <button className="primary" onClick={() => handleAuth(USER_1)}>
              {WebAuthnSigner.isRegistered(USER_1) ? `Login ${USER_1}` : `Register ${USER_1}`}
            </button>
            <button className="primary" onClick={() => handleAuth(USER_2)}>
              {WebAuthnSigner.isRegistered(USER_2) ? `Login ${USER_2}` : `Register ${USER_2}`}
            </button>
          </div>
        </div>
        <div className="console-container">
          {logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <h1>Safe Multi-Sig Demo</h1>
        <div className="auth-section">
          <div className="logged-in-badge">👤 {currentUser}</div>
          <button onClick={logout} className="small">Logout</button>
        </div>
      </header>

      {!activeSafe && (
        <div className="dashboard-card">
          <h3>My Safes</h3>
          <div className="safe-list">
            {storedSafes.map((safe, idx) => (
              <div key={idx} className="status-item safe-item" onClick={() => selectSafe(safe)}>
                <div>
                  <div className="safe-name">{safe.name}</div>
                  <div className="safe-addr">{safe.address.slice(0, 6)}...{safe.address.slice(-4)}</div>
                </div>
                <div style={{ fontSize: '0.8rem' }}>
                  {safe.currentOwners.length} owners • {safe.threshold}-of-N
                </div>
              </div>
            ))}
          </div>

          <hr style={{ borderColor: 'var(--border-color)', margin: '1.5rem 0' }} />

          <h3>Create New Safe</h3>
          <div className="create-section">
            <div className="form-row">
              <label>
                <input type="checkbox" id="addCoOwner" disabled={!WebAuthnSigner.isRegistered(USER_2)} />
                Add {USER_2}?
              </label>

              <label style={{ marginLeft: '1rem' }}>
                Threshold:
                <input
                  type="number"
                  min="1"
                  max="2"
                  value={creationThreshold}
                  onChange={(e) => setCreationThreshold(parseInt(e.target.value))}
                  style={{ width: '50px', marginLeft: '0.5rem', background: '#000', color: '#fff', border: '1px solid #333' }}
                />
              </label>
            </div>

            <button className="primary" onClick={() => {
              const cb = document.getElementById('addCoOwner') as HTMLInputElement;
              createNewSafe(cb?.checked || false);
            }} disabled={loading}>
              Create & Deploy Safe
            </button>
          </div>
        </div>
      )}

      {activeSafe && (
        <>
          <div className="dashboard-card">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h3>Active Safe ({activeSafeThreshold}-of-{storedSafes.find(s => s.address === activeSafeAddress)?.currentOwners.length})</h3>
              <button onClick={() => setActiveSafe(null)}>Back</button>
            </div>
            <div className="status-item"><span>Address:</span> <code className="address-text">{activeSafeAddress}</code></div>
            <div className="status-item"><span>Balance:</span> <span>{balance} ETH</span></div>

            <div className="action-grid" style={{ marginTop: '1rem' }}>
              <button className="primary" onClick={createProposal} disabled={loading}>
                Propose Zero Tx
              </button>
              <button onClick={() => fetchBalance(activeSafeAddress!)}>Refresh Balance</button>
            </div>
          </div>

          {/* PROPOSALS SECTION */}
          {proposals.filter(p => p.safeAddress === activeSafeAddress).length > 0 && (
            <div className="dashboard-card">
              <h3>Pending Proposals</h3>
              {proposals.filter(p => p.safeAddress === activeSafeAddress).map((p) => {
                const hasSigned = p.signatures.find(s => s.signerName === currentUser);
                const currentSafeMeta = storedSafes.find(s => s.address === activeSafeAddress);
                const isSigner = currentSafeMeta?.currentOwners.includes(currentUser!);

                return (
                  <div key={p.id} className="status-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ fontWeight: 'bold' }}>{p.description}</div>
                    <div style={{ fontSize: '0.8rem', color: '#888' }}>Signatures: {p.signatures.length} / {activeSafeThreshold}</div>
                    <div style={{ fontSize: '0.8rem' }}>Signed by: {p.signatures.map(s => s.signerName).join(", ")}</div>

                    {!hasSigned && p.signatures.length < activeSafeThreshold && isSigner && (
                      <button className="primary" onClick={() => signProposal(p)} disabled={loading}>
                        Sign Proposal
                      </button>
                    )}

                    {hasSigned && p.signatures.length < activeSafeThreshold && (
                      <div style={{ color: 'var(--accent-color)' }}>Waiting for other signers...</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="console-container">
        {logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
      </div>
    </div>
  );
}

export default App;