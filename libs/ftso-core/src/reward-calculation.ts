import BN from "bn.js";
import _ from "lodash";
import Web3 from "web3";
import coder from "web3-eth-abi";
import utils from "web3-utils";
import { recoverSigner } from "../../../apps/ftso-data-provider/src/utils/web3";
import { calculateFeedMedians, calculateRevealers } from "./ftso-calculation-logic";
import { EpochSettings } from "./utils/EpochSettings";
import { MerkleTree } from "./utils/MerkleTree";
import { ZERO_ADDRESS, hashRewardClaim, toBN } from "./utils/voting-utils";
import {
  Address,
  FinalizeData,
  MedianCalculationResult,
  RevealBitvoteData,
  RewardClaim,
  RewardClaimWithProof,
  RewardOffered,
  SignatureData,
  VoterRewarding,
} from "./voting-types";

/** Address to which we allocate penalised reward amounts. */
const BURN_ADDRESS = ZERO_ADDRESS;
/** 10% of total reward goes to the finalizer. */
const FINALIZATION_BIPS = toBN(1_000);
/** 10% of total reward goes to finalization signatures. */
const SIGNING_BIPS = toBN(1_000);
const TOTAL_BIPS = toBN(10_000);

const MISSED_REVEAL_PENALIZATION: BN = toBN(10);

const Web3Helper = new Web3();

export class Penalty implements RewardClaim {
  readonly isFixedClaim = true;
  constructor(
    readonly amount: BN,
    readonly currencyAddress: string,
    readonly beneficiary: string,
    readonly priceEpochId: number
  ) {}
}

/**
 * Collection of utility methods used for reward claim calculation.
 */

/**
 * @param priceEpochId
 * @param commits
 * @param reveals
 * @param previousSignatures Make sure only signatures before finalization are included.
 * @param previousFinalizeData Make sure
 * @param rewardOffers
 * @param voterWeights
 * @returns
 */
export async function calculateRewards(
  priceEpochId: number,
  commits: Map<string, string>,
  reveals: Map<string, RevealBitvoteData>,
  previousSignatures: Map<string, [SignatureData, number]>,
  previousFinalizeData: [FinalizeData, number] | undefined,
  rewardOffers: RewardOffered[],
  voterWeights: Map<string, BN>,
  epochs: EpochSettings
): Promise<RewardClaim[]> {
  const revealResult = await calculateRevealers(commits, reveals, voterWeights)!;
  if (revealResult.revealers.length === 0) {
    throw new Error(`No reveals for for price epoch: ${priceEpochId}.`);
  }

  const medianResults: MedianCalculationResult[] = await calculateFeedMedians(revealResult, voterWeights, rewardOffers);
  const committedFailedReveal = revealResult.committedFailedReveal;

  let rewardedSigners: string[] = [];

  if (previousFinalizeData !== undefined) {
    // TODO: if previous finalize happened outside the price epoch window, we should not reward signers.
    rewardedSigners = await getSignersToReward(previousFinalizeData, previousSignatures, voterWeights);
  }

  return calculateClaimsForPriceEpoch(
    rewardOffers,
    priceEpochId,
    previousFinalizeData?.[0].from,
    rewardedSigners,
    medianResults,
    committedFailedReveal,
    voterWeights,
    epochs
  );
}

/**
 * We reward signers whose signatures were recorded in blocks preceding the finalization transaction block.
 * Note that the sender of a signature transaction may not match the author of that signature. We only want
 * to reward the author (signer).
 */
async function getSignersToReward(
  finalizationData: [FinalizeData, number],
  epochSignatures: Map<string, [SignatureData, number]>,
  voterWeights: Map<string, BN>
): Promise<string[]> {
  const rewardedSigners = new Set<string>();
  const [data, finalizationTime] = finalizationData;

  for (const [signature, signatureTime] of epochSignatures.values()) {
    if (signatureTime > finalizationTime) continue; // Only reward signatures with block timestamp no greater than that of finalization
    const signer = recoverSigner(Web3Helper, data.merkleRoot, signature);
    // We check if the signer is registered for the _current_ reward epoch, the signature reward epoch might be one earlier.
    const signerWeight = voterWeights.get(signer);
    if (signerWeight && signerWeight.gt(toBN(0))) {
      rewardedSigners.add(signer);
    }
  }
  return Array.from(rewardedSigners);
}

