// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface IEtherRockMock {
    function sellRock(uint256 rockNumber, uint256 price) external;
    function giftRock(uint256 rockNumber, address receiver) external;
}

/// @notice Minimal stand-in for a GenesisRocks-style v1 wrapper, used only to test the
///         one-transaction migration path in EthereumRock.onERC721Received. Same unwrap shape as the
///         real wrappers: burn the NFT and giftRock the raw rock back to the caller.
contract MockOldWrapper is ERC721 {
    IEtherRockMock public immutable rocks;

    constructor(IEtherRockMock rocks_) ERC721("Old Wrapped Rock", "OLD") {
        rocks = rocks_;
    }

    /// @notice Test helper: the caller must have gifted `id` to this contract first.
    function wrap(uint256 id) external {
        rocks.sellRock(id, type(uint256).max);
        _mint(msg.sender, id);
    }

    function unwrap(uint256 id) external {
        require(msg.sender == ownerOf(id), "not owner");
        _burn(id);
        rocks.giftRock(id, msg.sender);
    }
}
