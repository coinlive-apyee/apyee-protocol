// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseStrategy} from "../strategies/BaseStrategy.sol";

/// @notice Test-only strategy. Holds funds in itself; no external protocol.
/// @dev Used to verify Vault ↔ BaseStrategy plumbing without depending on Aave/Compound forks.
contract MockStrategy is BaseStrategy {
    uint256 private _principal;
    uint256 private _harvestable;
    uint256 private _apy;
    /// @notice When true, `_withdraw` reverts — simulates V1 BSC Venus dust scenario
    ///         where the underlying protocol rounds to zero and reverts.
    bool public revertOnWithdraw;

    constructor(address vault_, address asset_)
        // dexRouter = address(0): mock opts out of reward-compound; helper would revert.
        BaseStrategy(vault_, asset_, address(0), keccak256(abi.encodePacked("mock")))
    {
        _apy = 500; // 5% default
    }

    // ─── BaseStrategy hooks ───

    function _deposit(uint256 amount) internal override {
        _principal += amount;
    }

    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        if (revertOnWithdraw) revert("MockStrategy: forced revert");
        withdrawn = amount > _principal ? _principal : amount;
        _principal -= withdrawn;
    }

    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        withdrawn = _principal;
        _principal = 0;
    }

    function balanceOf() external view override returns (uint256) {
        return _principal;
    }

    function currentAPY() external view override returns (uint256) {
        return _apy;
    }

    function harvestable() external view override returns (uint256) {
        return _harvestable;
    }

    // ─── Test helpers ───

    /// @notice Simulate yield accrual by topping up principal directly.
    function simulateYield(uint256 amount) external {
        _principal += amount;
    }

    /// @notice Simulate harvest available without changing principal.
    function setHarvestable(uint256 amount) external {
        _harvestable = amount;
    }

    /// @notice Adjust mock APY for testing.
    function setAPY(uint256 newApy) external {
        _apy = newApy;
    }

    /// @notice Toggle forced revert on `_withdraw` — simulates dust / protocol unavailability.
    function setRevertOnWithdraw(bool v) external {
        revertOnWithdraw = v;
    }
}
