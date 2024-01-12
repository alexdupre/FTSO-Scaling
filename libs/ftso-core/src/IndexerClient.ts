import { EpochSettings } from "./utils/EpochSettings";
import {
  Address,
  FinalizeData,
  PriceEpochId,
  RevealData,
  RewardEpochId,
  RewardOffered,
  SignatureData,
  TxData,
} from "./voting-types";
import EncodingUtils, { SigningPolicy, VoterRegistered } from "./utils/EncodingUtils";
import { Between, EntityManager, MoreThan } from "typeorm";
import { TLPEvents, TLPState, TLPTransaction } from "./orm/entities";
import { ZERO_ADDRESS, toBN, toBytes4 } from "./utils/voting-utils";

import BN from "bn.js";
import Web3 from "web3";

declare type CommitHash = string;
declare type Timestamp = number;

const REWARD_VALUE = 10_000;
const IQR_SHARE = 700_000;
const PCT_SHARE = 300_000;
const ELASTIC_BAND_WIDTH_PPM = 50_000;
const DEFAULT_REWARD_BELT_PPM = 500_000;
class DBCache {
  readonly priceEpochCommits = new Map<PriceEpochId, Map<Address, CommitHash>>();
  readonly priceEpochReveals = new Map<PriceEpochId, Map<Address, RevealData>>();
  readonly priceEpochSignatures = new Map<PriceEpochId, Map<Address, [SignatureData, Timestamp]>>();
  readonly priceEpochFinalizes = new Map<PriceEpochId, [FinalizeData, Timestamp]>();
  readonly rewardSignatures = new Map<RewardEpochId, Map<Address, [SignatureData, Timestamp]>>();
  readonly rewardFinalizes = new Map<RewardEpochId, [FinalizeData, Timestamp]>();
  readonly rewardEpochOffers = new Map<RewardEpochId, RewardOffered[]>();
}

function toTxData(tx: TLPTransaction): TxData {
  const txData: TxData = {
    hash: tx.hash,
    input: "0x" + tx.input,
    from: "0x" + tx.from_address,
    to: "0x" + tx.to_address,
    blockNumber: tx.block_number,
    status: tx.status == 1,
  };
  return txData;
}

export class IndexerClient {
  private readonly cache = new DBCache();

  protected readonly encodingUtils = () => EncodingUtils.instance;
  readonly signingPolicyTopic = this.encodingUtils().eventSignature("SigningPolicyInitialized").slice(2);
  readonly voterRegisteredTopic = this.encodingUtils().eventSignature("VoterRegistered").slice(2);

  constructor(private readonly entityManager: EntityManager, protected readonly epochs: EpochSettings) {}

  async getMaxTimestamp(): Promise<number> {
    const state = await this.entityManager.getRepository(TLPState).findOneBy({ id: 3 });
    return state!.block_timestamp;
  }

  commitSelector = Web3.utils.sha3("submit1()")!.slice(2, 10);
  revealSelector = Web3.utils.sha3("submit2()")!.slice(2, 10);

  async queryCommits(priceEpochId: PriceEpochId): Promise<Map<Address, CommitHash>> {
    const start = this.epochs.votingEpochStartMs(priceEpochId);
    const nextStart = this.epochs.votingEpochStartMs(priceEpochId + 1);

    const max = await this.getMaxTimestamp();
    console.log(`Max timestamp ${max}`);
    // if (max < nextStart) {
    //   throw new Error(`Incomplete commit picture for current price epoch: ${max} < ${nextStart}}`);
    // }

    console.log(
      `Start: ${new Date(start).toISOString()}, nextStart: ${new Date(
        nextStart
      ).toISOString()}, in sec: start: ${start}, nextStart: ${nextStart}`
    );
    console.log("Commit selector: ", this.commitSelector);
    const txns: TLPTransaction[] = await this.entityManager.getRepository(TLPTransaction).find({
      where: {
        function_sig: this.commitSelector,
        timestamp: Between(start / 1000, nextStart / 1000 - 1),
      },
    });

    const epochCommits = new Map<Address, CommitHash>();
    for (const tx of txns) {
      const extractedCommit = this.encodingUtils().extractCommitHash(tx.input);
      console.log(`Got commit response ${tx.from_address} - ${extractedCommit}`);
      const signingAddress = await this.getSigningAddress(priceEpochId, "0x" + tx.from_address);
      epochCommits.set(signingAddress, extractedCommit);
    }

    return epochCommits;
  }

