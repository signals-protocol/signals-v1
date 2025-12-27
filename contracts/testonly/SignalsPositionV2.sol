// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../position/SignalsPosition.sol";

/// @notice Test-only SignalsPosition upgrade target with a new function.
contract SignalsPositionV2 is SignalsPosition {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
