// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
//       ##
//       ####          EthereumRock
//     ########
//     ########        the market
//     ########
//       ######
//
// A marketplace for your EthereumRocks with zero fees! (I hope it has no bugs lmao)
*/

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev EthereumRock's ERC-721 surface plus the packed per-id record the market prices against:
///      `mass` because a merge can grow a listed rock, and `burns` because an unwrap can destroy the
///      token under a listing and a re-wraps bring the same id back.
interface IEthereumRock is IERC721 {
    function traits(
        uint256 id
    ) external view returns (uint32 mass, uint32 dust, uint24 burns);
}

/// @title EthereumRockMarket
/// @notice Zero-fee, ownerless, non-custodial market for one ERC-721 (EthereumRock).
///         sellers keep custody and approve the market. 100% of
///         every sale goes to the seller as payouts that need to be pulled.
///
///         Bound at deploy to one EthereumRock contract, so it can never be repointed.
///         A rock burned by `merge` is gone for good: its v1 rock stays locked in EthereumRock, so
///         it can never come back and no order can revive on it.
contract EthereumRockMarket is ReentrancyGuard {
    /// @notice The one EthereumRock collection this market serves.
    IEthereumRock public immutable rock;

    /// @notice EthereumRock's own cap: ids 0..9999 it bounds the bitmaps below.
    uint256 public constant MAX_ID = 10000;
    uint256 private constant WORDS = 40; // ceil(MAX_ID / 256)

    struct Listing {
        address seller; // slot 0: 160
        uint96 price; // slot 0:  96
        address onlyTo; // slot 1: 160, non-zero means a private sale to this address only
        uint40 expiry; // slot 1:  40, unix seconds and a buy reverts past it
        uint32 massSnap; // slot 1:  32, rock.traits.mass at list time
        uint24 burnSnap; // slot 1:  24  = 256, rock.traits.burns at list time
    }

    struct Bid {
        address bidder;
        uint96 amount; // escrowed wei
    }

    /// @dev The buyer is deliberately NOT stored: `rock.ownerOf(id)` already gives the
    ///      holder for free (and that IS the last buyer unless they moved it since), and the exact
    ///      buyer and seller are one log hop away via `blockNum`.
    struct SaleInfo {
        uint96 price; // slot: 96, last sale price
        uint40 time; // slot: 40, when
        uint32 blockNum; // slot: 32, block of that sale (head of the log linked list)
        uint32 count; // slot: 32, sales ever
    }

    mapping(uint256 => Listing) public listings; // tokenId => active listing
    mapping(uint256 => Bid) public bids; // tokenId => single highest standing bid
    mapping(uint256 => SaleInfo) public lastSale; // tokenId => latest sale + history head
    mapping(address => uint256) public pendingWithdrawals; // pull-payment ledger

    /// @notice Cumulative ETH volume across every sale (buy + acceptOffer). A display stat only,
    ///         accumulated as `+= price` per sale.
    uint256 public totalVolume;

    // Set while an order is on the books, so the whole set is 40 SLOADs to read
    // instead of a 10,000-slot scan and is cleared by every path that deletes the order.
    uint256[WORDS] private _listedBits;
    uint256[WORDS] private _bidBits;

    event Listed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
        address onlyTo,
        uint40 expiry
    );
    event Unlisted(uint256 indexed tokenId, address indexed seller);
    event Offered(
        uint256 indexed tokenId,
        address indexed bidder,
        uint256 amount
    );
    event OfferWithdrawn(
        uint256 indexed tokenId,
        address indexed bidder,
        uint256 amount
    );
    event Withdrawn(address indexed who, uint256 amount);

    // The two sale events. `prevBlock` is the block of the previous sale of this same rock (0 if
    // this is its first), which is what threads the log history together.
    event Bought(
        uint256 indexed tokenId,
        address indexed buyer,
        address indexed seller,
        uint256 price,
        uint32 prevBlock
    );
    event OfferAccepted(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed bidder,
        uint256 amount,
        uint32 prevBlock
    );

    error BadId();
    error ZeroPrice();
    error BadExpiry();
    error NotOwner();
    error NotApproved();
    error NotSeller();
    error NotListed();
    error NotBidder();
    error WrongPrice();
    error Expired();
    error PrivateSale();
    error StaleOwner();
    error StaleApproval();
    error MassDrifted();
    error BurnedSince();
    error ZeroBid();
    error BidTooLarge();
    error BidTooLow();
    error NoBid();
    error BelowMin();
    error StillValid();
    error ZeroBuyer();
    error Nothing();
    error WithdrawFailed();

    constructor(IEthereumRock rock_) {
        rock = rock_;
    }

    // =====================================================================
    //                              Listings
    // =====================================================================

    /// @notice List a rock you own for sale to anyone, until `expiry`. Requires you have approved
    ///         this market first (`rock.approve(market, id)` or `rock.setApprovalForAll(market, true)`).
    function list(uint256 tokenId, uint96 price, uint40 expiry) external {
        _list(tokenId, price, expiry, address(0));
    }

    /// @notice List a rock for sale only to `buyer` (a private sale).
    function listTo(
        uint256 tokenId,
        uint96 price,
        uint40 expiry,
        address buyer
    ) external {
        if (buyer == address(0)) revert ZeroBuyer();
        _list(tokenId, price, expiry, buyer);
    }

    function _list(
        uint256 tokenId,
        uint96 price,
        uint40 expiry,
        address onlyTo
    ) internal {
        if (tokenId >= MAX_ID) revert BadId();
        if (price == 0) revert ZeroPrice();
        if (expiry <= block.timestamp) revert BadExpiry();
        if (rock.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (!_approved(tokenId, msg.sender)) revert NotApproved();

        (uint32 m, , uint24 burns) = rock.traits(tokenId);

        listings[tokenId] = Listing(
            msg.sender,
            price,
            onlyTo,
            expiry,
            m,
            burns
        );
        _set(_listedBits, tokenId);
        emit Listed(tokenId, msg.sender, price, onlyTo, expiry);
    }

    /// @notice Cancel your own listing.
    function cancelListing(uint256 tokenId) external {
        if (listings[tokenId].seller != msg.sender) revert NotSeller();
        delete listings[tokenId];
        _clear(_listedBits, tokenId);
        emit Unlisted(tokenId, msg.sender);
    }

    /// @notice Buy a listed rock at its exact price. 100% of the payment is credited to the seller
    ///         (withdrawable via `withdraw`).
    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.value != l.price) revert WrongPrice();
        if (block.timestamp > l.expiry) revert Expired();
        if (l.onlyTo != address(0) && l.onlyTo != msg.sender)
            revert PrivateSale();
        // the listing may be stale, so the rock could have moved or been unwrapped since listing
        if (rock.ownerOf(tokenId) != l.seller) revert StaleOwner();
        if (!_approved(tokenId, l.seller)) revert StaleApproval();
        // ...or the rock itself may have grown under the listing via merge, or been unwrapped and
        // re-wrapped, which rebuilds the same id with the same owner, mass and approval
        (uint32 m, , uint24 burns) = rock.traits(tokenId);
        if (m != l.massSnap) revert MassDrifted();
        if (burns != l.burnSnap) revert BurnedSince();

        // effects
        delete listings[tokenId];
        _clear(_listedBits, tokenId);
        pendingWithdrawals[l.seller] += msg.value;
        // if the buyer also had a standing bid, refund it.
        Bid memory b = bids[tokenId];
        if (b.bidder == msg.sender) {
            delete bids[tokenId];
            _clear(_bidBits, tokenId);
            pendingWithdrawals[msg.sender] += b.amount;
            emit OfferWithdrawn(tokenId, msg.sender, b.amount);
        }

        emit Bought(
            tokenId,
            msg.sender,
            l.seller,
            msg.value,
            _recordSale(tokenId, l.price)
        );
        // The buyer's onERC721Received can reach the unguarded list /
        // cancelListing / pruneListing, but every effect above is final and the guard blocks
        // re-entry into anything that moves funds.
        rock.safeTransferFrom(l.seller, msg.sender, tokenId);
    }

    // =====================================================================
    //                             Bids / offers
    // =====================================================================

    /// @notice Place or raise the standing bid on a rock, escrowing your ETH.
    ///
    ///         Outbidding someone else costs the full amount and must strictly exceed their bid.
    ///         Theirs is refunded to the pull ledger.
    ///
    ///         Raising your OWN bid is a top-up: what you have escrowed counts toward the new total,
    ///         so you send only the difference. Otherwise raising would need twice the bid in free
    ///         ETH, which at size is the difference between being able to raise and not.
    /// @dev `Offered.amount` is always the resulting TOTAL, not msg.value. An `Offered` naming a new
    ///      bidder implies the previous bid was refunded.
    function makeOffer(uint256 tokenId) external payable nonReentrant {
        if (tokenId >= MAX_ID) revert BadId();
        if (msg.value == 0) revert ZeroBid();
        Bid memory prev = bids[tokenId];

        uint256 amount = msg.value;
        if (prev.bidder == msg.sender) {
            // Nothing leaves the contract, so no OfferWithdrawn fires. The invariant "every return
            // of bid escrow emits OfferWithdrawn" returns nothing.
            amount += prev.amount;
        } else {
            if (msg.value <= prev.amount) revert BidTooLow();
            if (prev.amount > 0) {
                // Refund the outbid party through the ledger. This is a THIRD PARTY, so a push
                // could be made to revert and would let one bidder make itself un-outbiddable.
                // (Taking your OWN bid back pays out directly, see `withdrawOffer`.)
                pendingWithdrawals[prev.bidder] += prev.amount;
                emit OfferWithdrawn(tokenId, prev.bidder, prev.amount);
            }
        }
        if (amount > type(uint96).max) revert BidTooLarge();

        bids[tokenId] = Bid(msg.sender, uint96(amount));
        _set(_bidBits, tokenId);
        emit Offered(tokenId, msg.sender, amount);
    }

    /// @notice Take back your standing bid which only the current bidder can and the ETH goes straight
    ///         to them. Touches no rock state, so it works even on a rock
    ///         that has since been merged away.
    /// @dev The one payout that skips `pendingWithdrawals`, because the recipient is the CALLER.
    ///      Pull payments exist so a THIRD PARTY who cannot accept ETH cannot brick someone else's
    ///      transaction. A caller who cannot receive ETH only fails their own call. The bid is deleted before the send, so re-entry finds nothing.
    function withdrawOffer(uint256 tokenId) external nonReentrant {
        Bid memory b = bids[tokenId];
        if (b.bidder != msg.sender) revert NotBidder();

        // effects
        delete bids[tokenId];
        _clear(_bidBits, tokenId);
        emit OfferWithdrawn(tokenId, msg.sender, b.amount);

        // interaction, last
        (bool ok, ) = payable(msg.sender).call{value: b.amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice As the rock's owner, accept the standing bid. 100% is credited to you. `minAmount`
    ///         guards against the bid changing before you land (this requires market approval).
    /// @dev The recipient is the BIDDER, not
    ///      the caller, so a receiver callback would hand a third party a veto over the seller's
    ///      transaction. A contract with no onERC721Received could park an unacceptable bid that,
    ///      since `makeOffer` is strictly increasing, also blocks every honest bid under it for
    ///      free. A receiver can pass then stop. The
    ///      bidder chose their own address and escrowed ETH to receive this token.
    function acceptOffer(
        uint256 tokenId,
        uint96 minAmount
    ) external nonReentrant {
        if (rock.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (!_approved(tokenId, msg.sender)) revert NotApproved();
        Bid memory b = bids[tokenId];
        if (b.amount == 0) revert NoBid();
        if (b.amount < minAmount) revert BelowMin();

        delete bids[tokenId];
        _clear(_bidBits, tokenId);

        // any listing dies with the sale. Its seller may not be msg.sender (rock transferred after
        // listing), so OfferAccepted alone cannot identify it.
        address prevSeller = listings[tokenId].seller;
        if (prevSeller != address(0)) {
            delete listings[tokenId];
            _clear(_listedBits, tokenId);
            emit Unlisted(tokenId, prevSeller);
        }

        pendingWithdrawals[msg.sender] += b.amount;
        emit OfferAccepted(
            tokenId,
            msg.sender,
            b.bidder,
            b.amount,
            _recordSale(tokenId, b.amount)
        );
        rock.transferFrom(msg.sender, b.bidder, tokenId);
    }

    /// @dev Record a sale and return the block of this rock's PREVIOUS sale for the event to carry.
    ///      Writes the per-rock lastSale slot plus the global totalVolume accumulator (a display stat).
    function _recordSale(
        uint256 tokenId,
        uint96 price
    ) private returns (uint32 prevBlock) {
        SaleInfo memory s = lastSale[tokenId];
        prevBlock = s.blockNum;
        lastSale[tokenId] = SaleInfo(
            price,
            uint40(block.timestamp),
            uint32(block.number),
            s.count + 1
        );
        totalVolume += price;
    }

    // =====================================================================
    //                            Withdrawals
    // =====================================================================

    /// @notice Withdraw your accumulated proceeds and refunds.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert Nothing();
        pendingWithdrawals[msg.sender] = 0; // zero before send
        emit Withdrawn(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // =====================================================================
    //                          Views / housekeeping
    // =====================================================================

    /// @notice Clear a listing that can no longer execute, so the book does
    ///         not carry it.
    function pruneListing(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();

        bool stale = block.timestamp > l.expiry;
        if (!stale) {
            try rock.ownerOf(tokenId) returns (address o) {
                // `||` short-circuits, so the calls below only run on a token proven to exist
                stale =
                    o != l.seller ||
                    !_approved(tokenId, l.seller) ||
                    _drifted(tokenId, l);
            } catch {
                stale = true; // token burned (merged / unwrapped) so ownerOf reverts
            }
        }
        if (!stale) revert StillValid();

        delete listings[tokenId];
        _clear(_listedBits, tokenId);
        emit Unlisted(tokenId, l.seller);
    }

    /// @notice 40 words set where a listing is on the books. Fetch this, decode the
    ///         set bits client-side, then pass them to `getListings`.
    function listedBitmap() external view returns (uint256[WORDS] memory) {
        return _listedBits;
    }

    /// @notice Same, for standing bids.
    function bidBitmap() external view returns (uint256[WORDS] memory) {
        return _bidBits;
    }

    /// @notice Batch-read listings. Pair with `listedBitmap` to render the book with no log scan.
    function getListings(
        uint256[] calldata ids
    ) external view returns (Listing[] memory out) {
        out = new Listing[](ids.length);
        for (uint256 i; i < ids.length; ) {
            out[i] = listings[ids[i]];
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Batch-read bids. Pair with `bidBitmap`.
    function getBids(
        uint256[] calldata ids
    ) external view returns (Bid[] memory out) {
        out = new Bid[](ids.length);
        for (uint256 i; i < ids.length; ) {
            out[i] = bids[ids[i]];
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Batch-read last sales, so a whole gallery of "last sold for X" is one eth_call.
    ///         `blockNum` is each rock's history head, you just need to follow `prevBlock` in the logs from there.
    function getLastSales(
        uint256[] calldata ids
    ) external view returns (SaleInfo[] memory out) {
        out = new SaleInfo[](ids.length);
        for (uint256 i; i < ids.length; ) {
            out[i] = lastSale[ids[i]];
            unchecked {
                ++i;
            }
        }
    }

    function _approved(
        uint256 tokenId,
        address owner
    ) internal view returns (bool) {
        return
            rock.getApproved(tokenId) == address(this) ||
            rock.isApprovedForAll(owner, address(this));
    }

    /// @dev Has the rock changed under this listing since it was written. 
    ///      Only for the caller that already knows the token exists.
    function _drifted(
        uint256 tokenId,
        Listing memory l
    ) private view returns (bool) {
        (uint32 m, , uint24 burns) = rock.traits(tokenId);
        return m != l.massSnap || burns != l.burnSnap;
    }

    function _set(uint256[WORDS] storage bm, uint256 id) private {
        bm[id >> 8] |= (uint256(1) << (id & 0xff));
    }

    function _clear(uint256[WORDS] storage bm, uint256 id) private {
        bm[id >> 8] &= ~(uint256(1) << (id & 0xff));
    }
}
