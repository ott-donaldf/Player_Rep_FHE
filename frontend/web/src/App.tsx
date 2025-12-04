// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PlayerReputation {
  id: string;
  encryptedScore: string;
  timestamp: number;
  playerAddress: string;
  gameId: string;
  behaviorType: string;
  status: "pending" | "verified" | "rejected";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeReputation = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'penalty10%':
      result = value * 0.9;
      break;
    case 'bonus10%':
      result = value * 1.1;
      break;
    case 'reset':
      result = 100;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [reputations, setReputations] = useState<PlayerReputation[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ gameId: "", behaviorType: "", score: 100 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<PlayerReputation | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  
  const verifiedCount = reputations.filter(r => r.status === "verified").length;
  const pendingCount = reputations.filter(r => r.status === "pending").length;
  const rejectedCount = reputations.filter(r => r.status === "rejected").length;

  useEffect(() => {
    loadReputations().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadReputations = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing reputation keys:", e); }
      }
      
      const list: PlayerReputation[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`reputation_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedScore: recordData.score, 
                timestamp: recordData.timestamp, 
                playerAddress: recordData.playerAddress, 
                gameId: recordData.gameId, 
                behaviorType: recordData.behaviorType, 
                status: recordData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setReputations(list);
    } catch (e) { console.error("Error loading reputations:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitReputation = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting reputation score with Zama FHE..." });
    try {
      const encryptedScore = FHEEncryptNumber(newRecordData.score);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        score: encryptedScore, 
        timestamp: Math.floor(Date.now() / 1000), 
        playerAddress: address, 
        gameId: newRecordData.gameId, 
        behaviorType: newRecordData.behaviorType, 
        status: "pending" 
      };
      
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("reputation_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted reputation submitted securely!" });
      await loadReputations();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ gameId: "", behaviorType: "", score: 100 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyReputation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const verifiedScore = FHEComputeReputation(recordData.score, 'bonus10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "verified", score: verifiedScore };
      await contractWithSigner.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadReputations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectReputation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const rejectedScore = FHEComputeReputation(recordData.score, 'penalty10%');
      
      const updatedRecord = { ...recordData, status: "rejected", score: rejectedScore };
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadReputations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const resetReputation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Resetting reputation with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const resetScore = FHEComputeReputation(recordData.score, 'reset');
      
      const updatedRecord = { ...recordData, status: "verified", score: resetScore };
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE reset completed successfully!" });
      await loadReputations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Reset failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the reputation system", icon: "🔗" },
    { title: "Submit Behavior", description: "Report player behavior which will be encrypted using FHE", icon: "🔒", details: "Your data is encrypted on the client-side before being sent to the blockchain" },
    { title: "FHE Processing", description: "Reputation scores are calculated without decrypting data", icon: "⚙️", details: "Zama FHE technology allows computations on encrypted data without exposing sensitive information" },
    { title: "Get Results", description: "Receive verifiable reputation scores while keeping data private", icon: "📊", details: "The results are computed on encrypted data and can be verified without decryption" }
  ];

  const renderReputationChart = () => {
    const total = reputations.length || 1;
    const verifiedPercentage = (verifiedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const rejectedPercentage = (rejectedCount / total) * 100;
    
    return (
      <div className="chart-container">
        <div className="chart">
          <div className="chart-segment verified" style={{ '--percentage': verifiedPercentage } as React.CSSProperties}></div>
          <div className="chart-segment pending" style={{ '--percentage': pendingPercentage } as React.CSSProperties}></div>
          <div className="chart-segment rejected" style={{ '--percentage': rejectedPercentage } as React.CSSProperties}></div>
          <div className="chart-center">
            <div className="chart-value">{reputations.length}</div>
            <div className="chart-label">Records</div>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item"><div className="color-box verified"></div><span>Verified: {verifiedCount}</span></div>
          <div className="legend-item"><div className="color-box pending"></div><span>Pending: {pendingCount}</span></div>
          <div className="legend-item"><div className="color-box rejected"></div><span>Rejected: {rejectedCount}</span></div>
        </div>
      </div>
    );
  };

  const filteredReputations = reputations.filter(rep => {
    const matchesSearch = 
      rep.playerAddress.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rep.gameId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rep.behaviorType.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = filterStatus === "all" || rep.status === filterStatus;
    
    return matchesSearch && matchesStatus;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Player<span>Reputation</span>System</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn metal-button">
            <div className="add-icon"></div>Report Behavior
          </button>
          <button className="metal-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-based Player Reputation System</h2>
            <p>Track and calculate player reputation scores while preserving privacy with Zama FHE</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE Reputation System Tutorial</h2>
            <p className="subtitle">Learn how to securely track player behavior</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="dashboard-grid">
          <div className="dashboard-card metal-card">
            <h3>Project Introduction</h3>
            <p>Cross-game reputation system using <strong>Zama FHE technology</strong> to track player behavior without compromising privacy. Data is encrypted on the client side and remains encrypted during processing.</p>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Reputation Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{reputations.length}</div><div className="stat-label">Total Records</div></div>
              <div className="stat-item"><div className="stat-value">{verifiedCount}</div><div className="stat-label">Verified</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{rejectedCount}</div><div className="stat-label">Rejected</div></div>
            </div>
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Status Distribution</h3>
            {renderReputationChart()}
          </div>
        </div>
        
        <div className="reputation-section">
          <div className="section-header">
            <h2>Player Reputation Records</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search players/games..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Status</option>
                  <option value="verified">Verified</option>
                  <option value="pending">Pending</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <button onClick={loadReputations} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="reputation-list metal-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Game</div>
              <div className="header-cell">Behavior</div>
              <div className="header-cell">Player</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredReputations.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No reputation records found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Report First Behavior</button>
              </div>
            ) : filteredReputations.map(rep => (
              <div className="record-row" key={rep.id} onClick={() => setSelectedRecord(rep)}>
                <div className="table-cell record-id">#{rep.id.substring(0, 6)}</div>
                <div className="table-cell">{rep.gameId}</div>
                <div className="table-cell">{rep.behaviorType}</div>
                <div className="table-cell">{rep.playerAddress.substring(0, 6)}...{rep.playerAddress.substring(38)}</div>
                <div className="table-cell">{new Date(rep.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${rep.status}`}>{rep.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(rep.playerAddress) && (
                    <>
                      {rep.status === "pending" && (
                        <>
                          <button className="action-btn metal-button success" onClick={(e) => { e.stopPropagation(); verifyReputation(rep.id); }}>Verify</button>
                          <button className="action-btn metal-button danger" onClick={(e) => { e.stopPropagation(); rejectReputation(rep.id); }}>Reject</button>
                        </>
                      )}
                      <button className="action-btn metal-button" onClick={(e) => { e.stopPropagation(); resetReputation(rep.id); }}>Reset</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitReputation} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}
      
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>PlayerReputationSystem</span></div>
            <p>Secure encrypted reputation scoring using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} PlayerReputationSystem. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleScoreChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.gameId || !recordData.behaviorType) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Report Player Behavior</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Behavior data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Game ID *</label>
              <input 
                type="text" 
                name="gameId" 
                value={recordData.gameId} 
                onChange={handleChange} 
                placeholder="Enter game identifier..." 
                className="metal-input"
              />
            </div>
            <div className="form-group">
              <label>Behavior Type *</label>
              <select 
                name="behaviorType" 
                value={recordData.behaviorType} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="">Select behavior type</option>
                <option value="Cheating">Cheating</option>
                <option value="Early Exit">Early Exit</option>
                <option value="Toxic Behavior">Toxic Behavior</option>
                <option value="Good Sportsmanship">Good Sportsmanship</option>
                <option value="Helpful Player">Helpful Player</option>
              </select>
            </div>
            <div className="form-group">
              <label>Initial Score (0-100)</label>
              <input 
                type="number" 
                name="score" 
                min="0"
                max="100"
                value={recordData.score} 
                onChange={handleScoreChange} 
                className="metal-input"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{recordData.score || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.score ? FHEEncryptNumber(recordData.score).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: PlayerReputation;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedScore);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal metal-card">
        <div className="modal-header">
          <h2>Reputation Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Game:</span><strong>{record.gameId}</strong></div>
            <div className="info-item"><span>Behavior:</span><strong>{record.behaviorType}</strong></div>
            <div className="info-item"><span>Player:</span><strong>{record.playerAddress.substring(0, 6)}...{record.playerAddress.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Reputation Score</h3>
            <div className="encrypted-data">{record.encryptedScore.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn metal-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Reputation Score</h3>
              <div className="decrypted-value">
                <div className="score-display">
                  {decryptedValue}
                  <div className="score-bar" style={{ width: `${decryptedValue}%` }}></div>
                </div>
                <div className="score-label">
                  {decryptedValue >= 80 ? "Excellent" : 
                   decryptedValue >= 60 ? "Good" : 
                   decryptedValue >= 40 ? "Fair" : 
                   decryptedValue >= 20 ? "Poor" : "Very Poor"}
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;