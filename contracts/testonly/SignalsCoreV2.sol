// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/SignalsCore.sol";

/// @notice Test-only SignalsCore upgrade target with a new function.
contract SignalsCoreV2 is SignalsCore {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
