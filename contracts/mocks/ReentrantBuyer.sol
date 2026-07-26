// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEthereumRockMarket {
    function buy(uint256 tokenId) external payable;
}

/// @notice Test-only malicious ERC-721 receiver: on receiving a rock it tries to re-enter the
///         market. The market's checks-effects-interactions + nonReentrant must make the whole
///         buy revert atomically, so the attacker gains nothing.
contract ReentrantBuyer {
    IEthereumRockMarket public immutable market;
    uint256 public target;

    constructor(IEthereumRockMarket m) {
        market = m;
    }

    function attack(uint256 id) external payable {
        target = id;
        market.buy{value: msg.value}(id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        market.buy{value: 0}(target); // re-entry attempt; must revert
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
