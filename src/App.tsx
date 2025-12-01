import { useState, useEffect } from "react";
import {
  type Address,
  formatEther,
  parseEther,
  type Hex,
  toHex,
  hexToBigInt,
  hexToBytes,
  bytesToBigInt
} from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { addOwner as addPasskeyOwner, changeThreshold } from "@rhinestone/sdk/actions/passkeys";
import { installModule } from "@rhinestone/sdk/actions";
import { enableSession } from "@rhinestone/sdk/actions/smart-sessions";
import { createRhinestoneAccount, type RhinestoneAccount, type Session } from "@rhinestone/sdk";
import { publicClient, rhinestoneConfig } from "./clients";
import { WebAuthnSigner } from "./passkeySigner";
import "./App.css";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// --- TYPES ---

type StoredSafe = {
  name: string;
  address: Address;
  salt: Hex;
  genesisOwner: string;
  currentOwners: string[];
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
const SESSION_STORAGE_KEY = "demo_app_session";
const USER_1 = "User 1";
const USER_2 = "User 2";

const SMART_SESSIONS_ADDRESS = "0x00000000008bdaba73cd9815d79069c247eb4bda";
const SENTINEL_ADDRESS = "0x0000000000000000000000000000000000000001";
const TARGET_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// --- HELPERS ---

const debugLog = (label: string, data?: any) => {
  if (data === undefined) {
    console.log(`%c[DEBUG] ${label}`, "color: #00bcd4; font-weight: bold;");
  } else {
    console.log(
      `%c[DEBUG] ${label}:`, "color: #00bcd4; font-weight: bold;",
      JSON.parse(JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v))
    );
  }
};


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

const checkSessionModule = async (address: Address) => {
  try {
    const [modules] = await publicClient.readContract({
      address,
      abi: [{
        inputs: [{ type: "address" }, { type: "uint256" }],
        name: "getValidatorsPaginated",
        outputs: [{ type: "address[]" }, { type: "address" }],
        stateMutability: "view",
        type: "function",
      }],
      functionName: "getValidatorsPaginated",
      args: [SENTINEL_ADDRESS, 10n],
    }) as [Address[], Address];

    return modules.some(m => m.toLowerCase() === SMART_SESSIONS_ADDRESS.toLowerCase());
  } catch (e) {
    return false;
  }
};

