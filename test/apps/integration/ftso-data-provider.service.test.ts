import { CONTRACTS, ContractMethodNames, EPOCH_SETTINGS } from "../../../libs/ftso-core/src/configs/networks";

import FakeTimers from "@sinonjs/fake-timers";
import {
  generateVoters,
  generateRewardEpochEvents,
  TestVoter,
  generateTx,
  currentTimeSec,
} from "../../utils/generators";
import { MockIndexerDB } from "../../utils/db";
import { expect } from "chai";
import { ConfigService } from "@nestjs/config";
import { FtsoDataProviderService } from "../../../apps/ftso-data-provider/src/ftso-data-provider.service";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import { CommitData } from "../../../libs/ftso-core/src/utils/CommitData";
import { Feed } from "../../../libs/ftso-core/src/voting-types";
import { EncodingUtils, unPrefix0x } from "../../../libs/ftso-core/src/utils/EncodingUtils";
import { generateRandomAddress } from "../../utils/testRandom";
import {
  encodeCommitPayloadMessage,
  encodeRevealPayloadMessage,
} from "../../../apps/ftso-data-provider/src/response-encoders";
import { getTestFile } from "../../utils/getTestFile";
import { IConfig } from "../../../apps/ftso-data-provider/src/config/configuration";
import { Logger } from "@nestjs/common";

