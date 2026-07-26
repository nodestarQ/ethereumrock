// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
//       ##
//       ####          EthereumRock
//     ########
//     ########        Rock art render
//     ########
//       ######
//
// Art is CC0, do with it what you want! :D
*/

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title EthereumRockRenderer
/// @notice Builds the SVG and returns the whole tokenURI as a base64 JSON data URI.
/// @dev EthereumRock pins this address at deploy and has no setter, so the art can never be swapped. Yippie!
contract EthereumRockRenderer {
    using Strings for uint256;

    string internal constant BASE_PATH = "M3 1H4V2H5V3H6V7H3V6H2V3H3Z";
    string internal constant BACKGROUND =
        '<rect width="8" height="8" fill="#efeee9"/>';
    string internal constant DETAIL =
        '<path fill="#000" fill-opacity="0.90" d="M3 1H4V2H3ZM3 6H4V7H3Z"/>'
        '<path fill="#fff" fill-opacity="0.25" d="M4 2H5V3H4Z"/>'
        '<path fill="#000" fill-opacity="0.50" d="M2 3H3V5H2ZM5 6H6V7H5Z"/>'
        '<path fill="#000" fill-opacity="0.25" d="M5 4H6V6H5Z"/>'
        '<path fill="#000" fill-opacity="0.75" d="M2 5H3V6H2ZM4 6H5V7H4Z"/>';

    /// @notice Full tokenURI: base64(JSON) with an inline base64(SVG) image.
    function render(
        uint256 id,
        bytes32 seed,
        uint256 mass,
        uint256 dust
    ) external pure returns (string memory) {
        return
            string.concat(
                "data:application/json;base64,",
                Base64.encode(bytes(_json(id, seed, mass, dust)))
            );
    }

    function _json(
        uint256 id,
        bytes32 seed,
        uint256 mass,
        uint256 dust
    ) internal pure returns (string memory) {
        return
            string.concat(
                '{"name":"EthereumRock #',
                id.toString(),
                '","description":"The very first Rock NFT collectible. Created December 25th, 2017. '
                "This is the historic original EtherRock contract, now wrapped into an ownerless, "
                'immutable and credibly neutral ERC-721.",',
                '"attributes":',
                _attributes(id, seed, mass, dust),
                ',"image":"data:image/svg+xml;base64,',
                _image64(id, seed),
                '"}'
            );
    }

    function _attributes(
        uint256 id,
        bytes32 seed,
        uint256 mass,
        uint256 dust
    ) internal pure returns (string memory) {
        return
            string.concat(
                "[",
                _traitsA(id, mass, dust),
                ",",
                _traitsB(id, seed),
                "]"
            );
    }

    function _traitsA(
        uint256 id,
        uint256 mass,
        uint256 dust
    ) internal pure returns (string memory) {
        return
            string.concat(
                _num("Id", id),
                ',{"trait_type":"Status","value":"',
                id < 100 ? "DEFINED" : "UNDEFINED",
                '"},',
                _num("Mass", mass),
                ",",
                _num("Dust", dust)
            );
    }

    function _traitsB(
        uint256 id,
        bytes32 seed
    ) internal pure returns (string memory) {
        (uint256 h, , ) = _color(seed);
        return
            string.concat(
                '{"trait_type":"Color","value":"',
                _hex(seed),
                '"},',
                _num("Hue", h),
                ",",
                _num("Size", _sizePct(id, seed))
            );
    }

    /// @dev The rock's fill color as a #rrggbb hex string, converted on-chain from its HSL.
    function _hex(bytes32 seed) internal pure returns (string memory) {
        (uint256 h, uint256 s, uint256 l) = _color(seed);
        (uint256 r, uint256 g, uint256 b) = _hslToRgb(h, s, l);
        return string.concat("#", _byte(r), _byte(g), _byte(b));
    }

    /// @dev Integer HSL -> RGB (h in [0,360), s and l in [0,100]). Channels clamped to 0..255.
    function _hslToRgb(
        uint256 h,
        uint256 s,
        uint256 l
    ) internal pure returns (uint256, uint256, uint256) {
        int256 c = ((100 - _absI(2 * int256(l) - 100)) * int256(s)) / 100;
        int256 x = (c * (100 - _absI((((int256(h) * 100) / 60) % 200) - 100))) /
            100;
        int256 m = int256(l) - c / 2;
        uint256 sector = h / 60;
        if (sector == 0) return (_to255(c + m), _to255(x + m), _to255(m));
        if (sector == 1) return (_to255(x + m), _to255(c + m), _to255(m));
        if (sector == 2) return (_to255(m), _to255(c + m), _to255(x + m));
        if (sector == 3) return (_to255(m), _to255(x + m), _to255(c + m));
        if (sector == 4) return (_to255(x + m), _to255(m), _to255(c + m));
        return (_to255(c + m), _to255(m), _to255(x + m));
    }

    function _to255(int256 v) internal pure returns (uint256) {
        int256 r = (v * 255) / 100;
        if (r < 0) return 0;
        if (r > 255) return 255;
        return uint256(r);
    }

    function _absI(int256 v) internal pure returns (int256) {
        return v < 0 ? -v : v;
    }

    function _byte(uint256 v) internal pure returns (string memory) {
        bytes memory d = "0123456789abcdef";
        bytes memory out = new bytes(2);
        out[0] = d[(v >> 4) & 0xf];
        out[1] = d[v & 0xf];
        return string(out);
    }

    /// @dev Numeric (display_type) trait, so marketplaces expose it as a filterable range rather
    ///      than a per-value chip. Hue and Size are the traits that vary most across rocks.
    function _num(
        string memory name,
        uint256 v
    ) internal pure returns (string memory) {
        return
            string.concat(
                '{"display_type":"number","trait_type":"',
                name,
                '","value":',
                v.toString(),
                "}"
            );
    }

    function _image64(
        uint256 id,
        bytes32 seed
    ) internal pure returns (string memory) {
        return Base64.encode(bytes(_svg(id, seed)));
    }

    function _svg(
        uint256 id,
        bytes32 seed
    ) internal pure returns (string memory) {
        return
            string.concat(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">',
                BACKGROUND,
                '<g transform="translate(4 4) scale(',
                _scale(_sizePct(id, seed)),
                ') translate(-4 -4)"><path fill="',
                _fill(seed),
                '" d="',
                BASE_PATH,
                '"/>',
                DETAIL,
                "</g></svg>"
            );
    }

    function _fill(bytes32 seed) internal pure returns (string memory) {
        (uint256 h, uint256 s, uint256 l) = _color(seed);
        return
            string.concat(
                "hsl(",
                h.toString(),
                ",",
                s.toString(),
                "%,",
                l.toString(),
                "%)"
            );
    }

    /// @dev ~70% "stone" (warm hue, low-moderate saturation, wide lightness: greys, browns, tans,
    ///      beiges) and ~30% "mineral" (vivid, any hue).
    function _color(
        bytes32 seed
    ) internal pure returns (uint256 h, uint256 s, uint256 l) {
        uint256 v = uint256(seed);
        if ((v >> 8) % 100 < 70) {
            h = 18 + (v % 40); // 18..57 (warm)
            s = (v >> 40) % 45; // 0..44
            l = 32 + ((v >> 64) % 50); // 32..81
        } else {
            h = (v >> 96) % 360;
            s = 55 + ((v >> 120) % 30); // 55..84
            l = 46 + ((v >> 136) % 16); // 46..61
        }
    }

    /// @return size percentage: 100 for the 0-99, else a number between 67..90.
    function _sizePct(
        uint256 id,
        bytes32 seed
    ) internal pure returns (uint256) {
        if (id < 100) return 100;
        return 67 + ((uint256(seed) >> 160) % 24);
    }

    function _scale(uint256 p) internal pure returns (string memory) {
        if (p >= 100) return "1";
        return string.concat("0.", p.toString()); // p is 67..90, always two digits
    }
}
