// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/storage/SignalsCoreStorage.sol";
import "../errors/ModuleErrors.sol";
import "../errors/CLMSRErrors.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Delegate-only oracle module (skeleton)
contract OracleModule is SignalsCoreStorage {
    address private immutable self;

    modifier onlyDelegated() {
        if (address(this) == self) revert ModuleErrors.NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    event SettlementPriceSubmitted(
        uint256 indexed marketId,
        int256 settlementValue,
        uint64 priceTimestamp,
        address indexed signer
    );

    function setOracleConfig(address signer) external onlyDelegated {
        if (signer == address(0)) revert CE.ZeroAddress();
        settlementOracleSigner = signer;
    }

    function submitSettlementPrice(
        uint256 marketId,
        int256 settlementValue,
        uint64 priceTimestamp,
        bytes calldata signature
    ) external onlyDelegated {
        ISignalsCore.Market storage market = markets[marketId];
        if (market.numBins == 0) revert CE.MarketNotFound(marketId);
        if (market.settled) revert CE.MarketAlreadySettled(marketId);

        // Tset = settlementTimestamp (the reference time for settlement)
        // startTimestamp < endTimestamp < settlementTimestamp
        uint64 tSet = market.settlementTimestamp;
        
        // Price timestamp must be within [tSet, tSet + submitWindow]
        if (priceTimestamp < tSet) revert CE.SettlementTooEarly(tSet, priceTimestamp);
        if (priceTimestamp > tSet + settlementSubmitWindow) {
            revert CE.SettlementFinalizeWindowClosed(tSet + settlementSubmitWindow, priceTimestamp);
        }
        if (priceTimestamp > block.timestamp) {
            revert CE.SettlementTooEarly(priceTimestamp, uint64(block.timestamp));
        }

        address recovered = _recoverSigner(marketId, settlementValue, priceTimestamp, signature);
        if (recovered != settlementOracleSigner) {
            revert CE.SettlementOracleSignatureInvalid(recovered);
        }

        // Closest-sample rule per whitepaper Section 6:
        // Only update candidate if new sample is strictly closer to Tset.
        // On tie (equal distance), keep existing candidate (prefer earlier submission).
        SettlementOracleState storage state = settlementOracleState[marketId];
        
        if (state.candidatePriceTimestamp == 0) {
            // No existing candidate, accept new one
            state.candidateValue = settlementValue;
            state.candidatePriceTimestamp = priceTimestamp;
            emit SettlementPriceSubmitted(marketId, settlementValue, priceTimestamp, recovered);
        } else {
            // Compare distances to Tset
            // Both timestamps are >= tSet due to validation above
            uint64 existingDistance = state.candidatePriceTimestamp - tSet;
            uint64 newDistance = priceTimestamp - tSet;
            
            // Only update if strictly closer (< not <=)
            if (newDistance < existingDistance) {
                state.candidateValue = settlementValue;
                state.candidatePriceTimestamp = priceTimestamp;
                emit SettlementPriceSubmitted(marketId, settlementValue, priceTimestamp, recovered);
            }
            // If equal or farther, silently ignore (existing candidate preferred)
        }
    }

    /// @notice Returns the settlement price candidate for a market
    /// @dev This is a simple getter for the most recent candidate, not a historical lookup
    /// @param marketId The market ID to query
    /// @return price The settlement value
    /// @return priceTimestamp The timestamp when the price was submitted
    function getSettlementPrice(uint256 marketId)
        external
        onlyDelegated
        returns (int256 price, uint64 priceTimestamp)
    {
        SettlementOracleState storage state = settlementOracleState[marketId];
        if (state.candidatePriceTimestamp == 0) revert CE.SettlementOracleCandidateMissing();
        price = state.candidateValue;
        priceTimestamp = state.candidatePriceTimestamp;
    }

    function _recoverSigner(
        uint256 marketId,
        int256 settlementValue,
        uint64 priceTimestamp,
        bytes calldata signature
    ) internal view returns (address) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), marketId, settlementValue, priceTimestamp))
        );
        return ECDSA.recover(digest, signature);
    }
}
