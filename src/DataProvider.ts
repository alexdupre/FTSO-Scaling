import { FTSOClient } from "./FTSOClient";
import { getLogger, logError } from "./utils/logger";
import { sleepFor } from "./time-utils";

export class DataProvider {
  private readonly logger = getLogger(DataProvider.name);

  constructor(private client: FTSOClient, private myId: number) {}

  /** Used for checking if we need to send reveals in the current price epoch. */
  private hasCommits: boolean = false;
  /** Tracks reward epochs the data provider is registered as a voter for. */
  private readonly registeredRewardEpochs = new Set<number>();

  async run() {
    await this.client.processNewBlocks(); // Initial catchup.
    this.schedulePriceEpochActions();
  }

  schedulePriceEpochActions() {
    const timeSec = this.currentTimeSec();
    const nextEpochStartSec = this.client.epochs.nextPriceEpochStartSec(timeSec);

    setTimeout(async () => {
      try {
        await this.onPriceEpoch(); // TODO: If this runs for a long time, it might get interleave with the next price epoch - is this a problem?
        this.schedulePriceEpochActions();
      } catch (e) {
        logError(this.logger, e, "Error in price epoch, terminating");
        process.exit(1);
      }
    }, (nextEpochStartSec - timeSec + 1) * 1000);
  }

  async onPriceEpoch() {
    const currentPriceEpochId = this.client.epochs.priceEpochIdForTime(this.currentTimeSec());
    const currentRewardEpochId = this.client.epochs.rewardEpochIdForPriceEpochId(currentPriceEpochId);
    this.logger.info(`[${currentPriceEpochId}] Processing price epoch, current reward epoch: ${currentRewardEpochId}.`);

    const previousRewardEpochId = currentRewardEpochId - 1;
    const nextRewardEpochId = currentRewardEpochId + 1;

    if (this.isRegisteredForRewardEpoch(currentRewardEpochId)) {
      await this.runVotingProcotol(currentPriceEpochId);
    }
    // Process new blocks to make sure we pick up reward offers.
    await this.client.processNewBlocks();

    await this.maybeClaimRewards(previousRewardEpochId, currentPriceEpochId);
    await this.maybeRegisterForRewardEpoch(nextRewardEpochId);

    this.logger.info(`[${currentPriceEpochId}] Finished processing price epoch.`);
  }

  private async maybeClaimRewards(previousRewardEpochId: number, currentEpochId: number) {
    if (this.isRegisteredForRewardEpoch(previousRewardEpochId) && this.isFirstPriceEpochInRewardEpoch(currentEpochId)) {
      this.logger.info(`[${currentEpochId}] Claiming rewards for last reward epoch ${previousRewardEpochId}`);
      await this.client.claimRewards(previousRewardEpochId);
    }
  }

  private async runVotingProcotol(currentEpochId: number) {
    this.client.preparePriceFeedsForPriceEpoch(currentEpochId);
    this.logger.info(`[${currentEpochId}] Committing data for current epoch.`);
    await this.client.commit(currentEpochId);

    await sleepFor(2000);
    if (this.hasCommits) {
      const previousEpochId = currentEpochId - 1;
      this.logger.info(`[${currentEpochId}] Revealing data for previous epoch: ${previousEpochId}.`);
      await this.client.reveal(previousEpochId);
      await this.waitForRevealEpochEnd();
      await this.client.processNewBlocks(); // Get reveals
      this.logger.info(`[${currentEpochId}] Calculating results for previous epoch ${previousEpochId} and signing.`);
      await this.client.calculateResultsAndSign(previousEpochId);
      await this.client.tryFinalizeOnceSignaturesReceived(previousEpochId);
    }

    this.hasCommits = true;
  }

  private async maybeRegisterForRewardEpoch(nextRewardEpochId: number) {
    if (this.isRegisteredForRewardEpoch(nextRewardEpochId) || !this.client.rewardEpochOffers.has(nextRewardEpochId)) {
      return;
    }
    this.logger.info(`Registering for next reward epoch ${nextRewardEpochId}`);

    if (this.client.rewardCalculator == undefined) this.client.initializeRewardCalculator(nextRewardEpochId);
    this.client.registerRewardsForRewardEpoch(nextRewardEpochId);
    await this.client.registerAsVoter(nextRewardEpochId);

    this.registeredRewardEpochs.add(nextRewardEpochId);
  }

  private isRegisteredForRewardEpoch(rewardEpochId: number): boolean {
    return this.registeredRewardEpochs.has(rewardEpochId);
  }

  private isFirstPriceEpochInRewardEpoch(priceEpochId: number): boolean {
    const rewardEpoch = this.client.epochs.rewardEpochIdForPriceEpochId(priceEpochId);
    const rewardEpochForPrevious = this.client.epochs.rewardEpochIdForPriceEpochId(priceEpochId - 1);
    return rewardEpochForPrevious != 0 && rewardEpochForPrevious < rewardEpoch;
  }

  private async waitForRevealEpochEnd() {
    const revealPeriodDurationMs = this.client.epochs.revealDurationSec * 1000;
    await sleepFor(revealPeriodDurationMs + 1);
  }

  private currentTimeSec(): number {
    return Math.floor(Date.now() / 1000);
  }
}
