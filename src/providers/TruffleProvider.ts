import BN from "bn.js";
import fs from "fs";
import { artifacts, web3 } from "hardhat";
import { AbiItem } from "web3-utils";
import { toBN } from "../../test-utils/utils/test-helpers";
import { PriceOracleInstance, VoterRegistryInstance, VotingInstance, VotingManagerInstance, VotingRewardManagerInstance } from "../../typechain-truffle";
import { BareSignature, BlockData, ClaimReward, EpochData, EpochResult, Offer, RevealBitvoteData, RewardOffered, SignatureData, TxData, VoterWithWeight, deepCopyClaim } from "../voting-interfaces";
import { ZERO_ADDRESS, convertRewardOfferedEvent, hexlifyBN } from "../voting-utils";
import { IVotingProvider } from "./IVotingProvider";

let VotingRewardManager = artifacts.require("VotingRewardManager");
let Voting = artifacts.require("Voting");
let VoterRegistry = artifacts.require("VoterRegistry");
let PriceOracle = artifacts.require("PriceOracle");
let VotingManager = artifacts.require("VotingManager");

export interface TruffleProviderOptions {
   privateKey: string;
}

/**
 * Implements IVotingProvider using Truffle library. 
 * Intended for testing in hardhat environment.
 */
export class TruffleProvider extends IVotingProvider {
   votingRewardManagerContract!: VotingRewardManagerInstance;
   votingContract!: VotingInstance;
   voterRegistryContract!: VoterRegistryInstance;
   priceOracleContract!: PriceOracleInstance;
   votingManagerContract!: VotingManagerInstance;
   wallet: any;

   async initialize(options: TruffleProviderOptions): Promise<void> {
      if (!options.privateKey) {
         throw new Error("privateKey not provided");
      }
      this.wallet = web3.eth.accounts.privateKeyToAccount(options.privateKey);
      let votingAbiPath = "artifacts/contracts/voting/implementation/Voting.sol/Voting.json"
      let rewardsAbiPath = "artifacts/contracts/voting/implementation/VotingRewardManager.sol/VotingRewardManager.json";
      // let voterRegistryAbiPath = "artifacts/contracts/voting/implementation/VoterRegistry.sol/VoterRegistry.json";

      let votingABI = JSON.parse(fs.readFileSync(votingAbiPath).toString()).abi as AbiItem[];
      let rewardsABI = JSON.parse(fs.readFileSync(rewardsAbiPath).toString()).abi as AbiItem[];
      // let voterRegistryABI = JSON.parse(fs.readFileSync(votingAbiPath).toString()).abi as AbiItem[];

      this.abiForName.set("commit", votingABI.find((x: any) => x.name === "commit"));
      this.abiForName.set("revealBitvote", votingABI.find((x: any) => x.name === "revealBitvote"));
      this.abiForName.set("signResult", votingABI.find((x: any) => x.name === "signResult"));
      this.abiForName.set("offerRewards", rewardsABI.find((x: any) => x.name === "offerRewards"));
      this.abiForName.set("claimRewardBodyDefinition", rewardsABI.find((x: any) => x.name === "claimRewardBodyDefinition")?.inputs?.[0]);
      this.abiForName.set("RewardOffered", rewardsABI.find((x: any) => x.name === "RewardOffered"));

      this.functionSignatures.set("commit", web3.eth.abi.encodeFunctionSignature(this.abiForName.get("commit")));
      this.functionSignatures.set("revealBitvote", web3.eth.abi.encodeFunctionSignature(this.abiForName.get("revealBitvote")));
      this.functionSignatures.set("signResult", web3.eth.abi.encodeFunctionSignature(this.abiForName.get("signResult")));
      this.functionSignatures.set("offerRewards", web3.eth.abi.encodeFunctionSignature(this.abiForName.get("offerRewards")));

      this.eventSignatures.set("RewardOffered", web3.eth.abi.encodeEventSignature(this.abiForName.get("RewardOffered")));

      // contracts
      this.votingRewardManagerContract = await VotingRewardManager.at(this.votingRewardManagerContractAddress);
      this.votingContract = await Voting.at(this.votingContractAddress);
      this.voterRegistryContract = await VoterRegistry.at(this.voterRegistryContractAddress);
      this.priceOracleContract = await PriceOracle.at(this.priceOracleContractAddress);
      this.votingManagerContract = await VotingManager.at(this.votingManagerContractAddress);

      this.firstEpochStartSec = (await this.votingManagerContract.BUFFER_TIMESTAMP_OFFSET()).toNumber();
      this.epochDurationSec = (await this.votingManagerContract.BUFFER_WINDOW()).toNumber();
      this.firstRewardedPriceEpoch = (await this.votingManagerContract.firstRewardedPriceEpoch()).toNumber();
      this.rewardEpochDurationInEpochs = (await this.votingManagerContract.rewardEpochDurationInEpochs()).toNumber();
      this.signingDurationSec = (await this.votingManagerContract.signingDurationSec()).toNumber();
   }

   assertWallet() {
      if (!this.wallet) {
         throw new Error("wallet not initialized");
      }
   }