  async getSigningAddress(votingEpochId: number, submitAddress: string): Promise<Address> {
    const rewardEpochId = this.epochs.rewardEpochForVotingEpoch(votingEpochId);
    const voterRegistrations = await this.getVoterRegistrations(rewardEpochId);

    const reg = voterRegistrations.find(reg => reg.submitAddress.toLowerCase() === submitAddress.toLowerCase());
    return reg.signingPolicyAddress.toLowerCase();
  }

  async queryReveals(priceEpochId: PriceEpochId): Promise<Map<Address, RevealData>> {
    const start = this.epochs.votingEpochStartMs(priceEpochId + 1);
    const revealDeadline = this.epochs.revealDeadlineSec(priceEpochId + 1);

    const max = await this.getMaxTimestamp();
    // if (max < revealDeadline) {
    //   throw new Error(`Incomplete reveal picture for current price epoch`);
    // }
    console.log("Reveal selector: ", this.revealSelector);
    console.log(`Start (${priceEpochId + 1}): ${start / 1000}, deadline: ${revealDeadline / 1000}`);

    const txns: TLPTransaction[] = await this.entityManager.getRepository(TLPTransaction).find({
      where: {
        function_sig: this.revealSelector,
        timestamp: Between(start / 1000, revealDeadline / 1000),
      },
    });

    const epochReveals = new Map<Address, RevealData>();
    for (const tx of txns) {
      const reveal = this.encodingUtils().extractReveal(tx.input);
      console.log(`Got reveal response ${tx.from_address} - ${reveal}`);
      const signingAddress = await this.getSigningAddress(priceEpochId, "0x" + tx.from_address);
      epochReveals.set(signingAddress, reveal);
    }

    return epochReveals;
  }

  async querySignatures(priceEpochId: PriceEpochId): Promise<Map<Address, [SignatureData, Timestamp]>> {
    const cached = this.cache.priceEpochSignatures.get(priceEpochId);
    if (cached) {
      // getLogger("IndexerClient").info(`Got cached signatures for epoch ${priceEpochId}`);
      return cached;
    }

    const start = this.epochs.votingEpochStartMs(priceEpochId + 1);
    const nextStart = this.epochs.votingEpochStartMs(priceEpochId + 2);

    // getLogger("IndexerClient").info(
    //   `Querying signatures for epoch ${priceEpochId}, time interval: ${start} - ${nextStart}`
    // );

    const txns: TLPTransaction[] = await this.entityManager.getRepository(TLPTransaction).find({
      where: {
        function_sig: Web3.utils.sha3("sign()")!.slice(2, 10),
        timestamp: Between(start / 1000, nextStart / 1000 - 1),
      },
    });

    const signatures = new Map<Address, [SignatureData, Timestamp]>();
    for (const tx of txns) {
      const sig = this.encodingUtils().extractSignatures(toTxData(tx));
      // getLogger("IndexerClient").info(`Got signature ${tx.from} - ${sig.merkleRoot}`);
      signatures.set("0x" + tx.from_address.toLowerCase(), [sig, tx.timestamp]);
    }

    if ((await this.getMaxTimestamp()) > nextStart) {
      this.cache.priceEpochSignatures.set(priceEpochId, signatures);
    }

    return signatures;
  }

  // async queryFinalize(priceEpochId: PriceEpochId): Promise<[FinalizeData, Timestamp] | undefined> {
  //   const cached = this.cache.priceEpochFinalizes.get(priceEpochId);
  //   if (cached) return cached;

  //   const start = this.epochs.priceEpochStartTimeSec(priceEpochId + 1);
  //   const nextStart = this.epochs.priceEpochStartTimeSec(priceEpochId + 2);

  //   const tx = await this.entityManager.getRepository(TLPTransaction).findOne({
  //     where: {
  //       function_sig: this.encodingUtils().functionSignature("finalize").slice(2),
  //       timestamp: Between(start, nextStart - 1),
  //       status: 1,
  //     },
  //   });

  //   if (tx === null) {
  //     return undefined;
  //   }

  //   const f = this.encodingUtils().extractFinalize(toTxData(tx));
  //   // getLogger("IndexerClient").info(`Got finalize ${tx.from} - ${f.epochId}`);
  //   this.cache.priceEpochFinalizes.set(priceEpochId, [f, tx.timestamp]);
  //   return [f, tx.timestamp];
  // }

