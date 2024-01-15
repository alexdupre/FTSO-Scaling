import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EntityManager } from "typeorm";
import Web3 from "web3";
import { IndexerClient } from "../../../libs/ftso-core/src/IndexerClient";
import { calculateResults, rewardEpochFeedSequence } from "../../../libs/ftso-core/src/price-calculation";
import { EpochSettings } from "../../../libs/ftso-core/src/utils/EpochSettings";
import { Bytes32 } from "../../../libs/ftso-core/src/utils/sol-types";
import { hashForCommit, packPrices } from "../../../libs/ftso-core/src/utils/voting-utils";
import { EpochData, RevealData, RewardOffered } from "../../../libs/ftso-core/src/voting-types";
import { sleepFor } from "./utils/time";
import { Api } from "./price-provider-api/generated/provider-api";


const NON_EXISTENT_PRICE = 0;
const web3Helper = new Web3();

const supportedFeeds = [
  "0x4254430055534454", // BTC USDT
  "0x4554480055534454", // ETH USDT
  "0x464c520055534454"  // FLR USDT
]

@Injectable()
export class FtsoCalculatorService {
  private readonly logger = new Logger(FtsoCalculatorService.name);

  // connections to the indexer and price provider
  private readonly indexerClient: IndexerClient;
  private readonly priceProviderClient: Api<unknown>;

  // epoch settings configuration
  private readonly epochSettings: EpochSettings;

  // TODO: Need to clean up old epoch data so the map doesn't grow indefinitely
  private readonly dataByEpoch = new Map<number, EpochData>();

  constructor(manager: EntityManager, configService: ConfigService) {
    this.epochSettings = configService.get<EpochSettings>("epochSettings")!;
    this.indexerClient = new IndexerClient(manager, this.epochSettings);
    this.priceProviderClient = new Api({ baseURL: configService.get<string>("price_provider_url") });
  }

  // Entry point methods for the protocol data provider

  async getCommit(epochId: number, signingAddress: string): Promise<string> {
    const rewardEpochId = this.epochSettings.rewardEpochForVotingEpoch(epochId);

    // Get all offers for the reward epoch both inflation and reward offers
    const offers = await this.indexerClient.getRewardOffers(rewardEpochId);
    if (offers.length === 0) {
      this.logger.error("No offers found for reward epoch: ", rewardEpochId);
    }

    const data = await this.getPricesForEpoch(epochId, offers);
    const hash = hashForCommit(signingAddress, data.random.value, data.priceHex);
    this.dataByEpoch.set(epochId, data);
    this.logger.log(`Commit for epoch ${epochId}: ${hash}`);
    return hash;
  }

  async getReveal(epochId: number): Promise<RevealData | undefined> {
    this.logger.log(`Getting reveal for epoch ${epochId}`);

    const epochData = this.dataByEpoch.get(epochId)!;
    if (epochData === undefined) {
      // TODO: Query indexer if not found - for usecases that are replaying history
      //       Note: same should be done for getCommit.
      this.logger.error(`No data found for epoch ${epochId}`);
      return undefined;
    }
    const revealData: RevealData = {
      random: epochData.random.toString(),
      encodedPrices: epochData.priceHex,
    };

    return revealData;
  }

  async getResult(epochId: number): Promise<[Bytes32, boolean]> {
    // TODO: Added sleep here because the system client calls this before the reveals are properly indexed - need to sort this race condition out.
    await sleepFor(1000);
    const rewardEpochId = this.epochSettings.rewardEpochForVotingEpoch(epochId);
    const offers = await this.indexerClient.getRewardOffers(rewardEpochId);
    const commits = await this.indexerClient.queryCommits(epochId);
    const reveals = await this.indexerClient.queryReveals(epochId);
    const weights = await this.indexerClient.getVoterWeights(epochId);
    const result = await calculateResults(epochId, commits, reveals, offers, weights);
    return [result.merkleRoot, result.randomQuality == 0];
  }

  // Internal methods

  private async getPricesForEpoch(priceEpochId: number, rewardOffers: RewardOffered[]): Promise<EpochData> {
    const feedSequence = rewardEpochFeedSequence(rewardOffers);

    // TODO: do some retries here
    const pricesRes = await this.priceProviderClient.priceProviderApi.getPriceFeeds(
      priceEpochId,
      {feeds: supportedFeeds},
    );

    // This should just be a warning
    if (200 <= pricesRes.status && pricesRes.status < 300) {
      this.logger.warn(`Failed to get prices for epoch ${priceEpochId}: ${pricesRes.data}`);
      // TODO: exit
      throw new Error(`Failed to get prices for epoch ${priceEpochId}: ${pricesRes.data}`);
    }

    const prices = pricesRes.data;

    // transfer prices to 4 byte hex strings and concatenate them
    // make sure that the order of prices is in line with protocol definition
    const extractedPrices = prices.feedPriceData.map(pri => pri.price);

    const data: EpochData = {
      priceHex: packPrices(extractedPrices),
      random: Bytes32.random(),
    };
    return data;
  }


}
