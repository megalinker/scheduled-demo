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
// --- NEW IMPORT ---
import { generateCredentialId, isRip7212SupportedNetwork, packSignatures, parsePublicKey, parseSignature } from "./signaturePacker";
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

// --- UPDATED TYPE ---
type ProposalSignature = {
  signerName: string;
  // This will now store the full signature object from the passkey prompt
  signatureData: any;
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

// ... (rest of types and constants are the same) ...

// --- CONSTANTS ---
const SAFES_STORAGE_KEY = "demo_app_safes";
const PROPOSALS_STORAGE_KEY = "demo_app_proposals";
const SESSION_STORAGE_KEY = "demo_app_session";
const USER_1 = "User 1";
const USER_2 = "User 2";

const SMART_SESSIONS_ADDRESS = "0x00000000008bdaba73cd9815d79069c247eb4bda";
const SENTINEL_ADDRESS = "0x0000000000000000000000000000000000000001";
const TARGET_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// ... (helpers are the same) ...
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
  // ... (state declarations are the same) ...
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
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<string>("0");

  const [isAddressCopied, setIsAddressCopied] = useState(false);
  const [isDebugCopied, setIsDebugCopied] = useState(false);

  const addLog = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  const addDebugLog = (msg: string) => setDebugLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const debugLog = (label: string, data?: any) => {
    let logMessage = `[DEBUG] ${label}`;
    if (data !== undefined) {
      const prettyData = JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
      logMessage += `:\n${prettyData}`;
    }
    addDebugLog(logMessage);
  };

  const handleCopy = (textToCopy: string, setCopied: (isCopied: boolean) => void) => {
    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleClearDebugLogs = () => {
    setDebugLogs([]);
  };

  // ... (initialization useEffects are the same) ...
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

  // ... (Auth & Safe logic is the same) ...
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
    setDebugLogs([]);
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
      const genesisCred = WebAuthnSigner.getCredential(safeMeta.genesisOwner);
      if (!genesisCred) {
        throw new Error(`Genesis owner credential ('${safeMeta.genesisOwner}') is missing from your browser's local storage. You must log in as that user at least once.`);
      }
      const genesisAccount = toWebAuthnAccount({ credential: genesisCred });
      debugLog("Reconstructed Genesis Owner Account for SDK config", genesisAccount);

      const account = await createRhinestoneAccount({
        ...rhinestoneConfig,
        account: { type: 'safe', nonce: hexToBigInt(safeMeta.salt) },
        owners: {
          type: 'passkey',
          accounts: [genesisAccount],
          threshold: 1
        },
      });

      const address = account.getAddress();
      debugLog("Derived Address with GENESIS config", address);

      if (address !== safeMeta.address) {
        addLog(`❌ CRITICAL ADDRESS MISMATCH! This is a bug. Expected ${safeMeta.address}, got ${address}.`);
        setLoading(false);
        return;
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


  // --- PROPOSALS ---

  const handleProposalCreation = async (description: string, calls: any[]) => {
    if (!activeSafe || !activeSafeAddress || !signer || !currentUser) return;
    setLoading(true);

    try {
      if (activeSafeThreshold === 1) {
        // --- THIS IS THE ORIGINAL, CORRECT CODE FOR 1-of-1 ---
        addLog(`Threshold is 1. Executing directly: "${description}"`);
        debugLog("--- DIRECT EXECUTION (1-of-1) ---");
        debugLog("Input Calls", calls);

        const tx = await activeSafe.sendTransaction({
          chain: publicClient.chain,
          calls: calls,
          sponsored: true,
        });

        addLog(`Transaction Sent! Intent ID: ${tx.id}`);
        await activeSafe.waitForExecution(tx);
        addLog("✅ Transaction Executed Successfully!");

      } else {
        // --- THIS IS THE ORIGINAL, CORRECT CODE for 2-of-2 ---
        addLog(`Threshold is >1. Creating proposal: "${description}"`);
        debugLog("--- 1. PROPOSAL CREATION (N-of-M) ---");
        debugLog("Input Calls", calls);

        const preparedOp = await activeSafe.prepareUserOperation({
          chain: publicClient.chain,
          calls: calls
        });
        debugLog("SDK `prepareUserOperation` Result (for hash)", preparedOp);

        addLog(`Signing proposal as ${currentUser}...`);
        const firstSignature = await signer.sign({ hash: preparedOp.hash });
        debugLog("First Signature Data", firstSignature);

        const newProposal: PendingProposal = {
          id: `prop-${Date.now()}`,
          safeAddress: activeSafeAddress,
          description,
          calls,
          signatures: [{ signerName: currentUser!, signatureData: firstSignature }],
          nonce: preparedOp.userOperation.nonce.toString(),
          preparedUserOp: preparedOp
        };

        debugLog("Saving New Proposal Object to State/Storage", newProposal);

        setProposals(prev => [...prev, newProposal]);
        addLog(`📄 Proposal Created! Signatures: 1/${activeSafeThreshold}`);
      }
    } catch (e: any) {
      console.error("Full error object:", e);
      addLog(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const proposeStandardTransfer = async () => {
    const amount = parseEther("0.00001");
    const calls = [{ to: TARGET_ADDRESS as Address, value: amount, data: "0x" as Hex }];
    await handleProposalCreation(`Send 0.00001 ETH to Vitalik`, calls);
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
        policies: [{ type: "value-limit", limit: parseEther("0.00001") }]
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
        calls: [{ to: TARGET_ADDRESS as Address, value: parseEther("0.00001"), data: "0x" }],
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
    if (!activeSafe || !currentUser || !signer) return;
    if (proposal.signatures.find(s => s.signerName === currentUser)) return;

    setLoading(true);
    try {
      debugLog("--- 2. SIGNING PROPOSAL (ASYNC FLOW) ---");
      debugLog("Proposal being signed", proposal);

      const firstSignatureData = proposal.signatures[0]?.signatureData;
      if (!firstSignatureData) {
        throw new Error("Cannot sign proposal: Missing first signature data.");
      }

      const clientDataJSON = firstSignatureData.webauthn.clientDataJSON;
      debugLog("Reusing clientDataJSON from first signer", clientDataJSON);

      addLog(`Signing proposal as ${currentUser}...`);

      // The `as any` is no longer needed because we updated our WebAuthnSigner type
      const subsequentSignature = await signer.sign({
        hash: proposal.preparedUserOp.hash,
        clientDataJSON: clientDataJSON,
      });

      debugLog("Subsequent Signature Data", subsequentSignature);

      const updatedProposals = proposals.map(p => {
        if (p.id === proposal.id) {
          const updatedP = {
            ...p,
            signatures: [...p.signatures, { signerName: currentUser!, signatureData: subsequentSignature }]
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
    if (!activeSafe || !activeSafeAddress) return;
    setLoading(true);
    addLog("🚀 Threshold met. Executing transaction...");

    try {
      debugLog("--- 3. EXECUTING PROPOSAL (MANUAL PACKING) ---");
      debugLog("Final Proposal State Before Packing", proposal);

      const credIds: Hex[] = [];
      const webAuthns: any[] = [];

      for (const sig of proposal.signatures) {
        const { signerName, signatureData } = sig;
        const cred = WebAuthnSigner.getCredential(signerName);
        if (!cred) throw new Error(`Credential for ${signerName} not found.`);

        const { x, y } = parsePublicKey(cred.publicKey as Hex);
        credIds.push(generateCredentialId(x, y, activeSafeAddress));

        const { r, s } = parseSignature(signatureData.signature);
        webAuthns.push({
          authenticatorData: signatureData.webauthn.authenticatorData,
          clientDataJSON: signatureData.webauthn.clientDataJSON,
          challengeIndex: BigInt(signatureData.webauthn.challengeIndex),
          typeIndex: BigInt(signatureData.webauthn.typeIndex),
          r,
          s,
        });
      }

      const usePrecompile = isRip7212SupportedNetwork(publicClient.chain);
      const packedSignature = packSignatures(credIds, usePrecompile, webAuthns);
      debugLog("Manually Packed Aggregate Signature", packedSignature);

      const finalUserOp = {
        ...proposal.preparedUserOp.userOperation,
        signature: packedSignature,
        verificationGasLimit: (proposal.preparedUserOp.userOperation.verificationGasLimit || 0n) + 150000n,
      };

      const signedOpData = {
        ...proposal.preparedUserOp,
        userOperation: finalUserOp,
        signature: packedSignature,
      };

      debugLog("Final SignedUserOperationData to be submitted", signedOpData);

      const result = await activeSafe.submitUserOperation(signedOpData);

      addLog(`UserOp Sent! Hash: ${result.hash}`);
      await activeSafe.waitForExecution(result);
      addLog("✅ Transaction Executed Successfully!");

      setProposals(prev => prev.filter(p => p.id !== proposal.id));

    } catch (e: any) {
      console.error("Full error object:", e);
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
            <div className="status-item">
              <span>Address:</span>
              <div className="address-line">
                <code className="address-text">{activeSafeAddress}</code>
                <button
                  className="copy-btn"
                  onClick={() => handleCopy(activeSafeAddress!, setIsAddressCopied)}
                >
                  {isAddressCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
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

      <div className="debug-console-container">
        <div className="debug-console-header">
          <h4>Debug Logs</h4>
          <div className="debug-console-actions">
            <button
              className="debug-console-btn"
              onClick={() => handleCopy(debugLogs.join('\n\n'), setIsDebugCopied)}
              disabled={debugLogs.length === 0}
            >
              {isDebugCopied ? 'Copied!' : 'Copy All'}
            </button>
            <button
              className="debug-console-btn"
              onClick={handleClearDebugLogs}
              disabled={debugLogs.length === 0}
            >
              Clear
            </button>
          </div>
        </div>
        <div className="debug-console-content">
          {debugLogs.map((l, i) => (
            <pre key={i} className="debug-log-entry">{l}</pre>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;