// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
//       ##
//       ####          EthereumRock
//     ########
//     ########        a fully on-chain wrapper for EtherRock v1, 2017
//     ########
//       ######
//
//
// Wraps EtherRock v1 at 0x37504AE0282f5f334ED29b4548646f887977b7cC, deployed 25 Dec 2017,
//
// SECURITY: v1's buyRock lets anyone buy any rock at its stored price, so a rock this contract
// holds must never be cheap.
//
//   1. Max price. Every rock taken into custody is listed at type(uint256).max on arrival
//      (EthereumRockWarden.claim for wraps, onERC721Received for migrations).
//   2. Non-payable. Neither this contract nor the warden has receive() or fallback(), so v1's
//      `owner.transfer(price)` reverts while either holds a rock. DO NOT ADD ONE.
//
// Defense 2 has one hole: v1 skips the owner payout when `id == latestNewRockForSale`. On 0x37504
// that is rock #14, frozen at a dead address at max price, so it is unreachable there. Defense 2
// also does not cover the window between a user's giftRock(id, warden) and wrap(id), where the rock
// still sits at its old price. The frontend closes that by calling sellRock(id, max) before gifting.
//
// Mainnet constructor arguments:
//   rocks_         0x37504AE0282f5f334ED29b4548646f887977b7cC  EtherRock v1
//   wrapperSub100_ 0xb895cAffECb62B5E49828c9d64116Fd07Dd33DEF  GenesisRocks, ids 0-99
//   wrapper10k_    0x39b780E8062CE299ab60ed3D48F447e97511a2eD  GenesisRocks10000, ids 100-9999
//   renderer_      the EthereumRockRenderer deployed alongside this contract
*/

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev EtherRock v1. Ownership is a plain address mapping moved by giftRock. sellRock sets a price.
interface IEtherRock {
    function sellRock(uint256 rockNumber, uint256 price) external;

    function giftRock(uint256 rockNumber, address receiver) external;
}

/// @dev Minimal surface of the existing v1 wrappers we migrate away from.
interface IRockWrapperV1 {
    function unwrap(uint256 id) external;
}

/// @dev Immutable on-chain renderer. Builds the base64 JSON + SVG tokenURI.
interface IEthereumRockRenderer {
    function render(
        uint256 id,
        bytes32 seed,
        uint256 mass,
        uint256 dust
    ) external view returns (string memory);
}

