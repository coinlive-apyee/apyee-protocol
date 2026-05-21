// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only MetaMorpho vault. Plain OZ ERC-4626 with an open-mint underlying topup
///         helper so tests can simulate yield by inflating share price.
contract MockMetaMorphoVault is ERC4626 {
    using SafeERC20 for IERC20;

    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Mock MetaMorpho Vault", "mMM") {}

    /// @notice Simulate yield by transferring extra underlying into the vault. ERC-4626 share
    ///         price rises proportionally because totalAssets() grows but totalSupply() doesn't.
    /// @dev Caller must hold the underlying + approve this contract for `amount`.
    function simulateYield(uint256 amount) external {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }
}