describe(`ftso-data-provider.service (${getTestFile(__filename)})`, () => {
  const feeds: Feed[] = [
    { name: "4254430055534454", decimals: 2 }, // BTC USDT 38,573.26
    { name: "4554480055534454", decimals: 2 }, // ETH USDT 2,175.12
    { name: "464c520055534454", decimals: 5 }, // FLR USDT 0.02042
  ];
  const samplePrices = [38573.26, 2175.12, 0.02042];

  const offerCount = 2;
  const epochSettings = EPOCH_SETTINGS;
  const indexerHistorySec = 1000;
  const enc = EncodingUtils.instance;

  const sigCommit = enc.getFunctionSignature(CONTRACTS.Submission.name, ContractMethodNames.submit1);
  const sigReveal = enc.getFunctionSignature(CONTRACTS.Submission.name, ContractMethodNames.submit2);

  const configValues: IConfig = {
    required_indexer_history_time_sec: indexerHistorySec,
    indexer_top_timeout: 1000,
    voting_round_history_size: 10000,
    price_provider_url: "http://localhost:3000",
    port: -1,
    db_host: "",
    db_name: "",
    db_user: "",
    db_pass: "",
    db_port: -1,
    api_keys: [],
  };

  const configService = new ConfigService(configValues);

  let db: MockIndexerDB;
  let clock: FakeTimers.InstalledClock;
  let mock: MockAdapter;

  before(async () => {
    // Disable NestJS logging
    Logger.overrideLogger(false);
  });

  after(async () => {
    // Re-enable NestJS logging
    Logger.overrideLogger(new Logger());
  });

  beforeEach(async () => {
    db = await MockIndexerDB.create();
    clock = FakeTimers.install({ now: epochSettings.expectedRewardEpochStartTimeSec(0) * 1000 });
    mock = new MockAdapter(axios);
  });

  afterEach(async () => {
    await db.close();
    clock.uninstall();
    mock.restore();
  });

  it("should return correct reveal data", async () => {
    const voters: TestVoter[] = generateVoters(1);
    const rewardEpochId = 1;
    await setUpRewardEpoch(rewardEpochId, voters);

    mock.onPost(/preparePriceFeeds/).reply(200, {
      votingRoundId: 1,
      feedPriceData: feeds.map((f, id) => ({ feed: f.name, price: samplePrices[id] })),
    });

    const service = new FtsoDataProviderService(db.em, configService);

    const submissionAddress = generateRandomAddress();
    const votingRound = epochSettings.expectedFirstVotingRoundForRewardEpoch(rewardEpochId);

    const commit = (await service.getCommitData(votingRound, submissionAddress)).payload;

    const reveal = (await service.getRevealData(votingRound)).payload;

    const expectedCommit = CommitData.hashForCommit(submissionAddress, reveal.random, reveal.encodedValues);
    expect(commit.commitHash).to.be.equal(expectedCommit);
  });

  it("should compute results - multiple voters, same price", async () => {
    const voters: TestVoter[] = generateVoters(10);
    const rewardEpochId = 1;
    await setUpRewardEpoch(rewardEpochId, voters);

    // All voters return the same prices at the moment
    mock.onPost(/preparePriceFeeds/).reply(200, {
      votingRoundId: 1,
      feedPriceData: feeds.map((f, id) => ({ feed: f.name, price: samplePrices[id] })),
    });

    const services = voters.map(() => new FtsoDataProviderService(db.em, configService));
    const votingRound = epochSettings.expectedFirstVotingRoundForRewardEpoch(rewardEpochId);

    clock.tick(1000);

    for (let i = 0; i < voters.length; i++) {
      const encodedCommit = encodeCommitPayloadMessage(
        await services[i].getCommitData(votingRound, voters[i].submitAddress)
      );
      const commitPayload = sigCommit + unPrefix0x(encodedCommit);
      const commitTx = generateTx(
        voters[i].submitAddress,
        CONTRACTS.Submission.address,
        sigCommit,
        1,
        currentTimeSec(),
        commitPayload
      );
      await db.addTransaction([commitTx]);
    }

    clock.tick(epochSettings.votingEpochDurationSeconds * 1000);

    for (let i = 0; i < voters.length; i++) {
      const encodedReveal = encodeRevealPayloadMessage(await services[i].getRevealData(votingRound));
      const revealPayload = sigReveal + unPrefix0x(encodedReveal);
      const revealTx = generateTx(
        voters[i].submitAddress,
        CONTRACTS.Submission.address,
        sigReveal,
        2,
        currentTimeSec(),
        revealPayload
      );
      await db.addTransaction([revealTx]);
    }

    clock.tick(epochSettings.revealDeadlineSeconds * 1000 + 1);

    await db.syncTimeToNow();

    const mRoots = new Set<string>();
    for (let i = 0; i < voters.length; i++) {
      const result = await services[i].getResultData(votingRound);
      expect(result.votingRoundId).to.be.equal(votingRound);
      expect(result.isSecureRandom).to.be.equal(true);
      mRoots.add(result.merkleRoot);

      const fullMerkleTree = await services[i].getFullMerkleTree(votingRound);
      expect(fullMerkleTree.merkleRoot).to.be.equal(result.merkleRoot);
      expect(fullMerkleTree.isSecureRandom).to.be.equal(true);
    }
    expect(mRoots.size).to.be.equal(1);
  });

  describe("benching", () => {
    it("random should be secure with no missed reveals", async () => {
      await runVotingRounds(10, 0, true);
    });
    it("random should be secure with minority benched revealers", async () => {
      await runVotingRounds(10, 3, true);
    });
    it("random should not be secure with less than two non-benched revealers", async () => {
      await runVotingRounds(5, 4, false);
    });

    async function runVotingRounds(votersCount: number, missedRevealers: number, expectedLastSecureRandom: boolean) {
      const voters: TestVoter[] = generateVoters(votersCount);
      const rewardEpochId = 1;
      await setUpRewardEpoch(rewardEpochId, voters);

      mock.onPost(/preparePriceFeeds/).reply(200, {
        votingRoundId: 1,
        feedPriceData: feeds.map((f, id) => ({ feed: f.name, price: samplePrices[id] })),
      });
      mock.onPost(/preparePriceFeeds/).reply(200, {
        votingRoundId: 2,
        feedPriceData: feeds.map((f, id) => ({ feed: f.name, price: samplePrices[id] })),
      });

      const services = voters.map(() => new FtsoDataProviderService(db.em, configService));
      const votingRound = epochSettings.expectedFirstVotingRoundForRewardEpoch(rewardEpochId);

      clock.tick(1000);

      for (let i = 0; i < voters.length; i++) {
        const encodedCommit = encodeCommitPayloadMessage(
          await services[i].getCommitData(votingRound, voters[i].submitAddress)
        );
        const commitPayload = sigCommit + unPrefix0x(encodedCommit);
        const commitTx = generateTx(
          voters[i].submitAddress,
          CONTRACTS.Submission.address,
          sigCommit,
          1,
          currentTimeSec(),
          commitPayload
        );
        await db.addTransaction([commitTx]);
      }

      clock.tick(epochSettings.votingEpochDurationSeconds * 1000);

      for (let i = 0; i < voters.length; i++) {
        const encodedCommit = encodeCommitPayloadMessage(
          await services[i].getCommitData(votingRound + 1, voters[i].submitAddress)
        );
        const commitPayload = sigCommit + unPrefix0x(encodedCommit);
        const commitTx = generateTx(
          voters[i].submitAddress,
          CONTRACTS.Submission.address,
          sigCommit,
          1,
          currentTimeSec(),
          commitPayload
        );
        await db.addTransaction([commitTx]);
      }

      for (let i = 0; i < voters.length; i++) {
        if (i < missedRevealers) continue;

        const encodedReveal = encodeRevealPayloadMessage(await services[i].getRevealData(votingRound));
        const revealPayload = sigReveal + unPrefix0x(encodedReveal);
        const revealTx = generateTx(
          voters[i].submitAddress,
          CONTRACTS.Submission.address,
          sigReveal,
          2,
          currentTimeSec(),
          revealPayload
        );
        await db.addTransaction([revealTx]);
      }

      clock.tick(epochSettings.revealDeadlineSeconds * 1000 + 1);

      await db.syncTimeToNow();

      const secureRandom = missedRevealers === 0;
      for (let i = 0; i < voters.length; i++) {
        const result = await services[i].getResultData(votingRound);
        expect(result.isSecureRandom).to.be.equal(secureRandom);
      }

      clock.tick(epochSettings.votingEpochStartMs(votingRound + 2) - clock.now + 1);

      for (let i = 0; i < voters.length; i++) {
        const encodedReveal = encodeRevealPayloadMessage(await services[i].getRevealData(votingRound + 1));
        const revealPayload = sigReveal + unPrefix0x(encodedReveal);
        const revealTx = generateTx(
          voters[i].submitAddress,
          CONTRACTS.Submission.address,
          sigReveal,
          2,
          currentTimeSec(),
          revealPayload
        );
        await db.addTransaction([revealTx]);
      }

      clock.tick(epochSettings.revealDeadlineSeconds * 1000 + 1);

      await db.syncTimeToNow();

      for (let i = 0; i < voters.length; i++) {
        const result = await services[i].getResultData(votingRound + 1);
        expect(result.isSecureRandom).to.be.equal(expectedLastSecureRandom);
      }
    }
  });

  async function setUpRewardEpoch(rewardEpochId: number, voters: TestVoter[]) {
    const epochEvents = await generateRewardEpochEvents(epochSettings, feeds, offerCount, rewardEpochId, voters);

    await db.addEvent(epochEvents);

    clock.setSystemTime(epochSettings.expectedRewardEpochStartTimeSec(rewardEpochId) * 1000 + 1);

    await db.syncTimeToNow();
  }
});
