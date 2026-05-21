// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal Aave V3 Pool types — only the fields the strategy actually reads.
/// @dev Field order matches Aave V3.0.x `DataTypes.ReserveData` for ABI compatibility.
library AaveDataTypes {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate; // Supply APR in RAY (1e27). 5% APR = 5e25.
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress; // Interest-bearing token, balance grows in place.
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
}

/// @title IAaveV3Pool
/// @notice Subset of Aave V3 Pool ABI used by AaveV3Strategy.
interface IAaveV3Pool {
    /// @notice Deposit `amount` of `asset` into the pool. Caller (or `onBehalfOf`) receives aTokens 1:1.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Withdraw `amount` of `asset` to `to`. Pass `type(uint256).max` to withdraw the
    ///         caller's full aToken balance. Returns the amount actually withdrawn.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice Read reserve config + rates. We use this for `currentLiquidityRate` and `aTokenAddress`.
    function getReserveData(address asset) external view returns (AaveDataTypes.ReserveData memory);
}