function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [signer, setSigner] = useState<WebAuthnSigner | null>(null);

  const [storedSafes, setStoredSafes] = useState<StoredSafe[]>([]);
  const [activeSafe, setActiveSafe] = useState<RhinestoneAccount | null>(null);
  const [activeSafeAddress, setActiveSafeAddress] = useState<Address | null>(null);
  const [activeSafeThreshold, setActiveSafeThreshold] = useState<number>(1);

  const [creationThreshold, setCreationThreshold] = useState(1);

  const [proposals, setProposals] = useState<PendingProposal[]>([]);
  const [hasStoredSession, setHasStoredSession] = useState(false);

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

    if (localStorage.getItem(SESSION_STORAGE_KEY)) {
      setHasStoredSession(true);
    }
  }, []);

  useEffect(() => {
    const serialized = JSON.stringify(proposals, (_, v) => typeof v === 'bigint' ? toHex(v) : v);
    localStorage.setItem(PROPOSALS_STORAGE_KEY, serialized);
  }, [proposals]);

  // --- AUTH & SAFE LOGIC ---

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

  const createNewSafe = async (addCoOwner: boolean) => {
    if (!signer || !currentUser) return;
    setLoading(true);

    try {
      const saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const nonceBigInt = hexToBigInt(saltHex);

      addLog("Initializing genesis configuration (1-of-1)...");

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: nonceBigInt },
        owners: { type: 'passkey', accounts: [signer], threshold: 1 },
      });

      const address = account.getAddress();
      const safeName = `Safe #${storedSafes.length + 1}`;
      addLog(`Calculated Address: ${address}`);

      let calls: any[] = [];
      const finalOwners = [currentUser];

      if (addCoOwner) {
        addLog("Preparing upgrade (Add User 2)...");
        const user2Cred = WebAuthnSigner.getCredential(USER_2);
        if (!user2Cred) throw new Error("User 2 not registered locally.");
        const { x, y } = getPasskeyCoords(user2Cred.publicKey as Hex);
        calls.push(addPasskeyOwner(x, y, false));
        finalOwners.push(USER_2);
      }

      if (creationThreshold > 1) {
        addLog(`Preparing threshold upgrade to ${creationThreshold}...`);
        calls.push(changeThreshold(creationThreshold));
      }

      if (calls.length === 0) calls.push({ to: address, value: 0n, data: "0x" });

      addLog("🚀 Sending Deployment + Setup Transaction...");
      const tx = await account.sendTransaction({
        chain: publicClient.chain,
        calls: calls,
        sponsored: true
      });

      await account.waitForExecution(tx);
      addLog("✅ Safe Deployed & Configured!");

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
    debugLog("--- SELECTING SAFE (GENESIS CONFIG) ---");
    debugLog("Safe Metadata from Storage", safeMeta);

    try {
      // 🔑 CRITICAL FIX: To get the correct address, we MUST always initialize the SDK
      // with the account's GENESIS configuration (the 1-of-1 setup).

      const genesisCred = WebAuthnSigner.getCredential(safeMeta.genesisOwner);
      if (!genesisCred) {
        throw new Error(`Genesis owner credential ('${safeMeta.genesisOwner}') is missing from your browser's local storage. You must log in as that user at least once.`);
      }
      const genesisAccount = toWebAuthnAccount({ credential: genesisCred });
      debugLog("Reconstructed Genesis Owner Account for SDK config", genesisAccount);

      // We use the genesis config (1-of-1) and the original salt to derive the address.
      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: hexToBigInt(safeMeta.salt) },
        owners: {
          type: 'passkey',
          accounts: [genesisAccount],
          threshold: 1 // ALWAYS use threshold 1 for address derivation
        },
      });

      const address = account.getAddress();
      debugLog("Derived Address with GENESIS config", address);

      if (address !== safeMeta.address) {
        // This should now never happen if the logic is correct.
        addLog(`❌ CRITICAL ADDRESS MISMATCH! This is a bug. Expected ${safeMeta.address}, got ${address}.`);
        setLoading(false);
        return;
      }

      // The `account` object is now correctly configured to point to our Safe address.
      // Our proposal logic will handle the 2-of-2 signature aggregation.
      setActiveSafe(account);
      setActiveSafeAddress(address);
      setActiveSafeThreshold(safeMeta.threshold); // Use the REAL threshold for UI logic
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

  // --- PROPOSALS ---

  const handleProposalCreation = async (description: string, calls: any[]) => {
    if (!activeSafe || !activeSafeAddress || !signer) return;
    setLoading(true);

    try {
      debugLog("--- 1. PROPOSAL CREATION ---");
      debugLog("Input Calls", calls);

      const preparedOp = await activeSafe.prepareUserOperation({
        chain: publicClient.chain,
        calls: calls,
        signers: { type: 'owner', kind: 'passkey', accounts: [signer] }
      });
      debugLog("SDK `prepareUserOperation` Result", preparedOp);

      addLog("Signing with current user...");
      const signedOp = await activeSafe.signUserOperation(preparedOp);
      debugLog("SDK `signUserOperation` Result (Initial Signature)", signedOp);

      const newProposal: PendingProposal = {
        id: `prop-${Date.now()}`,
        safeAddress: activeSafeAddress,
        description,
        calls,
        signatures: [{ signerName: currentUser!, signature: signedOp.signature }],
        nonce: preparedOp.userOperation.nonce.toString(),
        // 👉 Store the *signed* userOp, so it carries the first signature
        preparedUserOp: signedOp
      };

      debugLog("Saving New Proposal Object to State/Storage", newProposal);

      setProposals(prev => [...prev, newProposal]);
      addLog(`📄 Proposal Created! Sigs: 1/${activeSafeThreshold}`);

      if (activeSafeThreshold === 1) {
        await executeProposal(newProposal);
      }
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const proposeStandardTransfer = async () => {
    const amount = parseEther("0.0001");
    const calls = [{ to: TARGET_ADDRESS as Address, value: amount, data: "0x" as Hex }];
    await handleProposalCreation(`Send 0.0001 ETH to Vitalik`, calls);
  };

  const proposeSessionSetup = async () => {
    if (!activeSafeAddress) return;
    const sessionPrivateKey = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(sessionPrivateKey);

    const session: Session = {
      owners: { type: "ecdsa", accounts: [sessionAccount] },
      chain: publicClient.chain,
      policies: [{ type: "sudo" }],
      actions: [{
        target: TARGET_ADDRESS as Address,
        selector: "0x00000000",
        policies: [{ type: "value-limit", limit: parseEther("0.0001") }]
      }]
    };

    const calls: any[] = [];
    const isInstalled = await checkSessionModule(activeSafeAddress);
    if (!isInstalled) {
      addLog("Adding 'Install Smart Session' to proposal...");
      calls.push(installModule({
        type: "validator",
        address: SMART_SESSIONS_ADDRESS,
        initData: "0x"
      }));
    }
    addLog("Adding 'Enable Session Key' to proposal...");
    calls.push(enableSession(session));

    const sessionForStorage = { ...session, owners: { type: "ecdsa", accounts: [] } };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ key: sessionPrivateKey, session: sessionForStorage }));
    setHasStoredSession(true);

    await handleProposalCreation("Install & Enable Smart Session", calls);
  };

  const executeSessionTransfer = async () => {
    if (!activeSafe) return;
    setLoading(true);
    addLog("🤖 Executing via Session Key...");

    try {
      const stored = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!stored) throw new Error("No session found locally");
      const { key, session: config } = JSON.parse(stored);
      const sessionOwner = privateKeyToAccount(key);

      const session: Session = {
        ...config,
        chain: publicClient.chain,
        owners: { type: "ecdsa", accounts: [sessionOwner] },
        actions: config.actions.map((a: any) => ({
          ...a,
          policies: a.policies.map((p: any) => ({
            ...p,
            limit: p.limit ? BigInt(p.limit) : undefined
          }))
        }))
      };

      const result = await activeSafe.sendUserOperation({
        chain: publicClient.chain,
        calls: [{ to: TARGET_ADDRESS as Address, value: parseEther("0.0001"), data: "0x" }],
        signers: { type: 'session', session: session }
      });

      addLog(`Session Tx Sent! Hash: ${result.hash}`);
      await activeSafe.waitForExecution(result);
      addLog("✅ Session Transfer Complete!");

    } catch (e: any) {
      addLog(`Session Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const signProposal = async (proposal: PendingProposal) => {
    if (!activeSafe || !signer || !currentUser) return;
    if (proposal.signatures.find(s => s.signerName === currentUser)) return;

    setLoading(true);
    try {
      debugLog("--- 2. SIGNING PROPOSAL ---");
      debugLog("Proposal being signed (from state)", proposal);

      const opForSigning = {
        ...proposal.preparedUserOp,
        transaction: {
          ...proposal.preparedUserOp.transaction,
          signers: { type: 'owner', kind: 'passkey', accounts: [signer] }
        }
      };
      debugLog("Object passed to `signUserOperation` for current user", opForSigning);

      const signedOp = await activeSafe.signUserOperation(opForSigning);
      debugLog("SDK `signUserOperation` Result (New Signature)", signedOp);

      const updatedProposals = proposals.map(p => {
        if (p.id === proposal.id) {
          const updatedP = {
            ...p,
            signatures: [...p.signatures, { signerName: currentUser!, signature: signedOp.signature }],
            // 👉 Keep the latest aggregated userOp in the proposal
            preparedUserOp: signedOp
          };
          debugLog("Updated proposal object with new signature", updatedP);
          addLog(`Signed! Total: ${updatedP.signatures.length}/${activeSafeThreshold}`);
          return updatedP;
        }
        return p;
      });

      setProposals(updatedProposals);

      const currentProposal = updatedProposals.find(p => p.id === proposal.id);
      if (currentProposal && currentProposal.signatures.length >= activeSafeThreshold) {
        await executeProposal(currentProposal);
      }

    } catch (e: any) {
      console.error(e);
      addLog(`Signing Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const executeProposal = async (proposal: PendingProposal) => {
    if (!activeSafe) return;
    setLoading(true);
    addLog("🚀 Threshold met. Executing transaction...");

    try {
      // 👉 The proposal.preparedUserOp now already has the fully aggregated signature
      const result = await activeSafe.submitUserOperation(proposal.preparedUserOp);

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
              <button className="primary" onClick={proposeStandardTransfer} disabled={loading}>
                Propose Transfer
              </button>

              <button onClick={proposeSessionSetup} disabled={loading}>
                Propose Session Setup
              </button>

              {hasStoredSession && (
                <button onClick={executeSessionTransfer} disabled={loading} style={{ borderColor: 'var(--accent-color)', color: 'var(--accent-color)' }}>
                  ⚡ Execute Session Transfer
                </button>
              )}

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