   async claimReward(claim: ClaimReward): Promise<any> {
      let claimReward = deepCopyClaim(claim);
      delete claimReward.hash;
      return this.votingRewardManagerContract.claimReward(hexlifyBN(claimReward), { from: this.wallet.address });
   }

   async offerRewards(offers: Offer[]): Promise<any> {
      let totalAmount = toBN(0);
      offers.forEach((offer) => {
         if (offer.currencyAddress === ZERO_ADDRESS) {
            totalAmount = totalAmount.add(offer.amount);
         }
      });
      return this.votingRewardManagerContract.offerRewards(hexlifyBN(offers), { from: this.wallet.address, value: totalAmount });
   }

   async commit(hash: string): Promise<any> {
      this.assertWallet();
      return this.votingContract.commit(hash, { from: this.wallet.address });
   }

   async revealBitvote(epochData: EpochData): Promise<any> {
      return this.votingContract.revealBitvote(epochData.random!, epochData.merkleRoot!, epochData.bitVote!, epochData.pricesHex!, { from: this.wallet.address });
   }

   async signResult(epochId: number, merkleRoot: string, signature: BareSignature): Promise<any> {
      this.assertWallet();
      return this.votingContract.signResult(epochId,
         merkleRoot,
         {
            v: signature.v,
            r: signature.r,
            s: signature.s
         }, { from: this.wallet.address });
   }

   async finalize(epochId: number, mySignatureHash: string, signatures: BareSignature[]) {
      this.assertWallet();
      return this.votingContract.finalize(epochId, mySignatureHash, signatures, { from: this.wallet.address });
   }

   async publishPrices(epochResult: EpochResult, symbolIndices: number[]): Promise<any> {
      // console.dir(epochResult);
      this.assertWallet();
      return this.priceOracleContract.publishPrices(epochResult.dataMerkleRoot, epochResult.priceEpochId, epochResult.priceMessage, epochResult.symbolMessage, symbolIndices, { from: this.wallet.address });
   }

   async signMessage(message: string): Promise<BareSignature> {
      this.assertWallet();
      return await this.wallet.sign(message);
   }

   async allVotersWithWeightsForRewardEpoch(rewardEpoch: number): Promise<VoterWithWeight[]> {
      const data = await this.voterRegistryContract.votersForRewardEpoch(rewardEpoch);
      const voters = data[0];
      const weights = data[1];
      let result: VoterWithWeight[] = [];
      for (let i = 0; i < voters.length; i++) {
         result.push({ voterAddress: voters[i], weight: weights[i] });
      }
      return result;
   }

   async getBlockNumber(): Promise<number> {
      return web3.eth.getBlockNumber();
   }

   async getBlock(blockNumber: number): Promise<BlockData> {
      let result = await web3.eth.getBlock(blockNumber, true);
      result.timestamp = parseInt('' + result.timestamp, 10);
      return result as any as BlockData;
   }

   getTransactionReceipt(txId: string): Promise<any> {
      return web3.eth.getTransactionReceipt(txId);
   }

   functionSignature(name: "commit" | "revealBitvote" | "signResult" | "offerRewards"): string {
      return this.functionSignatures.get(name)!;
   }

   eventSignature(name: "RewardOffered"): string {
      return this.eventSignatures.get(name)!;
   }

   private decodeFunctionCall(tx: TxData, name: string) {
      const encodedParameters = tx.input!.slice(10); // Drop the function signature
      const parametersEncodingABI = this.abiForName.get(name)!.inputs;
      return web3.eth.abi.decodeParameters(parametersEncodingABI, encodedParameters);
   }

   extractOffers(tx: TxData): RewardOffered[] {
      let result = tx.receipt!.logs
         .filter((x: any) => x.topics[0] === this.eventSignature("RewardOffered"))
         .map((event: any) => {
            let offer = web3.eth.abi.decodeLog(this.abiForName.get("RewardOffered").inputs, event.data, event.topics);
            return convertRewardOfferedEvent(offer as any as RewardOffered);
         });
      return result;
   }

   extractCommitHash(tx: TxData): string {
      return this.decodeFunctionCall(tx, "commit")._commitHash;
   }

   extractRevealBitvoteData(tx: TxData): RevealBitvoteData {
      const resultTmp = this.decodeFunctionCall(tx, "revealBitvote");
      return {
         random: resultTmp._random,
         merkleRoot: resultTmp._merkleRoot,
         bitVote: resultTmp._bitVote,
         prices: resultTmp._prices
      } as RevealBitvoteData;
   }

   extractSignatureData(tx: TxData): SignatureData {
      const resultTmp = this.decodeFunctionCall(tx, "signResult");
      return {
         epochId: parseInt(resultTmp._epochId, 10),
         merkleRoot: resultTmp._merkleRoot,
         v: parseInt(resultTmp.signature.v, 10),
         r: resultTmp.signature.r,
         s: resultTmp.signature.s
      } as SignatureData;
   }

   get senderAddressLowercase(): string {
      this.assertWallet();
      return this.wallet.address.toLowerCase();
   }

}