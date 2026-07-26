// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEthereumRockMarketBids {
    function makeOffer(uint256 tokenId) external payable;
    function withdrawOffer(uint256 tokenId) external;
}

/// @notice Test-only bidder contract that holds ETH but implements NO onERC721Received.
///         Under `safeTransferFrom` delivery this address would veto its own sale, freezing the
///         rock's single bid slot at zero cost. `acceptOffer` uses `transferFrom` precisely so a
///         bid from here is still fillable: the bidder chose this address and escrowed for it.
contract NonReceiverBidder {
    IEthereumRockMarketBids public immutable market;

    constructor(IEthereumRockMarketBids m) {
        market = m;
    }

    function bid(uint256 id) external payable {
        market.makeOffer{value: msg.value}(id);
    }

    function pull(uint256 id) external {
        market.withdrawOffer(id);
    }

    receive() external payable {}
    // deliberately no onERC721Received
}
