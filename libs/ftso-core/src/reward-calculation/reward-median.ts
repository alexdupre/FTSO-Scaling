import coder from "web3-eth-abi";
import utils from "web3-utils";
import { VoterWeights } from "../RewardEpoch";
import { IPartialRewardOffer } from "../utils/PartialRewardOffer";
import { ClaimType, IPartialRewardClaim } from "../utils/RewardClaim";
import { Address, MedianCalculationResult } from "../voting-types";
import { TOTAL_BIPS, TOTAL_PPM } from "./reward-constants";
import { rewardDistributionWeight } from "./reward-utils";

/**
 * Given a partial reward offer, median calculation result for a specific feed and voter weights it calculates the median closeness partial
 * reward claims for the offer for all voters (with non-zero reward). For each voter all relevant partial claims are generated (including fees, participation rewards, etc).
 */
export function calculateMedianRewardClaims(
  offer: IPartialRewardOffer,
  calculationResult: MedianCalculationResult,
  voterWeights: Map<Address, VoterWeights>
): IPartialRewardClaim[] {
  interface VoterRewarding {
    readonly voterAddress: string;
    weight: bigint;
    readonly originalWeight: bigint;
    readonly pct: boolean; // gets PCT reward
    readonly iqr: boolean; // gets IQR reward
    readonly eligible: boolean; // is eligible for reward
  }

  if (offer.votingRoundId === undefined) {
    throw new Error("Offer price epoch does not match the current price epoch");
  }
  const votingRoundId = offer.votingRoundId;
  if (calculationResult.votingRoundId !== votingRoundId) {
    throw new Error("Calculation result voting round id does not match the offer voting round id");
  }

  // Randomization for border cases
  // - a random for IQR belt is calculated from hash(priceEpochId, slotId, address)
  function randomSelect(feedName: string, votingRoundId: number, voterAddress: Address): boolean {
    return (
      BigInt(
        utils.soliditySha3(
          coder.encodeParameters(["bytes8", "uint256", "address"], [feedName, votingRoundId, voterAddress])
        )!
      ) %
        2n ===
      1n
    );
  }

  if (calculationResult.data.finalMedianPrice.isEmpty) {
    return [];
  }
  // Use bigint for proper integer division
  const medianPrice = BigInt(calculationResult.data.finalMedianPrice.value);

  // establish boundaries
  if (calculationResult.data.quartile1Price.isEmpty || calculationResult.data.quartile3Price.isEmpty) {
    throw new Error("Critical error: quartile prices are not available. This should never happen.");
  }
  const lowIQR = BigInt(calculationResult.data.quartile1Price.value);
  const highIQR = BigInt(calculationResult.data.quartile3Price.value);

  const voterRecords: VoterRewarding[] = [];

  const elasticBandDiff = (medianPrice * BigInt(offer.secondaryBandWidthPPM)) / TOTAL_PPM;

  const lowPCT = medianPrice - elasticBandDiff;
  const highPCT = medianPrice + elasticBandDiff;

  // assemble voter records
  for (let i = 0; i < calculationResult.voters!.length; i++) {
    const voterAddress = calculationResult.voters![i];
    const feedValue = calculationResult.feedValues![i];
    if (feedValue.isEmpty) {
      continue;
    }
    const value = BigInt(feedValue.value);
    const record: VoterRewarding = {
      voterAddress,
      weight: rewardDistributionWeight(voterWeights.get(voterAddress)!),
      originalWeight: calculationResult.weights![i],
      iqr:
        (value > lowIQR && value < highIQR) ||
        ((value === lowIQR || value === highIQR) && randomSelect(offer.feedName, votingRoundId, voterAddress)),
      pct: value > lowPCT && value < highPCT,
      eligible: true,
    };
    voterRecords.push(record);
  }

  // calculate iqr and pct sums
  let iqrSum = 0n;
  let pctSum: 0n;
  for (const voterRecord of voterRecords) {
    if (!voterRecord.eligible) {
      continue;
    }
    if (voterRecord.iqr) {
      iqrSum += voterRecord.weight;
    }
    if (voterRecord.pct) {
      pctSum += voterRecord.weight;
    }
  }

  // calculate total rewarded weight
  let totalRewardedWeight = 0n;
  for (const voterRecord of voterRecords) {
    if (!voterRecord.eligible) {
      voterRecord.weight = 0n;
      continue;
    }
    let newWeight = 0n;
    if (pctSum === 0n) {
      if (voterRecord.iqr) {
        newWeight = voterRecord.weight;
      }
    } else {
      if (voterRecord.iqr) {
        newWeight += BigInt(offer.primaryBandRewardSharePPM) * voterRecord.weight * pctSum;
      }
      if (voterRecord.pct) {
        newWeight += BigInt(offer.secondaryBandWidthPPM) * voterRecord.weight * iqrSum;
      }
    }
    voterRecord.weight = newWeight;
    totalRewardedWeight += newWeight;
  }

  if (totalRewardedWeight === 0n) {
    // claim back to reward issuer
    const backClaim: IPartialRewardClaim = {
      beneficiary: offer.claimBackAddress.toLowerCase(),
      amount: offer.amount,
      claimType: ClaimType.DIRECT,
    };
    return [backClaim];
  }

  const rewardClaims: IPartialRewardClaim[] = [];
  let totalReward = 0n;
  let availableReward = offer.amount;
  let availableWeight = totalRewardedWeight;

  for (const voterRecord of voterRecords) {
    // double declining balance
    if (voterRecord.weight === 0n) {
      continue;
    }
    const reward = (voterRecord.weight * availableReward) / availableWeight;
    availableReward = availableReward - reward;
    availableWeight = availableWeight - voterRecord.weight;

    totalReward += reward;

    const rewardClaims = generateMedianRewardClaimsForVoter(reward, voterWeights.get(voterRecord.voterAddress)!);
    rewardClaims.push(...rewardClaims);
  }
  // Assert
  if (totalReward !== offer.amount) {
    throw new Error(`Total reward for ${offer.feedName} is not equal to the offer amount`);
  }

  return rewardClaims;
}

/**
 * Given assigned reward it generates reward claims for the voter.
 * Currently only a partial fee claim and capped wnat delegation participation weight claims are created.
 */
export function generateMedianRewardClaimsForVoter(reward: bigint, voterWeights: VoterWeights) {
  const result: IPartialRewardClaim[] = [];
  const fee = (reward * BigInt(voterWeights.feeBIPS)) / TOTAL_BIPS;
  const participationReward = reward - fee;
  const feeClaim: IPartialRewardClaim = {
    beneficiary: voterWeights.delegationAddress.toLowerCase(),
    amount: reward,
    claimType: ClaimType.WNAT,
  };
  result.push(feeClaim);
  const rewardClaim: IPartialRewardClaim = {
    beneficiary: voterWeights.delegationAddress.toLowerCase(),
    amount: participationReward,
    claimType: ClaimType.WNAT,
  };
  result.push(rewardClaim);
  return result;
}
