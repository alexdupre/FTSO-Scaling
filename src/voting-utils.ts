import BN from "bn.js";
import Web3 from "web3";
import { toBN } from "../test-utils/utils/test-helpers";
import { ClaimReward, Feed, RewardOffered } from "./voting-interfaces";

export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A sorted hash of two 32-byte strings
 * @param x first `0x`-prefixed 32-byte hex string
 * @param y second `0x`-prefixed 32-byte hex string
 * @returns the sorted hash
 */
export function sortedHashPair(x: string, y: string) {
  if (x <= y) {
    return web3.utils.soliditySha3(web3.eth.abi.encodeParameters(["bytes32", "bytes32"], [x, y]));
  }
  return web3.utils.soliditySha3(web3.eth.abi.encodeParameters(["bytes32", "bytes32"], [y, x]));
}

/**
 * Hashing ClaimReward struct.
 * @param data 
 * @param abi 
 * @returns 
 */
export function hashClaimReward(data: ClaimReward, abi: any): string {
  return web3.utils.soliditySha3(web3.eth.abi.encodeParameter(abi, hexlifyBN(data.claimRewardBody)))!;
}

/**
 * Converts text representation of a symbol to bytes4.
 * @param text 
 * @returns 
 */
export function toBytes4(text: string) {
  if (!text || text.length === 0) {
    throw new Error(`Text should be non-null and non-empty`);
  }
  if (/^0x[0-9a-f]{8}$/i.test(text)) {
    return text; // no conversion needed
  }
  if (text.length > 4) {
    throw new Error(`Text should be at most 4 characters long`);
  }
  return web3.utils.padRight(web3.utils.asciiToHex(text), 8);
}

/**
 * Converts bytes4 representation of a symbol to text.
 * @param bytes4 
 * @returns 
 */
export function bytes4ToText(bytes4: string) {
  if (!bytes4 || bytes4.length === 0) {
    throw new Error(`Bytes4 should be non-null and non-empty`);
  }
  if (!/^0x[0-9a-f]{8}$/i.test(bytes4)) {
    throw new Error(`Bytes4 should be a 4-byte hex string`);
  }
  return web3.utils.hexToAscii(bytes4).replace(/\u0000/g, '');
}

/**
 * Converts feed symbols withing the Feed from text to bytes.
 * @param feed 
 * @returns 
 */
export function feedToBytes4(feed: Feed): Feed {
  return {
    offerSymbol: toBytes4(feed.offerSymbol),
    quoteSymbol: toBytes4(feed.quoteSymbol),
  } as Feed;
}

export function unprefixedSymbolBytes(feed: Feed) {
  return `${toBytes4(feed.offerSymbol).slice(2)}${toBytes4(feed.quoteSymbol).slice(2)}`;
}

/**
 * Converts feed symbols withing the Feed from bytes to text.
 * @param feed 
 * @returns 
 */
export function feedToText(feed: Feed): Feed {
  return {
    ...feed,
    offerSymbol: bytes4ToText(feed.offerSymbol),
    quoteSymbol: bytes4ToText(feed.quoteSymbol),
  } as Feed;
}

/**
 * Removes annoying index fields from an object.
 * @param obj 
 * @returns 
 */
export function removeIndexFields<T>(obj: T): T {
  return Object.keys(obj as any)
    .filter((key) => !key!.match(/^[0-9]+$/))
    .reduce((result: any, key: string) => {
      return Object.assign(result, {
        [key]: (obj as any)[key]
      });
    }, {}) as T;
}

/**
 * Converts an offer from web3 response to a more usable format, matching
 * the Offer interface.
 * @param offer 
 * @returns 
 */
export function convertRewardOfferedEvent(offer: any): RewardOffered {
  let newOffer = removeIndexFields(offer);
  delete newOffer.__length__;
  newOffer.leadProviders = [...offer.leadProviders];
  let tmp = newOffer as RewardOffered;
  tmp.offerSymbol = bytes4ToText(tmp.offerSymbol),
  tmp.quoteSymbol = bytes4ToText(tmp.quoteSymbol),
  tmp.amount = toBN(tmp.amount);
  tmp.flrValue = toBN(tmp.flrValue);
  tmp.rewardBeltPPM = toBN(tmp.rewardBeltPPM);
  tmp.elasticBandWidthPPM = toBN(tmp.elasticBandWidthPPM);
  tmp.iqrSharePPM = toBN(tmp.iqrSharePPM);
  tmp.pctSharePPM = toBN(tmp.pctSharePPM);
  return tmp;
}

/**
 * Id of a feed is a string of the form `offerSymbol-quoteSymbol`.
 * @param feed 
 * @returns 
 */
export function feedId(feed: Feed) {
  return `${feed.offerSymbol}-${feed.quoteSymbol}`;
}


/**
 * Prefixes hex string with `0x` if the string is not yet prefixed.
 * It can handle also negative values.
 * @param tx input hex string with or without `0x` prefix
 * @returns `0x` prefixed hex string.
 */
export function prefix0xSigned(tx: string) {
  if (tx.startsWith("0x") || tx.startsWith("-0x")) {
    return tx;
  }
  if (tx.startsWith("-")) {
    return "-0x" + tx.slice(1);
  }
  return "0x" + tx;
}

/**
 * Converts objects to Hex value (optionally left padded)
 * @param x input object
 * @param padToBytes places to (left) pad to (optional)
 * @returns (padded) hex valu
 */
export function toHex(x: string | number | BN, padToBytes?: number) {
  if ((padToBytes as any) > 0) {
    return Web3.utils.leftPad(Web3.utils.toHex(x), padToBytes! * 2);
  }
  return Web3.utils.toHex(x);
}

/**
 * Converts fields of an object to Hex values
 * Note: negative values are hexlified with '-0x'.
 * This is compatible with web3.eth.encodeParameters
 * @param obj input object
 * @returns object with matching fields to input object but instead having various number types (number, BN)
 * converted to hex values ('0x'-prefixed).
 */
export function hexlifyBN(obj: any): any {
  const isHexReqex = /^[0-9A-Fa-f]+$/;
  if (BN.isBN(obj)) {
    return prefix0xSigned(toHex(obj));
  }
  if (Array.isArray(obj)) {
    return (obj as any[]).map((item) => hexlifyBN(item));
  }
  if (typeof obj === "object") {
    const res = {} as any;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      res[key] = hexlifyBN(value);
    }
    return res;
  }
  if (typeof obj === "string" && obj.match(isHexReqex)) {
    return prefix0xSigned(obj);
  }
  return obj;
}