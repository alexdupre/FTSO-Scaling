import {
  FullVoterRegistrationInfo,
  RandomAcquisitionStarted,
  RewardEpochStarted,
  RewardOffers,
  SigningPolicyInitialized,
  VotePowerBlockSelected,
} from "./events";
import { rewardEpochFeedSequence } from "./ftso-calculation/feed-ordering";
import { Address, Feed, RewardEpochId, VotingEpochId } from "./voting-types";

export interface VoterWeights {
  readonly submitAddress: string;
  readonly delegationAddress: string;
  readonly delegationWeight: bigint;
  readonly cappedDelegationWeight: bigint;
  readonly feeBIPS: number;
  readonly nodeIDs: string[];
  readonly nodeWeights: bigint[];
}

export class RewardEpoch {
  // TODO: think through the mappings!!!

  readonly orderedVotersSubmissionAddresses: Address[] = [];

  public readonly rewardOffers: RewardOffers;
  public readonly signingPolicy: SigningPolicyInitialized;
  // delegationAddress => weight (capped WFLR)
  readonly delegationAddressToCappedWeight = new Map<Address, bigint>();
  // identifyingAddress => info
  // Only for voters in signing policy
  readonly voterToRegistrationInfo = new Map<Address, FullVoterRegistrationInfo>();
  // signingAddress => identifyingAddress
  readonly signingAddressToVoter = new Map<Address, Address>();
  // submittingAddress => identifyingAddress
  readonly submitterToVoter = new Map<Address, Address>();
  // delegateAddress => identifyingAddress
  readonly delegationAddressToVoter = new Map<Address, Address>();

  readonly submissionAddressToCappedWeight = new Map<Address, bigint>();
  readonly submissionAddressToVoterRegistrationInfo = new Map<Address, FullVoterRegistrationInfo>();
  readonly signingAddressToDelegationAddress = new Map<Address, Address>();
  readonly signingAddressToSigningWeight = new Map<Address, number>();
  readonly signingAddressToVotingPolicyIndex = new Map<Address, number>();

  private readonly _canonicalFeedOrder: Feed[];

  public readonly totalSigningWeight: number = 0;

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
    for (const rewardOffer of rewardOffers.rewardOffers) {
      if (this.signingPolicy.rewardEpochId !== rewardOffer.rewardEpochId) {
        throw new Error("Reward Offer Reward Epoch Id is not correct");
      }
    }
    for (const inflationOffer of rewardOffers.inflationOffers) {
      if (this.signingPolicy.rewardEpochId !== inflationOffer.rewardEpochId) {
        throw new Error("Inflation Offer Reward Epoch Id is not correct");
      }
    }
    if (this.signingPolicy.rewardEpochId !== votePowerBlockSelectedEvent.rewardEpochId) {
      throw new Error("Vote Power Block Selected Reward Epoch Id is not correct");
    }
    for (const voterRegistration of fullVoterRegistrationInfo) {
      if (this.signingPolicy.rewardEpochId !== voterRegistration.voterRegistered.rewardEpochId) {
        throw new Error("Voter Registration Reward Epoch Id is not correct");
      }
      if (this.signingPolicy.rewardEpochId !== voterRegistration.voterRegistrationInfo.rewardEpochId) {
        throw new Error("Voter Registration Info Reward Epoch Id is not correct");
      }
    }

