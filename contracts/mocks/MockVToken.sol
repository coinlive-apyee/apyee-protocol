// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IVToken} from "../interfaces/external/IVToken.sol";

/// @notice Test-only Venus / Compound V2 vToken. Holds underlying, tracks vToken balances
///         per account, and exposes simulation helpers for exchange-rate / APR.
contract MockVToken is IVToken {
    using SafeERC20 for IERC20;

    address public immutable override underlying;

    mapping(address => uint256) private _balances;
    uint256 private _exchangeRate; // scaled 1e18 (1e18 = 1:1 vToken ↔ underlying)
    uint256 private _supplyRatePerBlock; // scaled 1e18

    /// @param underlying_       Underlying ERC20 (USDC).
    /// @param exchangeRate_     Initial exchange rate (1e18 = 1:1 mapping).
    /// @param supplyRatePerBlock_ Initial per-block APR scaled 1e18.
    constructor(address underlying_, uint256 exchangeRate_, uint256 supplyRatePerBlock_) {
        underlying = underlying_;
        _exchangeRate = exchangeRate_;
        _supplyRatePerBlock = supplyRatePerBlock_;
    }

    function mint(uint256 mintAmount) external override returns (uint256) {
        if (mintShouldFail) return mintFailCode;
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), mintAmount);
        // vTokens minted = underlying / exchangeRate
        uint256 vTokens = (mintAmount * 1e18) / _exchangeRate;
        _balances[msg.sender] += vTokens;
        return 0;
    }

    function redeem(uint256 redeemTokens) external override returns (uint256) {
        if (redeemTokens > _balances[msg.sender]) {
            redeemTokens = _balances[msg.sender];
        }
        uint256 underlyingAmount = (redeemTokens * _exchangeRate) / 1e18;

        // Cap to actual cash held by this mock pool (simulates illiquidity).
        uint256 cash = IERC20(underlying).balanceOf(address(this));
        if (underlyingAmount > cash) underlyingAmount = cash;
        if (underlyingAmount == 0) return 0;

        // Adjust vToken burn to match the actual underlying paid out (cash-capped path).
        uint256 vToBurn = (underlyingAmount * 1e18) / _exchangeRate;
        if (vToBurn > _balances[msg.sender]) vToBurn = _balances[msg.sender];

        _balances[msg.sender] -= vToBurn;
        IERC20(underlying).safeTransfer(msg.sender, underlyingAmount);
        return 0;
    }

    function redeemUnderlying(uint256 redeemAmount) external override returns (uint256) {
        // Cap to user's vToken-equivalent + pool cash.
        uint256 maxUnderlying = (_balances[msg.sender] * _exchangeRate) / 1e18;
        if (redeemAmount > maxUnderlying) redeemAmount = maxUnderlying;

        uint256 cash = IERC20(underlying).balanceOf(address(this));
        if (redeemAmount > cash) redeemAmount = cash;
        if (redeemAmount == 0) return 0;

        uint256 vToBurn = (redeemAmount * 1e18) / _exchangeRate;
        if (vToBurn > _balances[msg.sender]) vToBurn = _balances[msg.sender];

        _balances[msg.sender] -= vToBurn;
        IERC20(underlying).safeTransfer(msg.sender, redeemAmount);
        return 0;
    }

    function balanceOf(address owner) external view override returns (uint256) {
        return _balances[owner];
    }

    function exchangeRateStored() external view override returns (uint256) {
        return _exchangeRate;
    }

    function supplyRatePerBlock() external view override returns (uint256) {
        return _supplyRatePerBlock;
    }

    // ─── Test helpers ───

    /// @notice Simulate yield: bumps `holder`'s vToken balance by the equivalent of
    ///         `underlyingAmount`. Caller must separately fund the pool with underlying.
    function simulateYield(address holder, uint256 underlyingAmount) external {
        uint256 vTokens = (underlyingAmount * 1e18) / _exchangeRate;
        _balances[holder] += vTokens;
    }

    function setExchangeRate(uint256 rate) external {
        _exchangeRate = rate;
    }

    function setSupplyRatePerBlock(uint256 rate) external {
        _supplyRatePerBlock = rate;
    }

    /// @notice Force `mint` to fail with the given non-zero error code (test path).
    bool public mintShouldFail;
    uint256 public mintFailCode = 1;
    function setMintFails(bool fails) external {
        mintShouldFail = fails;
    }
}