  async getVoterWeights(votingEpochId: number): Promise<Map<Address, BN>> {
    const rewardEpochId = this.epochs.rewardEpochForVotingEpoch(votingEpochId);
    const signingPolicy = await this.getSigningPolicy(rewardEpochId);

    const voterWeights = new Map<Address, BN>();
    const voters = signingPolicy.voters;
    const weights = signingPolicy.weights;
    for (let i = 0; i < voters.length; i++) {
      voterWeights.set(voters[i]!.toLowerCase(), toBN(weights[i]));
    }
    return voterWeights;
  }

  async getVoterRegistrations(rewardEpochId: number): Promise<VoterRegistered[]> {
    const cached = this.voterRegistrations.get(rewardEpochId);
    if (cached !== undefined) return cached;

    const previousRewardEpochStartSec = this.epochs.rewardEpochStartMs(rewardEpochId - 1) / 1000;

    console.log("Topic for VoterRegistered", this.voterRegisteredTopic);
    const events = await this.entityManager.getRepository(TLPEvents).find({
      where: {
        topic0: this.voterRegisteredTopic,
        timestamp: MoreThan(previousRewardEpochStartSec),
      },
    });

    const res = this.encodingUtils().extractVoterRegistration(events);
    const parsed = res.filter(x => x.rewardEpochId === rewardEpochId);
    this.voterRegistrations.set(rewardEpochId, parsed);
    return parsed;
  }

  readonly signingPolicies = new Map<RewardEpochId, SigningPolicy>();
  readonly voterRegistrations = new Map<RewardEpochId, VoterRegistered[]>();

  async getSigningPolicy(rewardEpochId: number): Promise<SigningPolicy> {
    const cached = this.signingPolicies.get(rewardEpochId);
    if (cached !== undefined) return cached;

    const previousRewardEpochStartSec = this.epochs.rewardEpochStartMs(rewardEpochId - 1) / 1000;

    const events = await this.entityManager.getRepository(TLPEvents).find({
      where: {
        topic0: this.signingPolicyTopic,
        timestamp: MoreThan(previousRewardEpochStartSec),
      },
    });

    const res = this.encodingUtils().extractSigningPolicies(events);
    const policy = res.filter(x => x.rewardEpochId === rewardEpochId)[0];

    this.signingPolicies.set(rewardEpochId, policy);

    return policy;
  }

  // TODO: Get real offers
  async getRewardOffers(rewardEpochId: RewardEpochId): Promise<RewardOffered[]> {
    const offer: RewardOffered = {
      amount: toBN(10000),
      currencyAddress: ZERO_ADDRESS,
      offerSymbol: toBytes4("BTC"),
      quoteSymbol: toBytes4("USDT"),
      leadProviders: [],
      rewardBeltPPM: toBN(DEFAULT_REWARD_BELT_PPM),
      elasticBandWidthPPM: toBN(ELASTIC_BAND_WIDTH_PPM),
      iqrSharePPM: toBN(IQR_SHARE),
      pctSharePPM: toBN(PCT_SHARE),
      remainderClaimer: ZERO_ADDRESS,
      flrValue: toBN(10),
    };

    return [offer];

    // const cached = this.cache.rewardEpochOffers.get(rewardEpochId);
    // if (cached) return cached;

    // const start = this.epochs.priceEpochStartTimeSec(this.epochs.firstPriceEpochForRewardEpoch(rewardEpochId - 1));
    // const nextStart = this.epochs.priceEpochStartTimeSec(
    //   this.epochs.lastPriceEpochForRewardEpoch(rewardEpochId - 1) + 1
    // );

    // const txns = await this.entityManager.getRepository(TLPTransaction).find({
    //   where: {
    //     function_sig: this.encodingUtils().functionSignature("offerRewards").slice(2),
    //     timestamp: Between(start, nextStart - 1),
    //     status: 1,
    //   },
    //   relations: ["TPLEvents_set"],
    // });

    // const rewardOffers: RewardOffered[] = [];
    // for (const tx of txns) {
    //   const logs1 = tx.TPLEvents_set;
    //   logs1.forEach(log => {
    //     log.topic0;
    //   });

    //   const events = tx.TPLEvents_set;
    //   const offers = this.encodingUtils().extractOffers(events);
    //   // console.log(`Got reward offers ${tx.from_address} - ${offers.length}`);
    //   rewardOffers.push(...offers);
    // }

    // const max = await this.getMaxTimestamp();
    // if (max > nextStart) {
    //   this.cache.rewardEpochOffers.set(rewardEpochId, rewardOffers);
    // }
    // return rewardOffers;
  }
}