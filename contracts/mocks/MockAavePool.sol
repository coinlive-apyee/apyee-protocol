// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAaveV3Pool, AaveDataTypes} from "../interfaces/external/IAaveV3Pool.sol";

/// @notice Test-only Aave V3 Pool. Holds the underlying asset, mints/burns aTokens 1:1.
/// @dev Yield is simulated via `simulateYield(asset, amount)`: directly mints aTokens to a recipient
///      so the strategy's `aToken.balanceOf` increases — same effect as Aave's interest accrual.
contract MockAToken is ERC20 {
    uint8 private immutable _dec;
    address public immutable pool;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address pool_)
        ERC20(name_, symbol_)
    {
        _dec = decimals_;
        pool = pool_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @dev Open mint/burn — only the test harness or the paired pool should call.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockAavePool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    /// @notice Per-asset reserve data. Test harness sets aToken + APR via `setReserve`.
    mapping(address => AaveDataTypes.ReserveData) private _reserves;

    function setReserve(address asset, address aTokenAddress, uint128 currentLiquidityRate) external {
        AaveDataTypes.ReserveData storage r = _reserves[asset];
        r.aTokenAddress = aTokenAddress;
        r.currentLiquidityRate = currentLiquidityRate;
    }

    function getReserveData(address asset)
        external
        view
        override
        returns (AaveDataTypes.ReserveData memory)
    {
        return _reserves[asset];
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockAToken(_reserves[asset].aTokenAddress).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to)
        external
        override
        returns (uint256 withdrawn)
    {
        MockAToken aToken = MockAToken(_reserves[asset].aTokenAddress);
        uint256 userBal = aToken.balanceOf(msg.sender);

        // Aave convention: type(uint256).max → withdraw all
        if (amount == type(uint256).max || amount > userBal) {
            withdrawn = userBal;
        } else {
            withdrawn = amount;
        }

        // Cap to pool's actual cash on hand (mock illiquidity).
        uint256 poolCash = IERC20(asset).balanceOf(address(this));
        if (withdrawn > poolCash) withdrawn = poolCash;

        if (withdrawn == 0) return 0;

        aToken.burn(msg.sender, withdrawn);
        IERC20(asset).safeTransfer(to, withdrawn);
    }

    /// @notice Test helper: directly mint extra aTokens to simulate interest accrual without
    ///         requiring underlying USDC to flow in. Pool's USDC cash is also topped up so
    ///         later withdrawals can settle.
    function simulateYield(address asset, address holder, uint256 amount) external {
        MockAToken(_reserves[asset].aTokenAddress).mint(holder, amount);
        // Caller is expected to have separately funded the pool with `amount` of `asset`
        // (via direct token mint) so the pool can pay it out on withdraw.
    }
}