/**
 * Calculates the claims for the given price epoch.
 *
 * Price epoch reward offers are divided into three parts:
 * - 10% for finalizer of the previous epoch: {@link finalizerAddress}.
 * - 10% for signers of the previous epoch results: {@link signers}.
 * - 80% + remainder for the median calculation results.
 *
 * During each price epoch the claims are incrementally merged into cumulative claims for the
 * reward epoch which are stored in the {@link rewardEpochCumulativeRewards} map.
 *
 * The function must be called for sequential price epochs.
 */
export function calculateClaimsForPriceEpoch(
  rewardEpochOffers: RewardOffered[],
  priceEpochId: number,
  /** Can only be undefined during for the very first price epoch in FTSO. */
  finalizerAddress: Address | undefined,
  signers: Address[],
  calculationResults: MedianCalculationResult[],
  committedFailedReveal: Address[],
  voterWeights: Map<Address, BN>,
  epochs: EpochSettings
): RewardClaim[] {
  const priceEpochOffers = rewardEpochOffers.map(offer => rewardOfferForPriceEpoch(priceEpochId, offer, epochs));

  const signingOffers: RewardOffered[] = [];
  const finalizationOffers: RewardOffered[] = [];
  const medianOffers: RewardOffered[] = [];

  const generatedClaims: RewardClaim[] = [];

  if (finalizerAddress === undefined) {
    medianOffers.push(...priceEpochOffers);
  } else {
    for (const offer of priceEpochOffers) {
      const forSigning = offer.amount.mul(FINALIZATION_BIPS).div(TOTAL_BIPS);
      const forFinalization = offer.amount.mul(SIGNING_BIPS).div(TOTAL_BIPS);
      const forMedian = offer.amount.sub(forSigning).sub(forFinalization);

      signingOffers.push({
        ...offer,
        amount: forSigning,
      } as RewardOffered);
      finalizationOffers.push({
        ...offer,
        amount: forFinalization,
      } as RewardOffered);
      medianOffers.push({
        ...offer,
        amount: forMedian,
      } as RewardOffered);
    }

    const finalizationClaims = claimsForFinalizer(finalizationOffers, finalizerAddress, priceEpochId);
    generatedClaims.push(...finalizationClaims);

    const signerClaims = claimsForSigners(signingOffers, signers, priceEpochId);
    generatedClaims.push(...signerClaims);
  }
  const resultClaims = claimsForSymbols(priceEpochId, calculationResults, medianOffers);
  generatedClaims.push(...resultClaims);

  assertOffersVsClaimsStats(priceEpochOffers, generatedClaims);

  if (committedFailedReveal.length > 0) {
    console.log(
      `Penalizing ${committedFailedReveal.length} voters for missed reveal: ${Array.from(
        committedFailedReveal.entries()
      )} `
    );
    const penalties = computePenalties(priceEpochId, committedFailedReveal, priceEpochOffers, voterWeights);
    generatedClaims.push(...penalties);
  }

  return generatedClaims;
}

export function generateProofsForClaims(allClaims: readonly RewardClaim[], mroot: string, claimer: Address) {
  const allHashes = allClaims.map(claim => hashRewardClaim(claim));
  const merkleTree = new MerkleTree(allHashes);
  if (merkleTree.root !== mroot) {
    throw new Error("Invalid Merkle root for reward claims");
  }

  const claimsWithProof: RewardClaimWithProof[] = [];
  for (let i = 0; i < allClaims.length; i++) {
    const claim = allClaims[i];
    if (claim.beneficiary.toLowerCase() === claimer.toLowerCase()) {
      claimsWithProof.push({
        merkleProof: getProof(i),
        body: claim,
      });
    }
  }

  return claimsWithProof;

  function getProof(i: number) {
    const proof = merkleTree.getProof(allHashes[i]);
    if (!proof) throw new Error(`No Merkle proof exists for claim hash ${allHashes[i]}`);
    return proof;
  }
}

/**
 * Returns customized reward offer with the share of the reward for the given price epoch.
 */
