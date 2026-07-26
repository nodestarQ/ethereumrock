// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Local stand-in for the EtherRock v1 contract, for tests and the gallery script only.
///         It mirrors the giftRock / sellRock ownership semantics the wrapper depends on.
///         (It does not reproduce the v1 buyRock bug; the wrapper's defense is verified by
///         asserting that custody rocks end up listed at max price.)
contract MockEtherRock {
    struct Rock {
        address owner;
        bool currentlyForSale;
        uint256 price;
        uint256 timesSold;
    }

    mapping(uint256 => Rock) public rocks;
    uint256 public latestNewRockForSale;

    /// @notice Test helper mimicking the v1 free-mint: claim any unowned rock number for gas.
    function mint(uint256 id) external {
        require(rocks[id].owner == address(0), "already owned");
        rocks[id].owner = msg.sender;
    }

    function sellRock(uint256 id, uint256 price) external {
        require(msg.sender == rocks[id].owner, "not owner");
        require(price > 0, "price 0");
        rocks[id].price = price;
        rocks[id].currentlyForSale = true;
    }

    function giftRock(uint256 id, address receiver) external {
        require(msg.sender == rocks[id].owner, "not owner");
        rocks[id].owner = receiver;
        // real v1 leaves currentlyForSale untouched on a gift
    }

    /// @notice Reproduces the live v1 buyRock bug relevant to the wrapper's defense: buyable at the
    ///         stored price regardless of the sale flag; the seller is paid via .transfer (which
    ///         reverts to a non-payable owner); and the payout is skipped for latestNewRockForSale.
    function buyRock(uint256 id) external payable {
        require(msg.value == rocks[id].price, "price");
        address owner = rocks[id].owner;
        if (id != latestNewRockForSale) {
            payable(owner).transfer(msg.value);
        }
        rocks[id].owner = msg.sender;
    }

    function setLatestNewRockForSale(uint256 v) external {
        latestNewRockForSale = v;
    }

    // --- convenience views for tests ---
    function rockOwner(uint256 id) external view returns (address) {
        return rocks[id].owner;
    }

    function rockPrice(uint256 id) external view returns (uint256) {
        return rocks[id].price;
    }
}
