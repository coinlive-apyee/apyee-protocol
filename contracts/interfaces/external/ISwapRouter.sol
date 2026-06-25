// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISwapRouter — minimal UniswapV3 SwapRouter02 (and PancakeSwapV3 SmartRouter) surface
/// @notice Used by Apyee V2.1 strategy adapters in `claimAndCompound` to swap protocol reward
///         tokens (COMP / XVS / SPK / MORPHO / FLUID) back into the vault's underlying USDC.
/// @dev    The SwapRouter02 variant omits the `deadline` parameter (relies on the executing
///         block's timestamp). Used on all four target chains:
///           - Ethereum SwapRouter02      0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
///           - Base      SwapRouter02      0x2626664c2603336E57B271c5C0b26F421741e481
///           - Arbitrum  SwapRouter02      0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
///           - BSC       PancakeV3 SmartRouter 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4
///         All four follow the same `exactInputSingle` shape (PancakeV3 is a UniV3 fork).
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;                  // pool fee tier in 1e-6 units (500 / 3000 / 10000)
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;    // slippage protection — keeper computes off-chain
        uint160 sqrtPriceLimitX96;   // 0 disables the price-limit guard
    }

    /// @notice Swap `amountIn` of `tokenIn` for as much `tokenOut` as possible, with a
    ///         minimum out-amount enforced by `amountOutMinimum`.
    /// @return amountOut  The amount of `tokenOut` received.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