function rewardOfferForPriceEpoch(priceEpoch: number, offer: RewardOffered, epochs: EpochSettings): RewardOffered {
  const rewardEpoch = epochs.rewardEpochIdForPriceEpochId(priceEpoch);
  let reward = offer.amount.div(toBN(epochs.rewardEpochDurationInEpochs));
  const remainder = offer.amount.mod(toBN(epochs.rewardEpochDurationInEpochs)).toNumber();
  const firstPriceEpochInRewardEpoch = epochs.firstPriceEpochForRewardEpoch(rewardEpoch);
  if (priceEpoch - firstPriceEpochInRewardEpoch < remainder) {
    reward = reward.add(toBN(1));
  }
  const rewardOffer: RewardOffered = {
    ...offer,
    priceEpochId: priceEpoch,
    amount: reward,
  };
  return rewardOffer;
}

function computePenalties(
  priceEpochId: number,
  committedFailedReveal: Address[],
  priceEpochOffers: RewardOffered[],
  voterWeights: Map<Address, BN>
): Penalty[] {
  const penaltyClaims: Penalty[] = [];

  let totalWeight = toBN(0);
  for (const voterWeight of voterWeights.values()) totalWeight = totalWeight.add(voterWeight);

  for (const voter of committedFailedReveal) {
    const voterWeight = voterWeights.get(voter);
    if (voterWeight === undefined) throw new Error(`Illegal state: weight for voter ${voter} is undefined.`);

    for (const offer of priceEpochOffers) {
      const penaltyAmount = offer.amount.mul(voterWeight).div(totalWeight).mul(MISSED_REVEAL_PENALIZATION);
      const penalty = new Penalty(penaltyAmount, offer.currencyAddress, voter, priceEpochId);
      penaltyClaims.push(penalty);
    }
  }

  return penaltyClaims;
}

/**
 * Given a slotId it calculates the claims for the slot from all active pools
 */
