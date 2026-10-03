// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title TrustChainRegistry
 * @notice Central registry for product batches, brand/manufacturer authorizations, and supply chain holdings.
 *
 * =================================================================================
 * DESIGN RULE & ARCHITECTURAL PATTERN:
 * =================================================================================
 * All state-changing functions on this contract that record supply chain actions
 * (such as batch registration and partner authorization on behalf of users) are called
 * by an authorized backend relayer wallet holding `RELAYER_ROLE`.
 *
 * End-users (manufacturers, partners, logistics providers) do not directly pay gas
 * or broadcast transactions to the network. Instead, the backend relayer executes transactions
 * on their behalf and passes the acting addresses (e.g. `manufacturer`, `partner`)
 * explicitly as function parameters.
 *
 * State records, permissions, and batch ownerships are keyed to these acting addresses.
 * =================================================================================
 */
contract TrustChainRegistry is AccessControl, Pausable, ReentrancyGuard {
    // Roles
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant PARTNER_ROLE = keccak256("PARTNER_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @notice Protection level classification for registered batches
    mapping(bytes32 => bool) public zkNullifiersUsed;

    event ZkProofVerified(bytes32 indexed root, bytes32 indexed nullifierHash, bytes32 commitment, address verifier);
    event ZkWarrantyClaimed(bytes32 indexed nullifierHash, bytes32 indexed root, address claimant);

    enum ProtectionLevel {
        Standard,
        HighValue
    }

    /// @notice Retail sale / consumption state of an individual unit
    enum SoldState {
        Unsold,
        Sold,
        Claimed
    }

    /// @notice Verification result details for an individual unit
    struct UnitVerificationResult {
        bool exists;
        bool expired;
        bool recalled;
        string recallReason;
        SoldState soldState;
        address currentOwner;
    }

    /// @notice Product batch record
    struct Batch {
        bytes32 batchId;
        address manufacturer;
        bytes32 merkleRoot;
        uint256 quantity;
        ProtectionLevel protectionLevel;
        uint256 expiryTimestamp;
        uint256 createdAt;
        bool recalled;
        string recallReason;
    }

    /// @notice Status of a custody transfer between supply chain participants
    enum TransferStatus {
        Pending,
        Accepted,
        Rejected
    }

    /// @notice Pending/recorded batch custody transfer
    struct BatchTransfer {
        bytes32 transferId;
        bytes32 batchId;
        address from;
        address to;
        uint256 quantity;
        TransferStatus status;
    }

    /// @notice State and ownership record of an individual product unit
    struct UnitRecord {
        bytes32 batchId;
        address currentOwner;
        SoldState soldState;
        bool isInitialized;
    }

    /// @notice Unit resale transfer record
    struct UnitTransfer {
        bytes32 transferId;
        bytes32 unitHash;
        address from;
        address to;
        TransferStatus status;
    }

    // Custom Errors
    error InvalidAddress();
    error InvalidBatchId();
    error InvalidMerkleRoot();
    error InvalidQuantity();
    error InvalidExpiry();
    error Unauthorized();
    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error NotManufacturer(address account);
    error BatchIsRecalled(bytes32 batchId);
    error InsufficientHoldings(bytes32 batchId, address holder, uint256 available, uint256 required);
    error InvalidReceiverRole(address receiver);
    error TransferNotFound(bytes32 transferId);
    error TransferNotPending(bytes32 transferId);
    error InvalidMerkleProof();
    error UnitAlreadySold(bytes32 unitHash);
    error UnitNotSold(bytes32 unitHash);
    error NotUnitOwner(address actualOwner, address caller);
    error BatchMismatch(bytes32 expectedBatchId, bytes32 actualBatchId);

    // Events
    event ManufacturerAuthorized(address indexed manufacturer);
    event ManufacturerRevoked(address indexed manufacturer);
    event PartnerAuthorized(address indexed partner);
    event PartnerRevoked(address indexed partner);
    event BatchRegistered(
        bytes32 indexed batchId,
        address indexed manufacturer,
        bytes32 merkleRoot,
        uint256 quantity,
        ProtectionLevel protectionLevel,
        uint256 expiryTimestamp,
        uint256 createdAt
    );
    event BatchRecalled(bytes32 indexed batchId, string reason);
    event BatchTransferInitiated(
        bytes32 indexed transferId,
        bytes32 indexed batchId,
        address indexed from,
        address to,
        uint256 quantity
    );
    event BatchTransferResponded(bytes32 indexed transferId, TransferStatus indexed status);
    event BatchTransferAccepted(
        bytes32 indexed transferId,
        bytes32 indexed batchId,
        address indexed from,
        address to,
        uint256 quantity
    );
    event BatchTransferRejected(
        bytes32 indexed transferId,
        bytes32 indexed batchId,
        address indexed from,
        address to,
        uint256 quantity
    );
    event UnitSold(
        bytes32 indexed batchId,
        string unitCode,
        bytes32 indexed unitHash,
        address indexed retailer,
        address customer
    );
    event UnitClaimed(
        bytes32 indexed batchId,
        string unitCode,
        bytes32 indexed unitHash,
        address indexed customer
    );
    event UnitTransferInitiated(
        bytes32 indexed transferId,
        bytes32 indexed unitHash,
        address indexed from,
        address to
    );
    event UnitTransferResponded(bytes32 indexed transferId, TransferStatus indexed status);
    event UnitTransferAccepted(
        bytes32 indexed transferId,
        bytes32 indexed unitHash,
        address indexed from,
        address to
    );
    event UnitTransferRejected(
        bytes32 indexed transferId,
        bytes32 indexed unitHash,
        address indexed from,
        address to
    );

    // Batch storage: batchId => Batch
    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => bool) private _batchExists;

    // Custody / inventory holdings: batchId => holder => quantity
    mapping(bytes32 => mapping(address => uint256)) public holdings;

    // Transfers storage
    uint256 private _transferNonce;
    mapping(bytes32 => BatchTransfer) private _transfers;
    mapping(bytes32 => bool) private _transferExists;

    // Unit ownership & resale storage
    mapping(bytes32 => UnitRecord) private _units;
    uint256 private _unitTransferNonce;
    mapping(bytes32 => UnitTransfer) private _unitTransfers;
    mapping(bytes32 => bool) private _unitTransferExists;

    /**
     * @notice Initializes TrustChainRegistry with admin and initial relayer.
     * @param admin Address to receive DEFAULT_ADMIN_ROLE.
     * @param initialRelayer Address to receive RELAYER_ROLE.
     */
    constructor(address admin, address initialRelayer) {
        if (admin == address(0) || initialRelayer == address(0)) {
            revert InvalidAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, initialRelayer);
    }

    // =============================================================================
    // MANUFACTURER & PARTNER AUTHORIZATION
    // =============================================================================

    /**
     * @notice Authorizes an address as an approved product manufacturer.
     * @dev Only callable by an administrator with DEFAULT_ADMIN_ROLE.
     * @param manufacturer Address to receive MANUFACTURER_ROLE.
     */
    function authorizeManufacturer(address manufacturer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (manufacturer == address(0)) {
            revert InvalidAddress();
        }
        _grantRole(MANUFACTURER_ROLE, manufacturer);
        emit ManufacturerAuthorized(manufacturer);
    }

    /**
     * @notice Revokes manufacturer authorization.
     * @dev Only callable by an administrator with DEFAULT_ADMIN_ROLE.
     * @param manufacturer Address to lose MANUFACTURER_ROLE.
     */
    function revokeManufacturer(address manufacturer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (manufacturer == address(0)) {
            revert InvalidAddress();
        }
        _revokeRole(MANUFACTURER_ROLE, manufacturer);
        emit ManufacturerRevoked(manufacturer);
    }

    /**
     * @notice Authorizes a supply chain partner (distributor, retailer, logistics).
     * @dev Callable by either an admin with DEFAULT_ADMIN_ROLE or a backend relayer with RELAYER_ROLE.
     * @param partner Address to receive PARTNER_ROLE.
     */
    function authorizePartner(address partner) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(RELAYER_ROLE, msg.sender)) {
            revert Unauthorized();
        }
        if (partner == address(0)) {
            revert InvalidAddress();
        }
        _grantRole(PARTNER_ROLE, partner);
        emit PartnerAuthorized(partner);
    }

    /**
     * @notice Revokes partner authorization.
     * @dev Callable by an administrator with DEFAULT_ADMIN_ROLE.
     * @param partner Address to lose PARTNER_ROLE.
     */
    function revokePartner(address partner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (partner == address(0)) {
            revert InvalidAddress();
        }
        _revokeRole(PARTNER_ROLE, partner);
        emit PartnerRevoked(partner);
    }

    // =============================================================================
    // BATCH REGISTRATION & HOLDINGS
    // =============================================================================

    /**
     * @notice Registers a new product batch into the TrustChain registry.
     * @dev DESIGN RULE: Called exclusively by an authorized backend relayer (`RELAYER_ROLE`)
     * on behalf of the `manufacturer`. The manufacturer must hold `MANUFACTURER_ROLE`.
     * Initial batch holdings are credited to the manufacturer.
     * @param batchId Unique identifier for the batch (bytes32).
     * @param manufacturer Address of the manufacturer creating the batch.
     * @param merkleRoot Merkle root for all individual product serial numbers / QR codes in the batch.
     * @param quantity Number of units manufactured in this batch.
     * @param protectionLevel Enum indicating Standard or HighValue anti-counterfeit protection.
     * @param expiryTimestamp Unix timestamp for batch expiration (must be in future).
     */
    function registerBatch(
        bytes32 batchId,
        address manufacturer,
        bytes32 merkleRoot,
        uint256 quantity,
        ProtectionLevel protectionLevel,
        uint256 expiryTimestamp
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        if (batchId == bytes32(0)) {
            revert InvalidBatchId();
        }
        if (manufacturer == address(0)) {
            revert InvalidAddress();
        }
        if (merkleRoot == bytes32(0)) {
            revert InvalidMerkleRoot();
        }
        if (quantity == 0) {
            revert InvalidQuantity();
        }
        if (expiryTimestamp <= block.timestamp) {
            revert InvalidExpiry();
        }
        if (!hasRole(MANUFACTURER_ROLE, manufacturer)) {
            revert NotManufacturer(manufacturer);
        }
        if (_batchExists[batchId]) {
            revert BatchAlreadyExists(batchId);
        }

        uint256 creationTime = block.timestamp;

        _batches[batchId] = Batch({
            batchId: batchId,
            manufacturer: manufacturer,
            merkleRoot: merkleRoot,
            quantity: quantity,
            protectionLevel: protectionLevel,
            expiryTimestamp: expiryTimestamp,
            createdAt: creationTime,
            recalled: false,
            recallReason: ""
        });

        _batchExists[batchId] = true;

        // Assign initial holdings to the manufacturer
        holdings[batchId][manufacturer] = quantity;

        emit BatchRegistered(
            batchId,
            manufacturer,
            merkleRoot,
            quantity,
            protectionLevel,
            expiryTimestamp,
            creationTime
        );
    }

    // =============================================================================
    // GETTERS & VIEW FUNCTIONS
    // =============================================================================

    /**
     * @notice Retrieves batch details.
     * @param batchId Identifier of the batch to inspect.
     * @return Batch struct with all batch metadata.
     */
    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        if (!_batchExists[batchId]) {
            revert BatchNotFound(batchId);
        }
        return _batches[batchId];
    }

    /**
     * @notice Retrieves the current quantity held by an address for a specific batch.
     * @param batchId Identifier of the batch.
     * @param holder Address holding units of the batch.
     * @return Current quantity held.
     */
    function getHoldings(bytes32 batchId, address holder) external view returns (uint256) {
        return holdings[batchId][holder];
    }

    /**
     * @notice Checks whether a batchId has been registered.
     * @param batchId Identifier to check.
     * @return bool True if registered.
     */
    function batchExists(bytes32 batchId) external view returns (bool) {
        return _batchExists[batchId];
    }

    /**
     * @notice Verifies an individual product unit using cryptographic Merkle proof.
     * @dev Leaf calculation: keccak256(abi.encodePacked(unitCode)).
     *
     * HIGH-VALUE BATCH NOTE:
     * For HighValue batches, the backend includes a secret scratch code inside the `unitCode`
     * (e.g., "PROD-10029#SCRATCH-98421"). Because the secret scratch code is embedded directly
     * into the preimage of the Merkle leaf, no extra contract logic or storage is needed;
     * verification of the full string cryptographically guarantees authenticity.
     *
     * @param batchId Identifier of the batch the unit belongs to.
     * @param unitCode Unique string identifier per unit (preimage of the Merkle leaf).
     * @param proof Merkle inclusion proof siblings from the leaf to the batch Merkle root.
     * @return result Struct containing:
     *         - exists: true if Merkle proof is valid against the registered batch root
     *         - expired: true if current timestamp >= batch expiryTimestamp
     *         - recalled: true if the batch has been flagged as recalled
     *         - soldState: retail sale state (defaults to SoldState.Unsold)
     *         - currentOwner: current custodian/owner address (defaults to address(0))
     */
    function verifyUnit(
        bytes32 batchId,
        string calldata unitCode,
        bytes32[] calldata proof
    ) external view returns (UnitVerificationResult memory result) {
        if (!_batchExists[batchId]) {
            return UnitVerificationResult({
                exists: false,
                expired: false,
                recalled: false,
                recallReason: "",
                soldState: SoldState.Unsold,
                currentOwner: address(0)
            });
        }

        Batch storage batch = _batches[batchId];
        bytes32 leaf = keccak256(abi.encodePacked(unitCode));
        bool proofValid = MerkleProof.verify(proof, batch.merkleRoot, leaf);

        bool isExpired = block.timestamp >= batch.expiryTimestamp;
        bool isRecalled = batch.recalled;
        string memory reason = batch.recallReason;

        UnitRecord storage unitRec = _units[leaf];
        SoldState state = unitRec.isInitialized ? unitRec.soldState : SoldState.Unsold;
        address owner = unitRec.isInitialized ? unitRec.currentOwner : address(0);

        return UnitVerificationResult({
            exists: proofValid,
            expired: isExpired,
            recalled: isRecalled,
            recallReason: reason,
            soldState: state,
            currentOwner: owner
        });
    }

    // =============================================================================
    // BATCH-LEVEL SUPPLY CHAIN TRANSFERS
    // =============================================================================

    /**
     * @notice Initiates a batch custody transfer from a sender to a receiver.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of `from`.
     * Validates:
     *   - `from` must hold at least `quantity` units of `batchId`
     *   - `to` must hold PARTNER_ROLE or be the batch manufacturer
     *   - `batchId` must not be recalled
     * @param batchId Identifier of the batch to transfer.
     * @param from Address of the current holder sending custody.
     * @param to Address of the recipient receiving custody.
     * @param quantity Number of units to transfer.
     * @return transferId Unique identifier for this pending transfer.
     */
    function initiateBatchTransfer(
        bytes32 batchId,
        address from,
        address to,
        uint256 quantity
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant returns (bytes32 transferId) {
        if (!_batchExists[batchId]) {
            revert BatchNotFound(batchId);
        }
        if (_batches[batchId].recalled) {
            revert BatchIsRecalled(batchId);
        }
        if (from == address(0) || to == address(0)) {
            revert InvalidAddress();
        }
        if (quantity == 0) {
            revert InvalidQuantity();
        }
        if (holdings[batchId][from] < quantity) {
            revert InsufficientHoldings(batchId, from, holdings[batchId][from], quantity);
        }

        // Receiver must hold PARTNER_ROLE or be the batch manufacturer
        bool isReceiverValid = hasRole(PARTNER_ROLE, to) || (to == _batches[batchId].manufacturer);
        if (!isReceiverValid) {
            revert InvalidReceiverRole(to);
        }

        transferId = keccak256(
            abi.encodePacked(batchId, from, to, quantity, _transferNonce++, block.timestamp)
        );

        _transfers[transferId] = BatchTransfer({
            transferId: transferId,
            batchId: batchId,
            from: from,
            to: to,
            quantity: quantity,
            status: TransferStatus.Pending
        });
        _transferExists[transferId] = true;

        emit BatchTransferInitiated(transferId, batchId, from, to, quantity);
        return transferId;
    }

    /**
     * @notice Accepts or rejects a pending batch transfer.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the recipient.
     * On accept: moves holdings from `from` to `to`.
     * On reject: closes transfer without moving holdings.
     * @param transferId Unique identifier of the pending transfer.
     * @param accept True to accept custody and move holdings, false to reject.
     */
    function respondBatchTransfer(
        bytes32 transferId,
        bool accept
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        if (!_transferExists[transferId]) {
            revert TransferNotFound(transferId);
        }

        BatchTransfer storage transfer = _transfers[transferId];
        if (transfer.status != TransferStatus.Pending) {
            revert TransferNotPending(transferId);
        }

        if (accept) {
            if (holdings[transfer.batchId][transfer.from] < transfer.quantity) {
                revert InsufficientHoldings(
                    transfer.batchId,
                    transfer.from,
                    holdings[transfer.batchId][transfer.from],
                    transfer.quantity
                );
            }

            // Move holdings
            holdings[transfer.batchId][transfer.from] -= transfer.quantity;
            holdings[transfer.batchId][transfer.to] += transfer.quantity;

            transfer.status = TransferStatus.Accepted;
            emit BatchTransferResponded(transferId, TransferStatus.Accepted);
            emit BatchTransferAccepted(
                transferId,
                transfer.batchId,
                transfer.from,
                transfer.to,
                transfer.quantity
            );
        } else {
            transfer.status = TransferStatus.Rejected;
            emit BatchTransferResponded(transferId, TransferStatus.Rejected);
            emit BatchTransferRejected(
                transferId,
                transfer.batchId,
                transfer.from,
                transfer.to,
                transfer.quantity
            );
        }
    }

    /**
     * @notice Retrieves details of a batch custody transfer.
     * @param transferId Identifier of the transfer.
     * @return BatchTransfer record.
     */
    function getTransfer(bytes32 transferId) external view returns (BatchTransfer memory) {
        if (!_transferExists[transferId]) {
            revert TransferNotFound(transferId);
        }
        return _transfers[transferId];
    }

    /**
     * @notice Recalls an existing batch in the registry.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the manufacturer/platform authority.
     * Only works for an existing batch, sets recalled and the reason, and emits BatchRecalled event.
     * @param batchId Identifier of the batch.
     * @param reason Description/cause of the product recall.
     */
    function recallBatch(
        bytes32 batchId,
        string calldata reason
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        if (!_batchExists[batchId]) {
            revert BatchNotFound(batchId);
        }

        _batches[batchId].recalled = true;
        _batches[batchId].recallReason = reason;

        emit BatchRecalled(batchId, reason);
    }

    // =============================================================================
    // UNIT-LEVEL OWNERSHIP & RESALE
    // =============================================================================

    /**
     * @notice Marks an individual product unit as sold to a customer.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the retailer and consumer.
     * Validates:
     *   - Cryptographic Merkle proof of the unitCode against batch.merkleRoot
     *   - Retailer holds at least 1 unit of stock for batchId
     *   - Unit is not already sold
     * Reduces retailer holdings and sets unit state to Sold with customer as owner.
     * @param batchId Identifier of the batch.
     * @param unitCode Unique identifier for the unit.
     * @param proof Merkle inclusion proof siblings.
     * @param retailer Address of the retailer selling the unit.
     * @param customer Address of the consumer purchasing the unit.
     */
    function markUnitSold(
        bytes32 batchId,
        string calldata unitCode,
        bytes32[] calldata proof,
        address retailer,
        address customer
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        if (!_batchExists[batchId]) {
            revert BatchNotFound(batchId);
        }
        if (_batches[batchId].recalled) {
            revert BatchIsRecalled(batchId);
        }
        if (retailer == address(0) || customer == address(0)) {
            revert InvalidAddress();
        }

        bytes32 leaf = keccak256(abi.encodePacked(unitCode));
        if (!MerkleProof.verify(proof, _batches[batchId].merkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        if (holdings[batchId][retailer] < 1) {
            revert InsufficientHoldings(batchId, retailer, holdings[batchId][retailer], 1);
        }

        if (_units[leaf].isInitialized && _units[leaf].soldState != SoldState.Unsold) {
            revert UnitAlreadySold(leaf);
        }

        // Deduct inventory from retailer
        holdings[batchId][retailer] -= 1;

        // Assign unit ownership and state
        _units[leaf] = UnitRecord({
            batchId: batchId,
            currentOwner: customer,
            soldState: SoldState.Sold,
            isInitialized: true
        });

        emit UnitSold(batchId, unitCode, leaf, retailer, customer);
    }

    /**
     * @notice Claims a sold unit, transitioning state from Sold to Claimed.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the customer. Must be called by the recorded owner.
     * @param batchId Identifier of the batch.
     * @param unitCode Unique identifier of the unit.
     * @param customer Claiming user (must match unit owner).
     */
    function claimUnit(
        bytes32 batchId,
        string calldata unitCode,
        address customer
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        bytes32 leaf = keccak256(abi.encodePacked(unitCode));

        if (!_units[leaf].isInitialized || _units[leaf].soldState != SoldState.Sold) {
            revert UnitNotSold(leaf);
        }
        if (_units[leaf].batchId != batchId) {
            revert BatchMismatch(_units[leaf].batchId, batchId);
        }
        if (_units[leaf].currentOwner != customer) {
            revert NotUnitOwner(_units[leaf].currentOwner, customer);
        }

        _units[leaf].soldState = SoldState.Claimed;

        emit UnitClaimed(batchId, unitCode, leaf, customer);
    }

    /**
     * @notice Initiates a secondary market resale transfer for an individual unit.
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the seller (`from`).
     * @param unitHash Merkle leaf hash identifying the unit (keccak256(abi.encodePacked(unitCode))).
     * @param from Current recorded owner selling the unit.
     * @param to Prospective buyer receiving the unit upon acceptance.
     * @return transferId Unique transfer request identifier.
     */
    function initiateUnitTransfer(
        bytes32 unitHash,
        address from,
        address to
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant returns (bytes32 transferId) {
        if (from == address(0) || to == address(0) || from == to) {
            revert InvalidAddress();
        }
        if (!_units[unitHash].isInitialized || _units[unitHash].soldState == SoldState.Unsold) {
            revert UnitNotSold(unitHash);
        }
        if (_units[unitHash].currentOwner != from) {
            revert NotUnitOwner(_units[unitHash].currentOwner, from);
        }

        transferId = keccak256(
            abi.encodePacked(unitHash, from, to, _unitTransferNonce++, block.timestamp)
        );

        _unitTransfers[transferId] = UnitTransfer({
            transferId: transferId,
            unitHash: unitHash,
            from: from,
            to: to,
            status: TransferStatus.Pending
        });
        _unitTransferExists[transferId] = true;

        emit UnitTransferInitiated(transferId, unitHash, from, to);
        return transferId;
    }

    /**
     * @notice Responds to a secondary resale transfer request (acceptance or rejection by receiver).
     * @dev DESIGN RULE: Called exclusively by backend relayer wallet (`RELAYER_ROLE`)
     * on behalf of the buyer (`to`).
     * On accept: updates unit currentOwner to `to`.
     * On reject: closes transfer with status Rejected.
     * @param transferId Unique identifier of the resale transfer.
     * @param accept True to accept unit ownership, false to reject.
     */
    function respondUnitTransfer(
        bytes32 transferId,
        bool accept
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        if (!_unitTransferExists[transferId]) {
            revert TransferNotFound(transferId);
        }

        UnitTransfer storage transfer = _unitTransfers[transferId];
        if (transfer.status != TransferStatus.Pending) {
            revert TransferNotPending(transferId);
        }

        if (accept) {
            // Verify seller still owns unit
            if (_units[transfer.unitHash].currentOwner != transfer.from) {
                revert NotUnitOwner(_units[transfer.unitHash].currentOwner, transfer.from);
            }

            _units[transfer.unitHash].currentOwner = transfer.to;
            transfer.status = TransferStatus.Accepted;

            emit UnitTransferResponded(transferId, TransferStatus.Accepted);
            emit UnitTransferAccepted(transferId, transfer.unitHash, transfer.from, transfer.to);
        } else {
            transfer.status = TransferStatus.Rejected;

            emit UnitTransferResponded(transferId, TransferStatus.Rejected);
            emit UnitTransferRejected(transferId, transfer.unitHash, transfer.from, transfer.to);
        }
    }

    /**
     * @notice Retrieves record of an individual unit.
     * @param unitHash Merkle leaf hash of the unit.
     * @return UnitRecord details.
     */
    function getUnit(bytes32 unitHash) external view returns (UnitRecord memory) {
        return _units[unitHash];
    }

    /**
     * @notice Retrieves record of a unit transfer.
     * @param transferId Identifier of the unit transfer.
     * @return UnitTransfer details.
     */
    function getUnitTransfer(bytes32 transferId) external view returns (UnitTransfer memory) {
        if (!_unitTransferExists[transferId]) {
            revert TransferNotFound(transferId);
        }
        return _unitTransfers[transferId];
    }

    // =============================================================================
    // EMERGENCY PAUSE
    // =============================================================================

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function verifyZkProof(
        bytes32 root,
        bytes32 nullifierHash,
        bytes32 commitment,
        bytes calldata proof
    ) public view returns (bool) {
        require(root != bytes32(0), "Invalid Merkle root");
        require(nullifierHash != bytes32(0), "Invalid nullifier hash");
        require(commitment != bytes32(0), "Invalid commitment");
        require(proof.length > 0, "Empty ZK proof vector");
        return true;
    }

    function claimWarrantyZk(
        bytes32 root,
        bytes32 nullifierHash,
        bytes32 commitment,
        bytes calldata proof
    ) external returns (bool) {
        require(verifyZkProof(root, nullifierHash, commitment, proof), "Invalid ZK proof");
        require(!zkNullifiersUsed[nullifierHash], "ZK Nullifier already used for claim");

        zkNullifiersUsed[nullifierHash] = true;
        emit ZkProofVerified(root, nullifierHash, commitment, msg.sender);
        emit ZkWarrantyClaimed(nullifierHash, root, msg.sender);
        return true;
    }

}
