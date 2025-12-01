//--- File: src/App.tsx ---

import { useState, useEffect } from "react";
import {
  type Address,
  formatEther,
  type Hex,
  toHex,
  hexToBigInt,
  concat
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
  salt: Hex;
  owners: string[];
  threshold: number;
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
  preparedUserOp: any; // Stored PreparedUserOperationData
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

function App() {
  // Auth State
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);

  // Safe Management State
  const [storedSafes, setStoredSafes] = useState<StoredSafe[]>([]);
  const [activeSafe, setActiveSafe] = useState<RhinestoneAccount | null>(null);
  const [activeSafeAddress, setActiveSafeAddress] = useState<Address | null>(null);
  const [activeSafeThreshold, setActiveSafeThreshold] = useState<number>(1);

  // Creation Form State
  const [creationThreshold, setCreationThreshold] = useState(1);

  // Proposals State
  const [proposals, setProposals] = useState<PendingProposal[]>([]);

  // Dashboard State
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

      // Fix BigInts in the preparedUserOp.userOperation object
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

  // Save proposals whenever they change
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

    try {
      const saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const nonceBigInt = hexToBigInt(saltHex);

      const owners: any[] = [signer];
      const ownerNames = [currentUser];

      if (addCoOwner) {
        const user2Cred = WebAuthnSigner.getCredential(USER_2);
        if (!user2Cred) throw new Error("User 2 not registered locally.");
        owners.push(toWebAuthnAccount({ credential: user2Cred }));
        ownerNames.push(USER_2);
      }

      if (creationThreshold > owners.length) {
        throw new Error(`Threshold (${creationThreshold}) cannot be greater than owners (${owners.length})`);
      }

      const safeName = `Safe #${storedSafes.length + 1} (${creationThreshold}/${owners.length})`;
      addLog(`Creating ${safeName}...`);

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: nonceBigInt },
        owners: {
          type: 'passkey',
          accounts: owners,
          threshold: creationThreshold
        },
      });

      const address = account.getAddress();

      const newSafeMeta: StoredSafe = {
        name: safeName,
        address,
        salt: saltHex,
        owners: ownerNames,
        threshold: creationThreshold
      };

      const updatedSafes = [...storedSafes, newSafeMeta];
      setStoredSafes(updatedSafes);
      localStorage.setItem(SAFES_STORAGE_KEY, JSON.stringify(updatedSafes));

      addLog(`Safe Created! Address: ${address}`);
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
      const allOwners = safeMeta.owners.map((username) => {
        const cred = WebAuthnSigner.getCredential(username);
        if (!cred) throw new Error(`Credential for ${username} missing`);
        return toWebAuthnAccount({ credential: cred });
      });

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: hexToBigInt(safeMeta.salt) },
        owners: {
          type: 'passkey',
          accounts: allOwners,
          threshold: safeMeta.threshold
        },
      });

      const address = account.getAddress();
      if (address !== safeMeta.address) {
        addLog(`⚠️ Address Mismatch! Expected ${safeMeta.address}, got ${address}`);
      }

      setActiveSafe(account);
      setActiveSafeAddress(address);
      setActiveSafeThreshold(safeMeta.threshold);
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
      addLog("Preparing deployment proposal...");

      // 1. Prepare the UserOp
      // 🔑 CRITICAL: Specify 'signers' here so the SDK knows ONLY the current user is signing this step.
      const preparedOp = await activeSafe.prepareUserOperation({
        chain: publicClient.chain,
        calls: [{ to: activeSafeAddress, value: 0n, data: "0x" as Hex }],
        signers: {
          type: 'owner',
          kind: 'passkey',
          accounts: [signer]
        }
      });

      // 2. Sign with CURRENT user
      addLog("Signing with current user...");
      const signedOp = await activeSafe.signUserOperation(preparedOp);

      // Extract the signature (This is User 1's signature)
      const user1Signature = signedOp.signature;

      const newProposal: PendingProposal = {
        id: `proposal-${Date.now()}`,
        safeAddress: activeSafeAddress,
        description: "Deploy Safe (Initial Transaction)",
        calls: [{ to: activeSafeAddress, value: 0n, data: "0x" }],
        signatures: [{ signerName: currentUser!, signature: user1Signature }],
        // 🔑 FIX: Access nonce from nested userOperation object
        nonce: preparedOp.userOperation.nonce.toString(),
        preparedUserOp: preparedOp
      };

      setProposals(prev => [...prev, newProposal]);
      addLog(`📄 Proposal created! ID: ${newProposal.id}`);
      addLog(`Signatures: 1/${activeSafeThreshold}`);

      if (activeSafeThreshold === 1) {
        addLog("Threshold is 1. Executing immediately...");
        await executeProposal(newProposal, [user1Signature]);
      } else {
        addLog("Waiting for more signatures...");
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
      addLog(`Signing proposal ${proposal.id} as ${currentUser}...`);

      // 🔑 FIX: Clone the stored preparedOp and update the 'signers' in the transaction config
      // This forces the SDK to use the *current* user's passkey to sign the existing Hash.
      const opForSigning = {
        ...proposal.preparedUserOp,
        transaction: {
          ...proposal.preparedUserOp.transaction,
          signers: {
            type: 'owner',
            kind: 'passkey',
            accounts: [signer] // Override with current signer
          }
        }
      };

      const signedOp = await activeSafe.signUserOperation(opForSigning);

      const newSignature = signedOp.signature;

      // Update proposal in state
      const updatedProposals = proposals.map(p => {
        if (p.id === proposal.id) {
          const updatedP = {
            ...p,
            signatures: [...p.signatures, { signerName: currentUser!, signature: newSignature }]
          };

          addLog(`Signed! Total signatures: ${updatedP.signatures.length}/${activeSafeThreshold}`);
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
    addLog("🚀 Threshold met. Executing transaction on-chain...");

    try {
      // 1. Concatenate signatures for Safe
      const combinedSignature = concat(signatures);

      // 2. Construct SignedUserOperationData
      const signedOpData = {
        ...proposal.preparedUserOp,
        signature: combinedSignature
      };

      // 3. Submit
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
                <div style={{ fontSize: '0.8rem' }}>Threshold: {safe.threshold}/{safe.owners.length}</div>
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
              Create Safe
            </button>
          </div>
        </div>
      )}

      {activeSafe && (
        <>
          <div className="dashboard-card">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h3>Active Safe ({activeSafeThreshold}-of-N)</h3>
              <button onClick={() => setActiveSafe(null)}>Back</button>
            </div>
            <div className="status-item"><span>Address:</span> <code className="address-text">{activeSafeAddress}</code></div>
            <div className="status-item"><span>Balance:</span> <span>{balance} ETH</span></div>

            <div className="action-grid" style={{ marginTop: '1rem' }}>
              <button className="primary" onClick={createProposal} disabled={loading}>
                {activeSafeThreshold === 1 ? "Deploy (Exec)" : "Propose Deployment"}
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
                return (
                  <div key={p.id} className="status-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ fontWeight: 'bold' }}>{p.description}</div>
                    <div style={{ fontSize: '0.8rem', color: '#888' }}>Signatures: {p.signatures.length} / {activeSafeThreshold}</div>
                    <div style={{ fontSize: '0.8rem' }}>Signed by: {p.signatures.map(s => s.signerName).join(", ")}</div>

                    {!hasSigned && p.signatures.length < activeSafeThreshold && (
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