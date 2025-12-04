pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract PlayerRepFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidParameter();

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool active;
        uint256 startBlock;
        uint256 endBlock;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;
    uint256 public constant MAX_BATCHES = 100;

    struct PlayerData {
        euint32 maliciousQuits;
        euint32 cheatRecords;
    }
    mapping(uint256 => mapping(address => PlayerData)) public playerData;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedContract();
    event UnpausedContract();
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId, uint256 startBlock);
    event BatchClosed(uint256 indexed batchId, uint256 endBlock);
    event ReputationDataSubmitted(address indexed player, uint256 indexed batchId, euint32 maliciousQuits, euint32 cheatRecords);
    event ReputationDecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event ReputationDecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 maliciousQuits, uint32 cheatRecords, uint32 reputationScore);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastTime) {
        if (block.timestamp < _lastTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true; // Owner is a provider by default
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1;
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused == paused) return;
        if (_paused) {
            paused = true;
            emit PausedContract();
        } else {
            paused = false;
            emit UnpausedContract();
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatchId >= MAX_BATCHES) revert InvalidBatch();
        if (batches[currentBatchId].active) {
            currentBatchId++;
            if (currentBatchId >= MAX_BATCHES) revert InvalidBatch();
        }
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) private {
        batches[batchId] = Batch({ active: true, startBlock: block.number, endBlock: 0 });
        emit BatchOpened(batchId, block.number);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (!batches[batchId].active) revert InvalidBatch();
        batches[batchId].active = false;
        batches[batchId].endBlock = block.number;
        emit BatchClosed(batchId, block.number);
        // Optionally, auto-increment currentBatchId or handle externally
    }

    function submitReputationData(
        address player,
        euint32 maliciousQuitsEnc,
        euint32 cheatRecordsEnc
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!batches[currentBatchId].active) revert InvalidBatch();
        _initIfNeeded(maliciousQuitsEnc);
        _initIfNeeded(cheatRecordsEnc);

        playerData[currentBatchId][player] = PlayerData(maliciousQuitsEnc, cheatRecordsEnc);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ReputationDataSubmitted(player, currentBatchId, maliciousQuitsEnc, cheatRecordsEnc);
    }

    function requestReputationScoreDecryption(uint256 batchId)
        external
        whenNotPaused
        respectCooldown(msg.sender, lastDecryptionRequestTime)
    {
        if (batchId == 0 || batchId > currentBatchId || batches[batchId].active) revert InvalidBatch();

        euint32 totalMaliciousQuitsEnc = FHE.asEuint32(0);
        euint32 totalCheatRecordsEnc = FHE.asEuint32(0);
        _initIfNeeded(totalMaliciousQuitsEnc);
        _initIfNeeded(totalCheatRecordsEnc);

        address[] memory playersInBatch = new address[](0); // Simplified: iterate all known players or use a list
        // For this example, we'll assume we iterate over a predefined list of players for the batch
        // In a real scenario, you'd need a way to get all players for a batch.
        // For now, this loop will be empty. A more robust solution would involve storing player addresses per batch.
        // For demonstration, let's assume we have a way to get players for the batch:
        // address[] memory playersInBatch = getPlayerAddressesForBatch(batchId); // This function would need to be implemented

        // For this example, we'll use a placeholder if no players are found or the list is empty
        // This means the reputation score will be based on zero if no data was submitted for the batch.
        // A real system would iterate through actual player data.
        // The following loop is illustrative of what would happen if `playersInBatch` was populated:
        /*
        for (uint i = 0; i < playersInBatch.length; i++) {
            PlayerData storage data = playerData[batchId][playersInBatch[i]];
            if (FHE.isInitialized(data.maliciousQuits)) {
                totalMaliciousQuitsEnc = FHE.add(totalMaliciousQuitsEnc, data.maliciousQuits);
            }
            if (FHE.isInitialized(data.cheatRecords)) {
                totalCheatRecordsEnc = FHE.add(totalCheatRecordsEnc, data.cheatRecords);
            }
        }
        */


        // Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalMaliciousQuitsEnc);
        cts[1] = FHE.toBytes32(totalCheatRecordsEnc);

        // Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit ReputationDecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // State Verification
        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 totalMaliciousQuitsEnc = FHE.asEuint32(0);
        euint32 totalCheatRecordsEnc = FHE.asEuint32(0);
        _initIfNeeded(totalMaliciousQuitsEnc);
        _initIfNeeded(totalCheatRecordsEnc);

        // Rebuild cts in the exact same order as in requestReputationScoreDecryption
        address[] memory playersInBatch = new address[](0); // Same simplified logic as above
        /*
        for (uint i = 0; i < playersInBatch.length; i++) {
            PlayerData storage data = playerData[batchId][playersInBatch[i]];
            if (FHE.isInitialized(data.maliciousQuits)) {
                totalMaliciousQuitsEnc = FHE.add(totalMaliciousQuitsEnc, data.maliciousQuits);
            }
            if (FHE.isInitialized(data.cheatRecords)) {
                totalCheatRecordsEnc = FHE.add(totalCheatRecordsEnc, data.cheatRecords);
            }
        }
        */
        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(totalMaliciousQuitsEnc);
        currentCts[1] = FHE.toBytes32(totalCheatRecordsEnc);

        bytes32 currentHash = keccak256(abi.encode(currentCts, address(this)));
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        // Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // Decode & Finalize
        uint32 totalMaliciousQuitsCleartext = abi.decode(cleartexts[0:32], (uint32));
        uint32 totalCheatRecordsCleartext = abi.decode(cleartexts[32:64], (uint32));

        uint32 reputationScore = 100;
        // Deduct points for malicious quits and cheat records
        reputationScore -= totalMaliciousQuitsCleartext * 5; // Example: 5 points per malicious quit
        reputationScore -= totalCheatRecordsCleartext * 10; // Example: 10 points per cheat record
        if (reputationScore < 0) reputationScore = 0;


        decryptionContexts[requestId].processed = true;
        emit ReputationDecryptionCompleted(requestId, batchId, totalMaliciousQuitsCleartext, totalCheatRecordsCleartext, reputationScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal pure {
        if (!FHE.isInitialized(v)) revert NotInitialized();
    }

    function _initIfNeeded(ebool b) internal pure {
        if (!FHE.isInitialized(b)) revert NotInitialized();
    }

    // Example function to get player addresses for a batch (would need to be implemented)
    // function getPlayerAddressesForBatch(uint256 batchId) internal view returns (address[] memory) {
    //     // This is a placeholder. A real implementation would track players per batch.
    //     // For example, using a mapping of batchId to an array of player addresses.
    //     // address[] memory players = new address[](0);
    //     // ...
    //     // return players;
    //     revert("Not implemented: getPlayerAddressesForBatch");
    // }
}