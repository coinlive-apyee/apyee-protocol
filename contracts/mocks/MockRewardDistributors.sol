// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ISwapRouter} from "../interfaces/external/ISwapRouter.sol";

/// @notice Test-only reward tokens for the claim+compound mock harness. 18 decimals to
///         match COMP / XVS / MORPHO / SPK / FLUID in production.
contract MockRewardToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mock for Compound V3's CometRewards. On `claim` it transfers `rewardOwed[market]`
///         from itself to the recipient (test harness pre-funds the mock with the reward token).
contract MockCometRewards {
    struct RewardCfg {
        address token;
        uint64 rescaleFactor;
        bool shouldUpscale;
    }
    mapping(address => RewardCfg) public rewardConfigInternal;
    mapping(address => mapping(address => uint256)) public rewardOwed;

    function setRewardConfig(address comet, address token) external {
        rewardConfigInternal[comet] = RewardCfg(token, 1, true);
    }

    function setOwed(address comet, address account, uint256 amount) external {
        rewardOwed[comet][account] = amount;
    }

    function rewardConfig(address comet) external view returns (address, uint64, bool) {
        RewardCfg memory c = rewardConfigInternal[comet];
        return (c.token, c.rescaleFactor, c.shouldUpscale);
    }

    function claim(address comet, address to, bool /*shouldAccrue*/) external {
        uint256 owed = rewardOwed[comet][to];
        if (owed > 0) {
            rewardOwed[comet][to] = 0;
            IERC20(rewardConfigInternal[comet].token).transfer(to, owed);
        }
    }
}

/// @notice Mock for Venus Comptroller. `claimVenus(account, [vTokens])` transfers preset XVS
///         from itself to the account.
contract MockVenusComptroller {
    address public xvs;
    mapping(address => uint256) public owed;

    function setXvs(address t) external {
        xvs = t;
    }

    function setOwed(address account, uint256 amount) external {
        owed[account] = amount;
    }

    function claimVenus(address account, address[] calldata /*vTokens*/) external {
        uint256 a = owed[account];
        if (a > 0) {
            owed[account] = 0;
            IERC20(xvs).transfer(account, a);
        }
    }
}

/// @notice Mock for Aave V3 RewardsController. `claimRewards(assets, max, to, reward)` returns
///         the preset amount and transfers it.
contract MockAaveRewardsController {
    mapping(address => mapping(address => uint256)) public owed;

    function setOwed(address account, address rewardToken, uint256 amount) external {
        owed[account][rewardToken] = amount;
    }

    function claimRewards(
        address[] calldata /*assets*/,
        uint256 /*amount*/,
        address to,
        address reward
    ) external returns (uint256 claimed) {
        claimed = owed[to][reward];
        if (claimed > 0) {
            owed[to][reward] = 0;
            IERC20(reward).transfer(to, claimed);
        }
    }
}

/// @notice Mock for Morpho UniversalRewardsDistributor. Verifies (account, reward, claimable)
///         was pre-authorised in `setClaimable` (acts as the merkle-root check), then sends.
contract MockUniversalRewardsDistributor {
    mapping(address => mapping(address => uint256)) public claimable;

    function setClaimable(address account, address reward, uint256 amount) external {
        claimable[account][reward] = amount;
    }

    function claim(
        address account,
        address reward,
        uint256 claimableAmt,
        bytes32[] calldata /*proof*/
    ) external returns (uint256) {
        uint256 stored = claimable[account][reward];
        require(claimableAmt <= stored, "claimable > stored");
        claimable[account][reward] = 0;
        IERC20(reward).transfer(account, stored);
        return stored;
    }
}

/// @notice Mock for Fluid Merkle distributor. Enforces `msg.sender == recipient_` like the live
///         distributor.
contract MockFluidMerkleDistributor {
    address public reward;
    mapping(address => uint256) public owed;

    error MsgSenderNotRecipient();

    function setReward(address t) external {
        reward = t;
    }

    function setOwed(address account, uint256 amount) external {
        owed[account] = amount;
    }

    function claim(
        address recipient_,
        uint256 cumulativeAmount,
        uint8 /*positionType*/,
        bytes32 /*positionId*/,
        uint256 /*cycle*/,
        bytes32[] calldata /*proof*/,
        bytes calldata /*metadata*/
    ) external {
        if (msg.sender != recipient_) revert MsgSenderNotRecipient();
        uint256 a = owed[recipient_];
        if (a > 0 && a >= cumulativeAmount) {
            owed[recipient_] = 0;
            IERC20(reward).transfer(recipient_, cumulativeAmount);
        }
    }
}

/// @notice Mock UniswapV3 SwapRouter02. Treats `path` linearly: tokenIn at offset 0, tokenOut
///         at the last 20 bytes. Mints USDC at the recipient at a 1:1e-12 ratio (1e18 reward →
///         1e6 USDC) — close enough to "swap happened, path was forwarded correctly" for the
///         claim-flow path assertions. Test harness pre-funds the router with USDC.
contract MockSwapRouter {
    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn / 1e12;
        if (amountOut < params.amountOutMinimum) revert("MockSwapRouter: minOut");
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }

    function exactInput(ISwapRouter.ExactInputParams calldata params)
        external
        returns (uint256 amountOut)
    {
        bytes calldata path = params.path;
        address tokenIn;
        address tokenOut;
        uint256 len = path.length;
        assembly {
            tokenIn  := shr(96, calldataload(path.offset))
            tokenOut := shr(96, calldataload(add(path.offset, sub(len, 20))))
        }
        IERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn / 1e12;
        if (amountOut < params.amountOutMinimum) revert("MockSwapRouter: minOut");
        IERC20(tokenOut).transfer(params.recipient, amountOut);
    }
}
