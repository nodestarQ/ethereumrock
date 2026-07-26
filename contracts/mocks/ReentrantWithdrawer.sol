// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEthereumRockMarketWithdraw {
    function makeOffer(uint256 tokenId) external payable;
    function withdrawOffer(uint256 tokenId) external;
}

/// @notice Test-only bidder that re-enters `withdrawOffer` from its `receive()`.
///
///         `withdrawOffer` pays the caller directly rather than crediting the pull ledger, so this
///         is the adversary that decision has to survive. The payout is a bare `call`, which
///         forwards all remaining gas (unlike `transfer`), so the callback can really do work. The
///         bid is deleted and its bitmap bit cleared BEFORE the ETH moves, and the function is
///         `nonReentrant`, so the re-entry must find nothing to take and must never reach another
///         bidder's escrow.
///
///         The re-entry is wrapped in try/catch so the outer withdrawal still completes: the test
///         then asserts on balances, which is stronger than asserting the whole thing reverted.
contract ReentrantWithdrawer {
    IEthereumRockMarketWithdraw public immutable market;
    uint256 public target;
    bool public reentered;

    constructor(IEthereumRockMarketWithdraw m) {
        market = m;
    }

    function bid(uint256 id) external payable {
        target = id;
        market.makeOffer{value: msg.value}(id);
    }

    function pull(uint256 id) external {
        target = id;
        market.withdrawOffer(id);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try market.withdrawOffer(target) {} catch {}
        }
    }
}