function calculateClaimsForOffer(
  priceEpoch: number,
  offer: RewardOffered,
  calculationResult: MedianCalculationResult
): RewardClaim[] {
  // randomization for border cases
  // - a random for IQR belt is calculated from hash(priceEpochId, slotId, address)
  const voterRecords: VoterRewarding[] = [];
  // establish boundaries
  const lowIQR = calculationResult.data.quartile1Price;
  const highIQR = calculationResult.data.quartile3Price;

  // Elastic band limits
  const medianPrice = calculationResult.data.finalMedianPrice;
  const elasticBandDiff = toBN(medianPrice).mul(toBN(offer.elasticBandWidthPPM)).div(toBN(1000000));

  // NOTE: this can be negative
  const lowPCT = medianPrice - elasticBandDiff.toNumber();
  const highPCT = medianPrice + elasticBandDiff.toNumber();

  if (offer.priceEpochId !== priceEpoch) {
    throw new Error("Offer price epoch does not match the current price epoch");
  }

  // trusted provider lead
  let lowEligible = 0;
  let highEligible = 0;
  const pricesOfLeadProvidersThatVoted = [];
  if (offer.leadProviders.length > 0) {
    const leadProvidersSet = new Set<string>(offer.leadProviders.map(x => x.toLowerCase()));
    for (let i = 0; i < calculationResult.voters!.length; i++) {
      const voterAddress = calculationResult.voters![i];
      const price = calculationResult.feedValues![i];
      if (leadProvidersSet.has(voterAddress.toLowerCase())) {
        pricesOfLeadProvidersThatVoted.push(price);
      }
    }
    if (pricesOfLeadProvidersThatVoted.length > 0) {
      pricesOfLeadProvidersThatVoted.sort();
      const trustedMedianPrice = pricesOfLeadProvidersThatVoted[Math.floor(pricesOfLeadProvidersThatVoted.length / 2)];
      const eligibleRange = toBN(trustedMedianPrice).mul(toBN(offer.rewardBeltPPM)).div(toBN(1000000)).toNumber();
      lowEligible = Math.max(trustedMedianPrice - eligibleRange, 0);
      highEligible = trustedMedianPrice + eligibleRange;
    }
  }
  // assemble voter records
  for (let i = 0; i < calculationResult.voters!.length; i++) {
    const voterAddress = calculationResult.voters![i];
    const price = calculationResult.feedValues![i];
    voterRecords.push({
      voterAddress,
      weight: calculationResult.weights![i],
      originalWeight: calculationResult.weights![i],
      iqr:
        (price > lowIQR && price < highIQR) ||
        ((price === lowIQR || price === highIQR) && randomSelect(offer.name, priceEpoch, voterAddress)),
      pct: price > lowPCT && price < highPCT,
      eligible: pricesOfLeadProvidersThatVoted.length === 0 ? true : price >= lowEligible && price <= highEligible,
    } as VoterRewarding);
  }
  // Sort by voters' addresses since results have to be in the canonical order
  voterRecords.sort((a, b) => {
    if (a.voterAddress < b.voterAddress) {
      return -1;
    } else if (a.voterAddress > b.voterAddress) {
      return 1;
    }
    return 0;
  });

  // calculate iqr and pct sums
  let iqrSum: BN = toBN(0);
  let pctSum: BN = toBN(0);
  for (const voterRecord of voterRecords) {
    if (!voterRecord.eligible) {
      continue;
    }
    if (voterRecord.iqr) {
      iqrSum = iqrSum.add(voterRecord.weight);
    }
    if (voterRecord.pct) {
      pctSum = pctSum.add(voterRecord.weight);
    }
  }

  // calculate total rewarded weight
  let totalRewardedWeight = toBN(0);
  for (const voterRecord of voterRecords) {
    if (!voterRecord.eligible) {
      voterRecord.weight = toBN(0);
      continue;
    }
    let newWeight = toBN(0);
    if (pctSum.eq(toBN(0))) {
      if (voterRecord.iqr) {
        newWeight = voterRecord.weight;
      }
    } else {
      if (voterRecord.iqr) {
        newWeight = newWeight.add(offer.iqrSharePPM.mul(voterRecord.weight).mul(pctSum));
      }
      if (voterRecord.pct) {
        newWeight = newWeight.add(offer.pctSharePPM.mul(voterRecord.weight).mul(iqrSum));
      }
    }
    voterRecord.weight = newWeight;
    totalRewardedWeight = totalRewardedWeight.add(newWeight);
  }

  if (totalRewardedWeight.eq(toBN(0))) {
    // claim back to reward issuer
    const backClaim: RewardClaim = {
      isFixedClaim: true,
      amount: offer.amount,
      currencyAddress: offer.currencyAddress,
      beneficiary: offer.remainderClaimer.toLowerCase(),
      priceEpochId: priceEpoch,
    };
    return [backClaim];
  }

  const rewardClaims: RewardClaim[] = [];
  let totalReward = toBN(0);
  let availableReward = offer.amount;
  let availableWeight = totalRewardedWeight;

  for (const voterRecord of voterRecords) {
    // double declining balance
    if (voterRecord.weight.eq(toBN(0))) {
      continue;
    }
    const reward = voterRecord.weight.mul(availableReward).div(availableWeight);
    availableReward = availableReward.sub(reward);
    availableWeight = availableWeight.sub(voterRecord.weight);

    totalReward = totalReward.add(reward);
    const rewardClaim: RewardClaim = {
      isFixedClaim: false,
      amount: reward,
      currencyAddress: offer.currencyAddress,
      beneficiary: voterRecord.voterAddress, // it is already lowercased
      priceEpochId: priceEpoch,
    };
    rewardClaims.push(rewardClaim);
  }
  // Assert
  if (!totalReward.eq(offer.amount)) {
    throw new Error(`Total reward for ${offer.currencyAddress} is not equal to the offer amount`);
  }

  return rewardClaims;
}

/**
 * Merges claims for the same beneficiary, currency and type in the provided {@link unmergedClaims} list.
 * Applies penalties if there are any. All penalised reward amounts are allocated to the {@link BURN_ADDRESS}
 * in the form of new reward claims.
 */
