// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEthereumRockMarketPayouts {
    function makeOffer(uint256 tokenId) external payable;
    function withdrawOffer(uint256 tokenId) external;
    function withdraw() external;
}

/// @notice Test-only market participant that can refuse ETH on the way in.
///         `withdraw()` zeroes a balance BEFORE sending and depends on its own revert to undo that
///         if the send fails. This contract is what proves the undo actually happens: a payout that
///         bounces must cost the credit nothing, since the market has no owner and no sweep, so a
///         credit destroyed by a failed transfer would be gone for good.
contract PickyReceiver {
    IEthereumRockMarketPayouts public immutable market;
    bool public rejecting = true;

    constructor(IEthereumRockMarketPayouts m) {
        market = m;
    }

    function setRejecting(bool v) external {
        rejecting = v;
    }

    function bid(uint256 id) external payable {
        market.makeOffer{value: msg.value}(id);
    }

    function pull(uint256 id) external {
        market.withdrawOffer(id);
    }

    function claim() external {
        market.withdraw();
    }

    receive() external payable {
        require(!rejecting, "no thanks");
    }
}
