// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IFeePolicy.sol";

/// @notice Mock fee policy with a custom descriptor for SDK parity tests.
contract MockCustomFeePolicy is IFeePolicy {
    uint256 public constant BPS = 250; // 2.50%

    function quoteFee(QuoteParams calldata params) external pure returns (uint256 feeAmount) {
        feeAmount = (params.baseAmount * BPS) / 10_000;
    }

    function name() external pure returns (string memory) {
        return "MockCustomFeePolicy";
    }

    function descriptor() external pure returns (string memory) {
        return "{\"policy\":\"custom\",\"params\":{\"bps\":\"250\",\"name\":\"MockCustomFeePolicy\"},\"name\":\"MockCustomFeePolicy\"}";
    }
}