export function mergeClaims(mergePriceEpochId: number, unmergedClaims: readonly RewardClaim[]): RewardClaim[] {
  function mergeClaimsOfSameType(claims: RewardClaim[]): RewardClaim | undefined {
    if (claims.length === 0) return undefined;
    const merged: RewardClaim = {
      ...claims[0],
      amount: claims.map(x => x.amount).reduce((a, b) => a.add(b), toBN(0)),
      priceEpochId: mergePriceEpochId,
    };
    return merged;
  }

  const claimsByVoterAndCcy = new Map<Address, Map<string, RewardClaim[]>>();
  for (const claim of unmergedClaims) {
    const voterClaimsByCcy = claimsByVoterAndCcy.get(claim.beneficiary) || new Map<string, RewardClaim[]>();
    claimsByVoterAndCcy.set(claim.beneficiary, voterClaimsByCcy);
    const claimsList = voterClaimsByCcy.get(claim.currencyAddress) || [];
    voterClaimsByCcy.set(claim.currencyAddress, claimsList);
    claimsList.push(claim);
  }

  const mergedClaims: RewardClaim[] = [];
  const newBurnClaims: RewardClaim[] = [];

  for (const voterClaimsByCcy of claimsByVoterAndCcy.values()) {
    for (const voterClaims of voterClaimsByCcy.values()) {
      const [penalties, claims] = _.partition(voterClaims, claim => claim instanceof Penalty);
      const [fixedClaims, weightedClaims] = _.partition(claims, claim => claim.isFixedClaim === true);

      let mergedFixed = mergeClaimsOfSameType(fixedClaims);
      let mergedWeighted = mergeClaimsOfSameType(weightedClaims);
      let mergedPenalty = mergeClaimsOfSameType(penalties);

      if (mergedPenalty) {
        let remPenalty: RewardClaim | undefined = mergedPenalty;

        if (mergedFixed) {
          [mergedFixed, remPenalty] = applyPenalty(remPenalty, mergedPenalty);
        }
        if (remPenalty && mergedWeighted) {
          [mergedWeighted, remPenalty] = applyPenalty(mergedWeighted, remPenalty);
        }

        let burntAmount = mergedPenalty.amount;
        if (remPenalty) {
          burntAmount = burntAmount.sub(remPenalty.amount);
        }
        const burnClaim: RewardClaim = {
          ...mergedPenalty,
          isFixedClaim: true,
          amount: burntAmount,
          beneficiary: BURN_ADDRESS,
        };
        newBurnClaims.push(burnClaim);
        mergedPenalty = remPenalty;
      }

      if (mergedFixed) mergedClaims.push(mergedFixed);
      if (mergedWeighted) mergedClaims.push(mergedWeighted);
      if (mergedPenalty) mergedClaims.push(mergedPenalty);
    }
  }

  // We now have merged claims for all voters and burn address, and need to merge in newly generated burn claims.
  const [previousBurnClaims, mergedVoterClaims] = _.partition(
    mergedClaims,
    claim => claim.beneficiary === BURN_ADDRESS
  );
  const mergedBurnClaim = mergeClaimsOfSameType(previousBurnClaims.concat(newBurnClaims));

  if (mergedBurnClaim) {
    return mergedVoterClaims.concat([mergedBurnClaim]);
  } else return mergedVoterClaims;
}

function applyPenalty(claim: RewardClaim, penalty: RewardClaim): [RewardClaim | undefined, RewardClaim | undefined] {
  let penaltyAmountLeft: BN;
  let claimAmountLeft: BN;

  if (claim.amount.gte(penalty.amount)) {
    claimAmountLeft = claim.amount.sub(penalty.amount);
    penaltyAmountLeft = toBN(0);
  } else {
    claimAmountLeft = toBN(0);
    penaltyAmountLeft = penalty.amount.sub(claim.amount);
  }

  let resultClaim: RewardClaim | undefined;
  if (claimAmountLeft.gtn(0)) {
    resultClaim = {
      ...claim,
      amount: claimAmountLeft,
    };
  } else {
    resultClaim = undefined;
  }

  let resultPenalty: RewardClaim | undefined;
  if (penaltyAmountLeft.gtn(0)) {
    resultPenalty = {
      ...penalty,
      amount: penaltyAmountLeft,
    };
  } else resultPenalty = undefined;

  return [resultClaim, resultPenalty];
}

/**
 * Calculates claims for all slots in the price epoch.
 */
function claimsForSymbols(
  priceEpoch: number,
  calculationResults: MedianCalculationResult[],
  offers: RewardOffered[]
): RewardClaim[] {
  const offersBySymbol = getOffersBySymbol(offers);

  const claims: RewardClaim[] = [];
  for (const calculationResult of calculationResults) {
    const offersForSymbol = offersBySymbol.get(calculationResult.feed.name)!;
    for (const offer of offersForSymbol) {
      claims.push(...calculateClaimsForOffer(priceEpoch, offer, calculationResult));
    }
  }
  return claims;
}

