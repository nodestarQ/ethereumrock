// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
//       ##
//       ####          EthereumRock
//     ########
//     ########        the website
//     ########
//       ######
*/

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice ERC-8244, Contract-Hosted Application HTML. One view returning a complete self-contained
///         document, fetchable in a single eth_call. Discovery is the selector: 0x33c34ac3.
interface IContractHostedApp {
    /// @notice Returns the contract's self-contained HTML application.
    /// @return A complete UTF-8 encoded HTML document.
    function html() external view returns (string memory);
}

/// @title EthereumRockSite
/// @notice The EthereumRock frontend served on chain.
///         The page is immutable.
/// @dev The app routes on the URL fragment, so every path is this one page and `request` ignores
///      the resource path.
contract EthereumRockSite is IContractHostedApp {
    /// @dev SSTORE2 pointers holding the raw HTML bytes.
    address[] private _chunks;

    /// @notice A KeyValue pair, per EIP-5219 (used for both request params and response headers).
    struct KeyValue {
        string key;
        string value;
    }

    constructor(address[] memory chunks) {
        _chunks = chunks;
    }

    /// @notice ERC-4804 / ERC-6860 resolve mode selector. "5219" => the request() interface below.
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @notice EIP-5219 entrypoint. Returns HTTP 200 with the page and a text/html content type,
    ///         for any resource path (the SPA routes client-side via the URL fragment).
    function request(
        string[] calldata,
        KeyValue[] calldata
    )
        external
        view
        returns (
            uint256 statusCode,
            string memory body,
            KeyValue[] memory headers
        )
    {
        statusCode = 200;
        body = html();
        headers = new KeyValue[](2);
        headers[0] = KeyValue("Content-type", "text/html; charset=utf-8");
        headers[1] = KeyValue(
            "Cache-control",
            "public, max-age=31536000, immutable"
        );
    }

    /// @notice ERC-8244 requires a document to identify the contract serving it.
    /// @dev The chain id goes in for the same reason the spec's security section gives: identical
    ///      addresses on different chains hold different code, so a client has to be able to check.
    function originScript() public view returns (string memory) {
        return
            string.concat(
                '<script>window.ERC8244_ORIGIN={address:"',
                Strings.toHexString(address(this)),
                '",chainId:',
                Strings.toString(block.chainid),
                "};</script>"
            );
    }

    /// @notice ERC-8244 entrypoint.
    /// @dev The splice lands after chunk 0, and the deploy script that writes these chunks ends
    ///      chunk 0 immediately after the page's opening `<head>` tag. Any deployer of this contract
    ///      has to split the page the same way. That is the whole reason for the seam: it puts
    ///      the script inside the head, where it is valid, without the contract having to search
    ///      130KB of stored bytes for a marker. The chunks themselves stay byte-identical to the
    ///      shipped index.html, so the same file still works from IPFS or file://.
    function html() public view override returns (string memory) {
        uint256 n = _chunks.length;
        uint256[] memory sizes = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ) {
            address p = _chunks[i];
            uint256 s;
            assembly {
                s := extcodesize(p)
            }
            s = s > 0 ? s - 1 : 0; // SSTORE2 prepends a STOP byte
            sizes[i] = s;
            total += s;
            unchecked {
                ++i;
            }
        }

        bytes memory tag = bytes(originScript());
        bytes memory out = new bytes(total + tag.length);
        uint256 off;
        for (uint256 i; i < n; ) {
            address p = _chunks[i];
            uint256 s = sizes[i];
            assembly {
                extcodecopy(p, add(add(out, 0x20), off), 1, s)
            }
            off += s;
            // after the first chunk, i.e. just inside <head>
            if (i == 0) {
                for (uint256 j; j < tag.length; ) {
                    out[off + j] = tag[j];
                    unchecked {
                        ++j;
                    }
                }
                off += tag.length;
            }
            unchecked {
                ++i;
            }
        }
        return string(out);
    }

    /// @notice Number of on-chain chunks the page is stored in.
    function chunkCount() external view returns (uint256) {
        return _chunks.length;
    }

    /// @notice The SSTORE2 pointer for chunk `i` (verifiable: its bytecode is `0x00 ++ chunkBytes`).
    function chunkAt(uint256 i) external view returns (address) {
        return _chunks[i];
    }
}