    ///////// Data initialization /////////
    this.rewardOffers = rewardOffers;
    this._canonicalFeedOrder = rewardEpochFeedSequence(rewardOffers);
    const tmpSigningAddressToVoter = new Map<Address, Address>();
    for (const voterRegistration of fullVoterRegistrationInfo) {
      this.voterToRegistrationInfo.set(voterRegistration.voterRegistered.voter, voterRegistration);
      tmpSigningAddressToVoter.set(
        voterRegistration.voterRegistered.signingPolicyAddress,
        voterRegistration.voterRegistered.voter
      );
    }
    for (let i = 0; i < signingPolicyInitializedEvent.voters.length; i++) {
      const voterSigningAddress = signingPolicyInitializedEvent.voters[i];
      const signingWeight = signingPolicyInitializedEvent.weights[i];
      this.totalSigningWeight += signingWeight;
      this.signingAddressToVotingPolicyIndex.set(voterSigningAddress, i);
      if (!tmpSigningAddressToVoter.has(voterSigningAddress)) {
        throw new Error(
          "Critical error: Voter in signing policy not found in voter registration info. This should never happen."
        );
      }
      const voter = tmpSigningAddressToVoter.get(voterSigningAddress)!;
      this.signingAddressToVoter.set(voterSigningAddress, voter);
      const fullVoterRegistrationInfo = this.voterToRegistrationInfo.get(voter);
      if (!fullVoterRegistrationInfo) {
        throw new Error(
          "Critical error: Voter in signing policy not found in voter registration info. This should never happen."
        );
      }
      this.delegationAddressToCappedWeight.set(
        fullVoterRegistrationInfo.voterRegistrationInfo.delegationAddress,
        fullVoterRegistrationInfo.voterRegistrationInfo.wNatCappedWeight
      );
      this.submitterToVoter.set(fullVoterRegistrationInfo.voterRegistered.submitAddress, voter);
      this.submissionAddressToCappedWeight.set(
        fullVoterRegistrationInfo.voterRegistered.submitAddress,
        fullVoterRegistrationInfo.voterRegistrationInfo.wNatCappedWeight
      );
      this.submissionAddressToVoterRegistrationInfo.set(
        fullVoterRegistrationInfo.voterRegistered.submitAddress,
        fullVoterRegistrationInfo
      );
      this.orderedVotersSubmissionAddresses.push(fullVoterRegistrationInfo.voterRegistered.submitAddress);
      this.signingAddressToDelegationAddress.set(
        voterSigningAddress,
        fullVoterRegistrationInfo.voterRegistrationInfo.delegationAddress
      );
      this.signingAddressToSigningWeight.set(voterSigningAddress, signingWeight);
    }
  }

  public get rewardEpochId(): RewardEpochId {
    return this.signingPolicy.rewardEpochId;
  }

  public get startVotingRoundId(): VotingEpochId {
    return this.signingPolicy.startVotingRoundId;
  }

  /**
   * The canonical order of feeds for this reward epoch.
   * Note: consumer should not change the array in any way.
   */
  public get canonicalFeedOrder(): Feed[] {
    return this._canonicalFeedOrder;
  }

  /**
   * Checks if the given address is a valid voter in this reward epoch.
   * @param submissionData
   * @returns
   */
  public isEligibleVoterSubmissionAddress(submitAddress: Address): boolean {
    return this.submitterToVoter.has(submitAddress);
  }

  public isEligibleSignerAddress(signerAddress: Address): boolean {
    return !!this.signingAddressToVoter.get(signerAddress);
  }

  /**
   * Returns weight for participation in median voting.
   * @param submissionAddress
   * @returns
   */
  public ftsoMedianVotingWeight(submissionAddress: Address): bigint {
    if (!this.isEligibleVoterSubmissionAddress(submissionAddress)) {
      throw new Error("Invalid submission address");
    }
    return this.submissionAddressToCappedWeight.get(submissionAddress)!;
  }

  public ftsoRewardingWeight(submissionAddress: Address): bigint {
    return this.ftsoMedianVotingWeight(submissionAddress);
  }

  /**
   * Maps signer address to delegation address.
   * @param signerAddress
   * @returns
   */
  public signerToDelegationAddress(signerAddress: Address): Address | undefined {
    return this.signingAddressToDelegationAddress.get(signerAddress);
  }

  /**
   * Given signer address it returns weight in signing policy.
   * @param signerAddress
   * @returns
   */
  public signerToSigningWeight(signerAddress: Address): number | undefined {
    return this.signingAddressToSigningWeight.get(signerAddress);
  }

  /**
   * Given signer address it returns index in voting policy.
   * @param signerAddress
   * @returns
   */
  public signerToVotingPolicyIndex(signerAddress: Address): number | undefined {
    return this.signingAddressToVotingPolicyIndex.get(signerAddress);
  }

  /**
   * Given a signer address it returns the full voter registration info.
   * @param signerAddress
   * @returns
   */
  public fullVoterRegistrationInfoForSigner(signerAddress: Address): FullVoterRegistrationInfo | undefined {
    const voterAddress = this.signingAddressToVoter.get(signerAddress);
    if (!voterAddress) {
      return undefined;
    }
    return this.voterToRegistrationInfo.get(voterAddress);
  }

  /**
   * Returns a map from submission address to voter weights information.
   * @returns
   */
  public getVoterWeights(): Map<Address, VoterWeights> {
    const result = new Map<Address, VoterWeights>();
    this.orderedVotersSubmissionAddresses.forEach(submissionAddress => {
      const voterRegistrationInfo = this.submissionAddressToVoterRegistrationInfo.get(submissionAddress)!;
      const voterWeights: VoterWeights = {
        submitAddress: voterRegistrationInfo.voterRegistered.submitAddress,
        delegationAddress: voterRegistrationInfo.voterRegistrationInfo.delegationAddress,
        delegationWeight: voterRegistrationInfo.voterRegistrationInfo.wNatWeight,
        cappedDelegationWeight: voterRegistrationInfo.voterRegistrationInfo.wNatCappedWeight,
        feeBIPS: voterRegistrationInfo.voterRegistrationInfo.delegationFeeBIPS,
        nodeIDs: voterRegistrationInfo.voterRegistrationInfo.nodeIds,
        nodeWeights: voterRegistrationInfo.voterRegistrationInfo.nodeWeights,
      };
      result.set(submissionAddress, voterWeights);
    });
    return result;
  }
}