function getOffersBySymbol(offers: RewardOffered[]) {
  const offersBySymbol = new Map<string, RewardOffered[]>();
  for (const offer of offers) {
    const offerFeedId = offer.name;
    const existing = offersBySymbol.get(offerFeedId) || [];
    existing.push(offer);
    offersBySymbol.set(offerFeedId, existing);
  }
  return offersBySymbol;
}

/**
 * Produces a map from currencyAddress to total reward amount for all claims
 */
function claimRewardsMap(claims: RewardClaim[]) {
  const currencyAddressToTotalReward = new Map<string, BN>();
  for (const claim of claims) {
    const amount = currencyAddressToTotalReward.get(claim.currencyAddress) || toBN(0);
    currencyAddressToTotalReward.set(claim.currencyAddress, amount.add(claim.amount));
  }
  return currencyAddressToTotalReward;
}

/**
 * Asserts that the sum of all offers is equal to the sum of all claims, for each currencyAddress
 */
function assertOffersVsClaimsStats(offers: RewardOffered[], claims: RewardClaim[]) {
  const offersRewards = new Map<string, BN>();

  for (const offer of offers) {
    const amount = offersRewards.get(offer.currencyAddress) || toBN(0);
    offersRewards.set(offer.currencyAddress, amount.add(offer.amount));
  }
  const claimsRewards = claimRewardsMap(claims);
  if (offersRewards.size !== claimsRewards.size) {
    throw new Error("offersMap.size !== claimsMap.size");
  }
  for (const currencyAddress of offersRewards.keys()) {
    const offerAmount = offersRewards.get(currencyAddress)!;
    const claimAmount = claimsRewards.get(currencyAddress)!;
    if (!offerAmount.eq(claimAmount)) {
      throw new Error(`offerAmount ${offerAmount} != claimAmount ${claimAmount} for ${currencyAddress}`);
    }
  }
}

/**
 * Generates reward claims for the party that submitted the finalization transaction in the previous price epoch.
 */
function claimsForFinalizer(finalizationOffers: RewardOffered[], finalizerAddress: Address, priceEpochId: number) {
  const claims: RewardClaim[] = [];
  for (const offer of finalizationOffers) {
    const claim: RewardClaim = {
      isFixedClaim: true,
      amount: offer.amount,
      currencyAddress: offer.currencyAddress,
      beneficiary: finalizerAddress.toLowerCase(),
      priceEpochId: priceEpochId,
    };
    claims.push(claim);
  }
  return claims;
}

/**
 * Generates reward claims for voters whose signatures were included the the previous epoch's finalization transaction.
 */
function claimsForSigners(signingOffers: RewardOffered[], signers: Address[], priceEpochId: number): RewardClaim[] {
  if (signers.length == 0) {
    return generateBackClaims(signingOffers, priceEpochId);
  }
  const signingClaims = [];
  for (const offer of signingOffers) {
    const rewardShare = offer.amount.div(toBN(signers.length));
    for (let i = 0; i < signers.length; i++) {
      let reward = rewardShare;
      if (i === 0) {
        reward = reward.add(offer.amount.mod(toBN(signers.length)));
      }
      const claim: RewardClaim = {
        isFixedClaim: true,
        amount: reward,
        currencyAddress: offer.currencyAddress,
        beneficiary: signers[i].toLowerCase(),
        priceEpochId: priceEpochId,
      };
      signingClaims.push(claim);
    }
  }
  return signingClaims;
}

function generateBackClaims(signingOffers: RewardOffered[], priceEpochId: number): RewardClaim[] {
  const backClaims: RewardClaim[] = [];
  for (const offer of signingOffers) {
    const backClaim: RewardClaim = {
      isFixedClaim: true,
      amount: offer.amount,
      currencyAddress: offer.currencyAddress,
      beneficiary: offer.remainderClaimer.toLowerCase(),
      priceEpochId: priceEpochId,
    };
    backClaims.push(backClaim);
  }
  return backClaims;
}

/**
 * Pseudo random selection based on the hash of (slotId, priceEpoch, voterAddress).
 * Used to get deterministic randomization for border cases of IQR belt.
 */
function randomSelect(symbol: string, priceEpoch: number, voterAddress: Address) {
  return toBN(
    utils.soliditySha3(coder.encodeParameters(["bytes8", "uint256", "address"], [symbol, priceEpoch, voterAddress]))!
  )
    .mod(toBN(2))
    .eq(toBN(1));
}
