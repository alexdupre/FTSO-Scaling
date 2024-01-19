import { SubmissionData } from "./IndexerClient";
import { FullVoterRegistrationInfo, RandomAcquisitionStarted, RewardEpochStarted, RewardOffers, SigningPolicyInitialized, VotePowerBlockSelected } from "./events";
import { rewardEpochFeedSequence } from "./ftso-calculation-logic";
import { Address, Feed, RewardEpochId, VotingEpochId } from "./voting-types";

export class RewardEpoch {
   // TODO: think through the mappings!!!

   signingPolicy: SigningPolicyInitialized;
   // delegationAddress => weight (capped WFLR)
   delegationAddressToCappedWeight: Map<Address, bigint>;
   // identifyingAddress => info
   // Only for voters in signing policy
   voterToRegistrationInfo: Map<Address, FullVoterRegistrationInfo>;
   // signingAddress => identifyingAddress
   signingAddressToVoter: Map<Address, Address>;
   // submittingAddress => identifyingAddress
   submitterToVoter: Map<Address, Address>;
   // delegateAddress => identifyingAddress
   delegationAddressToVoter: Map<Address, Address>;

   _canonicalFeedOrder: Feed[]

   constructor(
      previousRewardEpochStartedEvent: RewardEpochStarted,
      randomAcquisitionStartedEvent: RandomAcquisitionStarted,
      rewardOffers: RewardOffers,
      votePowerBlockSelectedEvent: VotePowerBlockSelected,
      signingPolicyInitializedEvent: SigningPolicyInitialized,
      fullVoterRegistrationInfo: FullVoterRegistrationInfo[]
   ) {
      this.signingPolicy = signingPolicyInitializedEvent;

      ///////// Consistency checks /////////
      if (this.signingPolicy.rewardEpochId !== previousRewardEpochStartedEvent.rewardEpochId + 1) {
         throw new Error("Previous Reward Epoch Id is not correct");
      }
      if (this.signingPolicy.rewardEpochId !== randomAcquisitionStartedEvent.rewardEpochId) {
         throw new Error("Random Acquisition Reward Epoch Id is not correct");
      }
      for (let rewardOffer of rewardOffers.rewardOffers) {
         if (this.signingPolicy.rewardEpochId !== rewardOffer.rewardEpochId) {
            throw new Error("Reward Offer Reward Epoch Id is not correct");
         }
      }
      for (let inflationOffer of rewardOffers.inflationOffers) {
         if (this.signingPolicy.rewardEpochId !== inflationOffer.rewardEpochId) {
            throw new Error("Inflation Offer Reward Epoch Id is not correct");
         }
      }
      if (this.signingPolicy.rewardEpochId !== votePowerBlockSelectedEvent.rewardEpochId) {
         throw new Error("Vote Power Block Selected Reward Epoch Id is not correct");
      }
      for (let voterRegistration of fullVoterRegistrationInfo) {
         if (this.signingPolicy.rewardEpochId !== voterRegistration.voterRegistered.rewardEpochId) {
            throw new Error("Voter Registration Reward Epoch Id is not correct");
         }
         if (this.signingPolicy.rewardEpochId !== voterRegistration.voterRegistrationInfo.rewardEpochId) {
            throw new Error("Voter Registration Info Reward Epoch Id is not correct");
         }
      }

      ///////// Data initialization /////////
      this._canonicalFeedOrder = rewardEpochFeedSequence(rewardOffers);
      this.voterToRegistrationInfo = new Map<Address, FullVoterRegistrationInfo>();
      const tmpSigningAddressToVoter = new Map<Address, Address>();
      for(let voterRegistration of fullVoterRegistrationInfo) {
         this.voterToRegistrationInfo.set(voterRegistration.voterRegistered.voter, voterRegistration);
         tmpSigningAddressToVoter.set(voterRegistration.voterRegistered.signingPolicyAddress, voterRegistration.voterRegistered.voter);
      }
      for(let voterSigningAddress of signingPolicyInitializedEvent.voters) {
         if(!tmpSigningAddressToVoter.has(voterSigningAddress)) {
            throw new Error("Critical error: Voter in signing policy not found in voter registration info. This should never happen.");
         }
         let voter = tmpSigningAddressToVoter.get(voterSigningAddress)!
         this.signingAddressToVoter.set(voterSigningAddress, voter);
         const fullVoterRegistrationInfo = this.voterToRegistrationInfo.get(voter);
         if(!fullVoterRegistrationInfo) {
            throw new Error("Critical error: Voter in signing policy not found in voter registration info. This should never happen.");
         }
         this.delegationAddressToCappedWeight.set(fullVoterRegistrationInfo.voterRegistered.delegationAddress, fullVoterRegistrationInfo.voterRegistrationInfo.wNatCappedWeight);
         this.submitterToVoter.set(fullVoterRegistrationInfo.voterRegistered.submitAddress, voter);
      }
   }

   get rewardEpochId(): RewardEpochId {
      return this.signingPolicy.rewardEpochId;
   }

   get startVotingRoundId(): VotingEpochId {
      return this.signingPolicy.startVotingRoundId;
   }

   /**
    * The canonical order of feeds for this reward epoch.
    * Note: consumer should not change the array in any way.
    */
   get canonicalFeedOrder(): Feed[] {      
      return this._canonicalFeedOrder;
   }

   /**
    * Checks if the given address is a valid voter in this reward epoch.
    * The function also checks if the submission voting epoch id is greater than or equal 
    * to the start voting round id. 
    * Warning: this function does not check whether voting epoch id might be in some of subsequent reward epoch.
    * That assurance should be done by the caller.
    * @param submissionData 
    * @returns 
    */
   isSubmissionByEligibleVoter(submissionData: SubmissionData): boolean {
      return !!this.submitterToVoter.get(submissionData.submitAddress) && submissionData.votingEpochId >= this.startVotingRoundId
   }
//    /**
//     * Filters out submissions that are sent by valid submitters.
//     * The submission are first ordered by relativeTimestamp and for submissions with the 
//     * same relativeTimestamp, by transactionIndex. For each submitAddress, only the 
//     * last one in the order is kept. Also only submitAddress for eligible voters
//     * in the reward epoch are kept, while others are filtered out.
//     * @param submissionData 
//     */
//    filterValidSubmitters(submissionData: SubmissionData[]): SubmissionData[] {
//       const result: SubmissionData[] = [];
//       const submitterToLatestSubmissionData = new Map<Address, SubmissionData>();
//       for(let submission of submissionData) {
//          const voter = this.submitterToVoter.get(submission.submitAddress);
//          if(!voter) {
//             continue;
//          }
//          const latestSubmission = submitterToLatestSubmissionData.get(submission.submitAddress);
//          if(!latestSubmission) {
//             submitterToLatestSubmissionData.set(submission.submitAddress, submission);
//             continue;
//          }
//          if(submission.blockNumber > latestSubmission.blockNumber) {
//             submitterToLatestSubmissionData.set(submission.submitAddress, submission);
//             continue;
//          }
//          if(submission.blockNumber === latestSubmission.blockNumber && submission.transactionIndex > latestSubmission.transactionIndex) {
//             submitterToLatestSubmissionData.set(submission.submitAddress, submission);
//             continue;
//          }
//       }
//       for(let latestSubmission of submitterToLatestSubmissionData.values()) {
//          result.push(latestSubmission);
//       }
//       return result;
//    } 
}