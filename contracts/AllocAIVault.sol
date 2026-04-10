// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AllocAIVault
 * @dev Autonomous Yield Vault for Kite AI Ecosystem.
 * Features: EIP-3009 Gasless Deposits, Direct Staking Pipeline, Cross-Chain Hub.
 */

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract AllocAIVault {
    // --- Access Control ---
    address public owner;
    address public authorizedAgent;

    // --- Asset Configuration ---
    address public immutable USDC_TOKEN;
    address public bridgeAggregator;

    // --- Strategy Context ---
    struct Strategy {
        string protocol;
        string chain;
        uint256 currentApr;
        uint256 lastUpdate;
    }

    Strategy public activeStrategy;
    address public activeStakingContract; 
    address public yieldBearingToken; 
    uint256 public globalStakedBalance; // Assets bridged to external chains
    
    bytes4 public depositSelector = bytes4(keccak256("deposit(uint256)"));
    bytes4 public withdrawSelector = bytes4(keccak256("withdraw(uint256)"));

    // --- Ecosystem ---
    address public constant SERVICE_REGISTRY = 0xc67a4AbcD8853221F241a041ACb1117b38DA587F;
    uint256 public kiteServiceId;
    bool public isRegisteredService;

    // --- User Accounting ---
    mapping(address => uint256) public userShares;
    uint256 public totalShares;

    // --- Events ---
    event Deposit(address indexed user, uint256 assets, uint256 shares, string sourceChain);
    event Withdraw(address indexed user, uint256 assets, uint256 shares);
    event ReallocationInitiated(string toProtocol, string toChain, uint256 newApr, bytes32 indexed proofHash);
    event AgentDecisionLogged(string decision, bytes32 indexed decisionHash);

    modifier onlyAuthorized() {
        require(msg.sender == owner || msg.sender == authorizedAgent, "Not authorized");
        _;
    }

    constructor(address _agent, address _usdc) {
        owner = msg.sender;
        authorizedAgent = _agent;
        USDC_TOKEN = _usdc;
        activeStrategy = Strategy("Lucid Native", "Kite AI", 585, block.timestamp);
    }

    /**
     * @dev Total valuation: Liquid USDC + Locally Staked + Cross-Chain Staked.
     */
    function totalAssets() public view returns (uint256) {
        uint256 liquid = IERC20(USDC_TOKEN).balanceOf(address(this));
        uint256 localStaked = 0;
        if (yieldBearingToken != address(0)) {
            localStaked = IERC20(yieldBearingToken).balanceOf(address(this));
        }
        return liquid + localStaked + globalStakedBalance;
    }

    /**
     * @dev User Deposit: Pulls USDC and automatically routes to the active strategy (local or bridge).
     */
    function deposit(uint256 _assets, string memory _sourceChain) external {
        bool success = IERC20(USDC_TOKEN).transferFrom(msg.sender, address(this), _assets);
        require(success, "USDC transfer failed");
        _processFlow(_assets);
        emit Deposit(msg.sender, _assets, 0, _sourceChain);
    }

    /**
     * @dev Gasless Deposit: EIP-3009 integration for Kite AI.
     */
    function depositWithSignature(
        uint256 _assets,
        string memory _sourceChain,
        uint256 _validAfter,
        uint256 _validBefore,
        bytes32 _nonce,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) external {
        (bool success, ) = USDC_TOKEN.call(
            abi.encodeWithSignature(
                "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                msg.sender,
                address(this),
                _assets,
                _validAfter,
                _validBefore,
                _nonce,
                _v,
                _r,
                _s
            )
        );
        require(success, "EIP-3009 transfer failed");
        _processFlow(_assets);
        emit Deposit(msg.sender, _assets, 0, _sourceChain);
    }

    function _processFlow(uint256 _assets) internal {
        uint256 _totalAssets = totalAssets();
        uint256 _shares = (totalShares == 0) ? _assets : (_assets * totalShares) / (_totalAssets - _assets);
        
        bytes32 kiteHash = keccak256(abi.encodePacked("Kite AI"));
        bytes32 currentChainHash = keccak256(abi.encodePacked(activeStrategy.chain));

        if (currentChainHash == kiteHash) {
            // Local Staking
            if (activeStakingContract != address(0)) {
                IERC20(USDC_TOKEN).approve(activeStakingContract, _assets);
                (bool success, ) = activeStakingContract.call(abi.encodeWithSelector(depositSelector, _assets));
                if (!success) emit AgentDecisionLogged("Auto-stake fail. Funds held liquid.", bytes32(0));
            }
        } else if (bridgeAggregator != address(0)) {
            // Invisible Bridging
            IERC20(USDC_TOKEN).approve(bridgeAggregator, _assets);
            (bool success, ) = bridgeAggregator.call(
                abi.encodeWithSignature("send(address,uint256,string)", USDC_TOKEN, _assets, activeStrategy.chain)
            );
            if (success) {
                globalStakedBalance += _assets;
            } else {
                emit AgentDecisionLogged("Auto-bridge fail. Funds held liquid.", bytes32(0));
            }
        }

        userShares[msg.sender] += _shares;
        totalShares += _shares;
    }

    struct WithdrawalRequest {
        uint256 assets;
        uint256 shares;
        bool isNative; // True if withdrawing on Kite, False if requesting bridge
    }

    mapping(address => WithdrawalRequest) public pendingWithdrawals;

    event CrossChainWithdrawRequested(address indexed user, uint256 assets, string fromChain);
    event CrossChainWithdrawSettled(address indexed user, uint256 assets);

    /**
     * @dev User withdraws assets. Handles local vs cross-chain logic automatically.
     */
    function withdraw(uint256 _assets) external {
        _execWithdraw(_assets, msg.sender);
    }

    /**
     * @dev Gasless Withdrawal: Signature-based authentication for KITE-free operations.
     */
    function withdrawWithSignature(
        uint256 _assets,
        uint256 _deadline,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) external {
        require(block.timestamp <= _deadline, "Signature expired");
        
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Withdrawal(address user,uint256 assets,uint256 deadline)"),
            msg.sender,
            _assets,
            _deadline
        ));
        
        // Note: For production, implement a proper EIP-712 Domain Separator
        bytes32 hash = keccak256(abi.encodePacked("\x19\x01", bytes32(0), structHash));
        address signer = ecrecover(hash, _v, _r, _s);
        require(signer == msg.sender, "Invalid signature");

        _execWithdraw(_assets, msg.sender);
    }

    function _execWithdraw(uint256 _assets, address _user) internal {
        uint256 _totalAssets = totalAssets();
        uint256 _shares = (_assets * totalShares) / _totalAssets;
        require(userShares[_user] >= _shares, "Insufficient balance");

        bytes32 kiteHash = keccak256(abi.encodePacked("Kite AI"));
        bytes32 currentChainHash = keccak256(abi.encodePacked(activeStrategy.chain));

        if (currentChainHash == kiteHash) {
            uint256 liquid = IERC20(USDC_TOKEN).balanceOf(address(this));
            if (liquid < _assets && activeStakingContract != address(0)) {
                uint256 needed = _assets - liquid;
                (bool success, ) = activeStakingContract.call(abi.encodeWithSelector(withdrawSelector, needed));
                require(success, "Local unstake failed");
            }
            userShares[_user] -= _shares;
            totalShares -= _shares;
            IERC20(USDC_TOKEN).transfer(_user, _assets);
            emit Withdraw(_user, _assets, _shares);
        } else {
            userShares[_user] -= _shares;
            pendingWithdrawals[_user] = WithdrawalRequest(_assets, _shares, false);
            if (bridgeAggregator != address(0)) {
                (bool success, ) = bridgeAggregator.call(
                    abi.encodeWithSignature("requestUnstake(address,uint256,address)", USDC_TOKEN, _assets, _user)
                );
                require(success, "Cross-chain pull request failed");
            }
            emit CrossChainWithdrawRequested(_user, _assets, activeStrategy.chain);
        }
    }

    /**
     * @dev Completion hook: Called by bridge/agent when funds arrive back from Ethereum.
     */
    function settleCrossChainWithdrawal(address _user) external onlyAuthorized {
        WithdrawalRequest memory request = pendingWithdrawals[_user];
        require(request.assets > 0, "No pending withdrawal");

        uint256 liquid = IERC20(USDC_TOKEN).balanceOf(address(this));
        require(liquid >= request.assets, "Funds not yet arrived from bridge");

        totalShares -= request.shares;
        delete pendingWithdrawals[_user];

        IERC20(USDC_TOKEN).transfer(_user, request.assets);
        emit CrossChainWithdrawSettled(_user, request.assets);
    }

    /**
     * @dev Agent Reallocation: Transfers funds to new protocols or chains.
     */
    function reallocate(
        string memory _protocol, string memory _chain, uint256 _newApr, bytes32 _proofHash,
        address _targetContract, bytes calldata _executionData,
        address _newStakingContract, address _newYieldToken
    ) external onlyAuthorized {
        activeStrategy = Strategy(_protocol, _chain, _newApr, block.timestamp);
        activeStakingContract = _newStakingContract;
        yieldBearingToken = _newYieldToken;

        uint256 currentBalance = IERC20(USDC_TOKEN).balanceOf(address(this));
        bytes32 kiteHash = keccak256(abi.encodePacked("Kite AI"));
        bytes32 targetChainHash = keccak256(abi.encodePacked(_chain));

        if (targetChainHash != kiteHash && bridgeAggregator != address(0)) {
            uint256 toBridge = totalAssets(); // Bridge everything
            // Local unstake first would be required if yieldToken exists
            IERC20(USDC_TOKEN).approve(bridgeAggregator, toBridge);
            (bool success, ) = bridgeAggregator.call(
                abi.encodeWithSignature("send(address,uint256,string)", USDC_TOKEN, toBridge, _chain)
            );
            require(success, "Bridge fail");
            globalStakedBalance += toBridge;
        } else if (_targetContract != address(0)) {
            IERC20(USDC_TOKEN).approve(_targetContract, currentBalance);
            (bool success, ) = _targetContract.call(_executionData);
            require(success, "Execution fail");
        }
        emit ReallocationInitiated(_protocol, _chain, _newApr, _proofHash);
    }

    // --- Admin ---
    function updateBridge(address _bridge) external onlyAuthorized { bridgeAggregator = _bridge; }
    
    function registerAsKiteService(string memory _pricing, uint256 _price, string memory _meta) external onlyAuthorized {
        (bool success, bytes memory data) = SERVICE_REGISTRY.call(
            abi.encodeWithSignature("registerService(string,string,uint256,string)", "AllocAI Vault", _pricing, _price, _meta)
        );
        require(success, "Registry fail");
        kiteServiceId = abi.decode(data, (uint256));
        isRegisteredService = true;
    }

    function rescueToken(address _token, uint256 _amount) external {
        require(msg.sender == owner, "Only owner");
        if (_token == address(0)) payable(owner).transfer(_amount);
        else IERC20(_token).transfer(owner, _amount);
    }

    receive() external payable {}
}
