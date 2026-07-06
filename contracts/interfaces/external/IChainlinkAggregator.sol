// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IChainlinkAggregator — minimal Chainlink AggregatorV3Interface surface
/// @notice Used by BaseStrategy (V2.1.2) to compute an on-chain fair-price floor for
///         `minOut` in `_swapAndReinvest`. Only the fields we actually consume are
///         declared, to keep the trust surface obvious to auditors.
/// @dev    Reference: https://docs.chain.link/data-feeds/api-reference#aggregatorv3interface
interface IChainlinkAggregator {
    /// @notice Decimals of the price answer (typically 8 for USD feeds).
    function decimals() external view returns (uint8);

    /// @notice Latest price round.
    /// @return roundId      The round id (unused).
    /// @return answer       Price scaled by `decimals()`. Must be > 0.
    /// @return startedAt    Timestamp of round start (unused).
    /// @return updatedAt    Timestamp of last answer update — staleness check anchor.
    /// @return answeredInRound The round id (unused).
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
