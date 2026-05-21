// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IComet} from "../interfaces/external/IComet.sol";

/// @notice Test-only Compound V3 Comet. Holds the base token, tracks per-account balances
///         in a plain mapping, and exposes test helpers for yield/rate simulation.
contract MockComet is IComet {
    using SafeERC20 for IERC20;

    address public immutable override baseToken;

    mapping(address => uint256) private _balances;
    uint64 private _supplyRate; // per-second, scaled 1e18
    uint256 private _utilization; // scaled 1e18

    constructor(address baseToken_, uint64 supplyRate_, uint256 utilization_) {
        baseToken = baseToken_;
        _supplyRate = supplyRate_;
        _utilization = utilization_;
    }

    function supply(address asset, uint256 amount) external override {
        require(asset == baseToken, "asset mismatch");
        IERC20(baseToken).safeTransferFrom(msg.sender, address(this), amount);
        _balances[msg.sender] += amount;
    }

    function withdraw(address asset, uint256 amount) external override {
        require(asset == baseToken, "asset mismatch");

        uint256 userBal = _balances[msg.sender];
        if (amount == type(uint256).max || amount > userBal) {
            amount = userBal;
        }

        // Mock illiquidity ceiling: cap to actual cash on hand.
        uint256 cash = IERC20(baseToken).balanceOf(address(this));
        if (amount > cash) amount = cash;
        if (amount == 0) return;

        _balances[msg.sender] -= amount;
        IERC20(baseToken).safeTransfer(msg.sender, amount);
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function getUtilization() external view override returns (uint256) {
        return _utilization;
    }

    function getSupplyRate(uint256 /*utilization*/) external view override returns (uint64) {
        // Mock ignores the input utilization — tests set rate directly via `setSupplyRate`.
        return _supplyRate;
    }

    // ─── Test helpers ───

    /// @notice Simulate interest accrual: bumps `holder`'s recorded balance directly.
    ///         Caller is expected to also have funded the comet with matching base tokens
    ///         so subsequent withdrawals can settle (mirrors how MockAavePool works).
    function simulateYield(address holder, uint256 amount) external {
        _balances[holder] += amount;
    }

    function setSupplyRate(uint64 newRate) external {
        _supplyRate = newRate;
    }

    function setUtilization(uint256 newUtilization) external {
        _utilization = newUtilization;
    }
}
