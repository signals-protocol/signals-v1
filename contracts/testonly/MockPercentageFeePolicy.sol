// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IFeePolicy.sol";

/// @notice Mock fee policy with a percentage descriptor for SDK parity tests.
contract MockPercentageFeePolicy is IFeePolicy {
    uint256 public constant BPS = 125; // 1.25%

    function quoteFee(QuoteParams calldata params) external pure returns (uint256 feeAmount) {
        feeAmount = (params.baseAmount * BPS) / 10_000;
    }

    function name() external pure returns (string memory) {
        return "MockPercentageFeePolicy";
    }

    function descriptor() external pure returns (string memory) {
        return "{\"policy\":\"percentage\",\"params\":{\"bps\":\"125\",\"name\":\"MockPercentageFeePolicy\"},\"name\":\"MockPercentageFeePolicy\"}";
    }
}