/// @notice A single-user escrow, one per depositor.
/// @dev Why this exists: v1's giftRock has no callback, so a shared vault could not tell who
///      deposited a rock and wrap() would be a race. A per-user address makes attribution a
///      property of the address itself.
///      Operator is the deploying EthereumRock contract, and both it and the v1 address are
///      immutable, so a warden targets one rock contract for life and never takes an address
///      from its caller.
contract EthereumRockWarden {
    address public immutable operator;
    IEtherRock public immutable rocks;

    constructor(IEtherRock rocks_) {
        operator = msg.sender; // the EthereumRock contract
        rocks = rocks_;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    /// @notice Pull `id`, already gifted into this warden, into the wrapper.
    /// @dev Max price FIRST. Reversing these two lines would leave the rock buyable at its old
    ///      price for the length of the call. Reverts if the rock is not in this warden.
    function claim(uint256 id) external onlyOperator {
        rocks.sellRock(id, type(uint256).max);
        rocks.giftRock(id, operator);
    }

    /// @notice Return a rock stuck in this warden to `recipient`. This is a safety hatch for the user.
    function withdraw(uint256 id, address recipient) external onlyOperator {
        rocks.giftRock(id, recipient);
    }
}

/// @title EthereumRock
/// @notice Wrap v1 rocks, raw or migrated from the old wrappers, render them on chain, and merge
///         to consolidate the supply back toward the original 100.
contract EthereumRock is ERC721, IERC721Receiver, ReentrancyGuard {
    // ---------- v1 lineage + renderer ----------
    IEtherRock public immutable ROCKS;
    address public immutable WRAPPER_SUB100; // GenesisRocks
    address public immutable WRAPPER_10K; // GenesisRocks10000
    IEthereumRockRenderer public immutable renderer;

    /// @notice Ids 0..9999 form the collection; anything >= this is "dust" that can only be absorbed.
    uint256 public constant MAX_ID = 10000;

    /// @dev ceil(MAX_ID / 256): the bitmap width used by `wrappedBitmap`.
    uint256 private constant WORDS = 40;

    /// @notice Mass at a rock's first wrap. 21000 is Ethereum's base transaction gas cost.
    /// @dev Caps total mass at 21000 * 10000 = 210,000,000, which is why uint32 holds it.
    uint256 public constant BASE_MASS = 21000;

    // ---------- per-user escrow ----------
    mapping(address => address) public wardens;

    // ---------- traits (all persist through unwrap) ----------
    /// @dev One slot per id. Packed because these are read and written together: merge moves mass
    ///      and dust, the market reads mass and burns.
    struct Traits {
        uint32 mass; // originals this rock represents //BASE_MASS at first wrap
        uint32 dust; // >= MAX_ID rocks absorbed into this rock, each adds +1
        uint24 burns; // times a token for this id has been burned //see `_update`
    }

    /// @notice mass, dust and burn count for an id. The market uses this to snapshot a
    ///         listing in a single call.
    mapping(uint256 => Traits) public traits;
    mapping(uint256 => bytes32) public seed; // visual entropy it is set once at first wrap (can kinda get CHEESED, but we have no real rarity, so it is ok!)

    /// @dev One bit per id set while that rock is wrapped (a live token). Maintained in `_update`,
    ///      so mint and burn cannot drift from it. Lets a frontend enumerate the whole collection in
    ///      a single eth_call instead of scanning logs or probing 10,000 ids.
    uint256[WORDS] private _wrappedBits;

    /// @notice On a merge, which look the surviving rock keeps.
    enum Look {
        First, // the first rock you passed
        Second, // the second rock you passed
        Reroll // a fresh random variation
    }

    constructor(
        IEtherRock rocks_,
        address wrapperSub100_,
        address wrapper10k_,
        IEthereumRockRenderer renderer_
    ) ERC721("EthereumRock", "EROCK") {
        ROCKS = rocks_;
        WRAPPER_SUB100 = wrapperSub100_;
        WRAPPER_10K = wrapper10k_;
        renderer = renderer_;
    }

    // =====================================================================
    //                              Wrapping
    // =====================================================================

    /// @notice One-time: deploy a personal escrow warden.
    function createWarden() external {
        require(wardens[msg.sender] == address(0), "warden exists");
        wardens[msg.sender] = address(new EthereumRockWarden(ROCKS));
    }

    /// @notice Wrap a raw v1 rock you have already gifted into your warden.
    function wrap(uint256 id) external nonReentrant {
        require(id < MAX_ID, "id >= 10000");
        address warden = wardens[msg.sender];
        require(warden != address(0), "no warden");
        EthereumRockWarden(warden).claim(id); // sellRock(max) + giftRock(this) //reverts if not in your warden
        _intake(msg.sender, id);
    }

    /// @notice Burn the NFT and return the raw rock to you on the v1 contract.
    /// @dev seed, mass and dust persist, so re-wrapping restores the same rock.
    function unwrap(uint256 id) external nonReentrant {
        require(ownerOf(id) == msg.sender, "not owner");
        _burn(id);
        ROCKS.giftRock(id, msg.sender);
    }

    /// @notice Recover a rock sitting in your warden that you never wrapped.
    function rescue(uint256 id) external nonReentrant {
        address warden = wardens[msg.sender];
        require(warden != address(0), "no warden");
        EthereumRockWarden(warden).withdraw(id, msg.sender);
    }

    /// @notice Migrate from an old wrapper in one transaction. safeTransferFrom the old NFT here,
    ///         it is unwrapped and re-minted to `from`.
    function onERC721Received(
        address,
        address from,
        uint256 id,
        bytes calldata
    ) external override nonReentrant returns (bytes4) {
        require(
            msg.sender == WRAPPER_SUB100 || msg.sender == WRAPPER_10K,
            "unknown wrapper"
        );
        require(id < MAX_ID, "id >= 10000");
        IRockWrapperV1(msg.sender).unwrap(id); // old wrapper giftRocks the raw rock to us
        ROCKS.sellRock(id, type(uint256).max); // re-assert the anti-theft defense on our custody rock
        _intake(from, id);
        return this.onERC721Received.selector;
    }

    // =====================================================================
    //                           Merge & absorb
    // =====================================================================

    /// @notice Merge two rocks you own. The lower id survives with both masses/dust and the higher one will be burned.
    ///         Rocks 0-99 can never burn, so full consolidation ideally collapses into the original 100.
    /// @param look 0 = keep firstId's art, 1 = keep secondId's art, 2 = reroll a new variation.
    function merge(
        uint256 firstId,
        uint256 secondId,
        Look look
    ) external nonReentrant {
        require(firstId != secondId, "same id");
        (uint256 low, uint256 high) = firstId < secondId
            ? (firstId, secondId)
            : (secondId, firstId);
        require(
            ownerOf(low) == msg.sender && ownerOf(high) == msg.sender,
            "not owner"
        );
        require(high >= 100, "0-99 cannot burn");

        // one slot each, we read and written once.  Arithmetic gets checked so neither sum can wrap.
        Traits memory a = traits[low];
        Traits memory b = traits[high];
        traits[low] = Traits(a.mass + b.mass, a.dust + b.dust, a.burns);

        if (look == Look.First) {
            seed[low] = seed[firstId];
        } else if (look == Look.Second) {
            seed[low] = seed[secondId];
        } else {
            seed[low] = keccak256(
                abi.encodePacked(block.prevrandao, low, seed[low], "reroll")
            );
        }

        // mass and dust have moved to the survivor. The burn count is carried, so it
        // stays monotonic per id. `_burn` below adds one more.
        traits[high] = Traits(0, 0, b.burns);
        _burn(high);
        // The burned rock's underlying v1 token stays locked in this contract at max price.
    }

    /// @notice Burn a v1 rock >= MAX_ID, gifted into your warden, for +1 dust on a rock you own.
    ///         Dust is unlimited supply so each one is worth exactly one, we are turning them into some kind of shitcoin hehe.
    function absorb(uint256 highId, uint256 intoId) external nonReentrant {
        require(highId >= MAX_ID, "not dust");
        require(ownerOf(intoId) == msg.sender, "not owner");
        address warden = wardens[msg.sender];
        require(warden != address(0), "no warden");
        EthereumRockWarden(warden).claim(highId); // pulls + locks the dust rock here and no token gets minted
        traits[intoId].dust += 1; // checked arithmetic
    }

    // =====================================================================
    //                        Randomness (randao)
    // =====================================================================

    /// @dev RANDAO in one transaction is enough here because traits are flat. We have no rarity tiers, so
    ///      there is nothing worth grinding for. An oracle would also break censorship resistance. Not good! :(
    /// @dev The seed doubles as the "already rolled" flag. It is written once per id and never
    ///      cleared by unwrap or merge and keccak256 output is never zero.
    function _roll(uint256 id) internal returns (bool fresh) {
        fresh = seed[id] == bytes32(0);
        if (fresh)
            seed[id] = keccak256(
                abi.encodePacked(block.prevrandao, id, address(this))
            );
    }

    /// @dev Shared in wrap and migrate. Rolls the art once, sets BASE_MASS on an id's first
    ///      ever wrap, mints. The seed is read once.
    function _intake(address to, uint256 id) private {
        if (_roll(id)) traits[id].mass = uint32(BASE_MASS);
        _mint(to, id);
    }

    /// @dev The single choke point for mint, transfer and burn in OZ v5. 
    ///      Ids are always < MAX_ID, so the word index is in range.
    ///      A burn also bumps a per-id counter. This is what stops a stale listing reviving. unwrap
    ///      destroys a token and wrap re-mints the same id, and since approvals survive a burn while
    ///      mass, seed and owner survive an unwrap, every check a market makes would come back true
    ///      and sell a rebuilt rock at its old price. The market snapshots this counter, so any burn
    ///      in between voids the listing.
    ///
    ///      Saturating, not checked. At type(uint24).max it stops instead of reverting, since an id
    ///      that can never be burned again is worse than one whose stale listings revive. Reaching
    ///      it takes 16.7M wrap/burn cycles on one id, around 3e12 gas.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from == address(0)) {
            _wrappedBits[tokenId >> 8] |= (uint256(1) << (tokenId & 0xff)); // mint
        } else if (to == address(0)) {
            _wrappedBits[tokenId >> 8] &= ~(uint256(1) << (tokenId & 0xff)); // burn
            uint24 b = traits[tokenId].burns;
            if (b != type(uint24).max) traits[tokenId].burns = b + 1;
        }
        return from;
    }

    // =====================================================================
    //                          Metadata + views
    // =====================================================================

    /// @notice Fully on-chain tokenURI which is assembled by the immutable renderer.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Traits memory t = traits[id];
        return renderer.render(id, seed[id], t.mass, t.dust);
    }

    /// @notice Live tokens, counted from the bitmap.
    /// @dev A counter would be a second source of truth plus a storage write on
    ///      every mint and burn. Costs nothing to write, paid for by whoever reads. Kernighan's loop
    ///      turns once per live token, so 40 SLOADs and at most 10,000 iterations.
    function totalSupply() external view returns (uint256 n) {
        for (uint256 w; w < WORDS; ++w) {
            uint256 bits = _wrappedBits[w];
            while (bits != 0) {
                bits &= bits - 1; // clear the lowest set bit
                unchecked {
                    ++n;
                }
            }
        }
    }

    /// @notice Whether this id's art has ever been rolled. Tells "never wrapped" apart from
    ///         "unwrapped, and the same rock comes back". Derived from the seed, see `_roll`.
    function rolled(uint256 id) external view returns (bool) {
        return seed[id] != bytes32(0);
    }

    /// @notice Originals this rock represents. BASE_MASS at first wrap and can only grow by merge.
    function mass(uint256 id) external view returns (uint256) {
        return traits[id].mass;
    }

    /// @notice Dust rocks (v1 ids >= MAX_ID) absorbed into this rock, +1 each.
    function dust(uint256 id) external view returns (uint256) {
        return traits[id].dust;
    }

    /// @notice tokenURI for many ids in one eth_call, so a gallery is one round trip instead of one
    ///         per tile.
    /// @dev Each entry renders a full
    ///      SVG, so a big enough batch will exceed whatever gas an RPC allows a call. Ask for a page
    ///      at a time (the EthereumRockSite asks for 12) and not the whole collection.
    function tokenURIBatch(
        uint256[] calldata ids
    ) external view returns (string[] memory out) {
        out = new string[](ids.length);
        for (uint256 i; i < ids.length; ) {
            uint256 id = ids[i];
            if (_ownerOf(id) != address(0)) {
                Traits memory t = traits[id];
                out[i] = renderer.render(id, seed[id], t.mass, t.dust);
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice 40 words with one bit per id also set where that rock is currently wrapped. Fetch this, decode
    ///         the set bits client-side and you have the entire live collection in one eth_call, with
    ///         no indexer and no log scan. Mirrors the market's listedBitmap / bidBitmap.
    function wrappedBitmap() external view returns (uint256[WORDS] memory) {
        return _wrappedBits;
    }

    /// @notice Every rock currently owned by `owner` reads straight from the wrapped bitmap. Like
    ///         wrappedBitmap() this is a pure view. It touches only live ids, in ascending order, and stops the moment it
    ///         has found all `balanceOf(owner)` of them. Kinda a cheaper ERC721Enumerable alternative in this case.
    function tokensOfOwner(
        address owner
    ) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner);
        ids = new uint256[](n);
        if (n == 0) return ids;
        uint256 k;
        for (uint256 w; w < WORDS; ++w) {
            uint256 bits = _wrappedBits[w];
            uint256 base = w << 8;
            while (bits != 0) {
                uint256 lowest = bits & (~bits + 1); // isolate lowest set bit //bits != 0 so no overflow
                uint256 id = base + Math.log2(lowest); // exact bit index (lowest is a power of two)
                if (_ownerOf(id) == owner) {
                    ids[k] = id;
                    unchecked {
                        ++k;
                    }
                    if (k == n) return ids; // cannot own more than balanceOf, so we stop
                }
                bits ^= lowest; // clear it and move to the next set bit
            }
        }
    }

    /// @notice tokensOfOwner limited to ids in [fromId, toId). A deterministic paging backstop for the
    ///         (hypothetical) case where a fully saturated 10,000-rock collection makes the
    ///         unbounded call exceed some RPC's eth_call gas cap.
    function tokensOfOwnerIn(
        address owner,
        uint256 fromId,
        uint256 toId
    ) external view returns (uint256[] memory ids) {
        if (toId > MAX_ID) toId = MAX_ID;
        // A window can hold no more of the owner's ids than the owner holds in total, so balanceOf is
        // a safe upper bound to allocate against and the real length is written back at the end.
        uint256 cap = balanceOf(owner);
        ids = new uint256[](cap);
        uint256 k;
        if (cap != 0 && fromId < toId) {
            uint256 wEnd = (toId - 1) >> 8; // toId >= 1 here, so this does not underflow
            for (uint256 w = fromId >> 8; w <= wEnd; ++w) {
                uint256 bits = _wrappedBits[w];
                uint256 base = w << 8;
                while (bits != 0) {
                    uint256 lowest = bits & (~bits + 1);
                    uint256 id = base + Math.log2(lowest);
                    bits ^= lowest;
                    if (id < fromId) continue; // below the window (only possible in the first word)
                    if (id >= toId) {
                        w = WORDS;
                        break;
                    } // ids only ascend: past the window we stop both loops
                    if (_ownerOf(id) == owner) {
                        ids[k] = id;
                        unchecked {
                            ++k;
                        }
                        if (k == cap) {
                            w = WORDS;
                            break;
                        } // cannot own more than balanceOf
                    }
                }
            }
        }
        assembly ("memory-safe") {
            mstore(ids, k) // shrink the over-allocated array to the count actually found
        }
    }
}
