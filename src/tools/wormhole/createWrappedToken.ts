import { Wormhole, signSendWait, wormhole } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import sui from "@wormhole-foundation/sdk/sui";
import aptos from "@wormhole-foundation/sdk/aptos";
import { getSigner } from "./helper";
import {
  Chain,
  Network,
  TokenId,
  TokenAddress,
  UniversalAddress,
  ChainContext,
} from "@wormhole-foundation/sdk";

/**
 * Interface for the input parameters to create a wrapped token
 */
export interface CreateWrappedTokenInput {
  destinationChain: Chain;
  tokenAddress: string;
  network: Network;
}

/**
 * Interface for the response from creating a wrapped token
 */
export interface CreateWrappedTokenResponse {
  success: boolean;
  wrappedToken?: {
    chain: Chain;
    address: string | TokenAddress<Chain> | UniversalAddress;
  };
  attestationTxid?: string;
  error?: string;
}

/**
 * Checks if a token is already wrapped on the destination chain
 * @param wh Wormhole SDK instance
 * @param srcChain Source chain context
 * @param destChain Destination chain context
 * @param tokenAddress Token address on the source chain
 * @returns The wrapped token address if it exists, null otherwise
 */
export const isTokenWrapped = async (
  wh: Wormhole<Network>,
  srcChain: Chain,
  destChain: Chain,
  tokenAddress: string,
): Promise<TokenAddress<Chain> | UniversalAddress | null> => {
  try {
    // Convert token to TokenId format
    const tokenId = Wormhole.tokenId(srcChain, tokenAddress);
    const destChainContext = wh.getChain(destChain);
    const tbDest = await destChainContext.getTokenBridge();

    // Check if the token is already wrapped
    const wrapped = await tbDest.getWrappedAsset(tokenId);
    return wrapped;
  } catch (e) {
    // If an error occurs, the token is not wrapped
    return null;
  }
};

/**
 * Creates a wrapped token on the destination chain
 * @param input Parameters for creating the wrapped token
 * @returns Response with the wrapped token information
 */
export const createWrappedToken = async (
  input: CreateWrappedTokenInput,
): Promise<CreateWrappedTokenResponse> => {
  try {
    const { destinationChain, tokenAddress, network } = input;
    const gasLimit = BigInt(2_500_000);

    // Initialize the Wormhole SDK with all platforms
    const wh = await wormhole(network || "Testnet", [evm, solana, sui, aptos]);

    // Get chain contexts
    const srcChain = wh.getChain("Solana");
    const destChain = wh.getChain(destinationChain);

    // Check if token is already wrapped
    const wrapped = await isTokenWrapped(
      wh,
      "Solana",
      destinationChain,
      tokenAddress,
    );
    if (wrapped) {
      console.log(
        `Token already wrapped on ${destinationChain}. Skipping attestation.`,
      );
      return {
        success: true,
        wrappedToken: {
          chain: destinationChain,
          address: wrapped,
        },
      };
    }

    console.log(
      `No wrapped token found on ${destinationChain}. Proceeding with attestation.`,
    );

    // Destination chain signer setup
    const { signer: destSigner } = await getSigner(destChain, gasLimit);
    const tbDest = await destChain.getTokenBridge();

    // Source chain signer setup
    const { signer: origSigner } = await getSigner(srcChain);

    // Create an attestation transaction on the source chain
    const tbOrig = await srcChain.getTokenBridge();

    // Parse the address properly for the source chain
    const parsedTokenAddress = Wormhole.parseAddress(
      srcChain.chain,
      tokenAddress,
    );
    const signerAddress = Wormhole.parseAddress(
      origSigner.chain(),
      origSigner.address(),
    );

    // Create the attestation transaction
    const attestTxns = tbOrig.createAttestation(
      parsedTokenAddress,
      signerAddress,
    );

    // Sign and send the attestation transaction
    const txids = await signSendWait(srcChain, attestTxns, origSigner);
    console.log("Attestation transaction IDs: ", txids);
    const txid = txids[0]!.txid;
    console.log("Created attestation: ", txid);

    // Retrieve the Wormhole message ID from the attestation transaction
    const msgs = await srcChain.parseTransaction(txid);
    console.log("Parsed Messages:", msgs);

    if (!msgs || msgs.length === 0) {
      throw new Error("No messages found in the transaction");
    }

    // Wait for the VAA to be available
    const timeout = 25 * 60 * 1000;
    const vaa = await wh.getVaa(msgs[0]!, "TokenBridge:AttestMeta", timeout);
    if (!vaa) {
      throw new Error(
        "VAA not found after retries exhausted. Try extending the timeout.",
      );
    }

    console.log("Token Address: ", vaa.payload.token.address);

    // Submit the attestation on the destination chain
    console.log("Attesting asset on destination chain...");

    const subAttestation = tbDest.submitAttestation(
      vaa,
      Wormhole.parseAddress(destSigner.chain(), destSigner.address()),
    );

    const tsx = await signSendWait(destChain, subAttestation, destSigner);
    console.log("Transaction hash: ", tsx);

    // Poll for the wrapped asset until it's available
    let wrappedAsset = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!wrappedAsset && attempts < maxAttempts) {
      try {
        // Convert token to TokenId format
        const tokenId = Wormhole.tokenId(srcChain.chain, tokenAddress);
        wrappedAsset = await tbDest.getWrappedAsset(tokenId);
        console.log("Wrapped asset found:", wrappedAsset);
      } catch (e) {
        attempts++;
        console.log(
          `Wrapped asset not found yet. Attempt ${attempts}/${maxAttempts}`,
        );
        // Wait 2 seconds between attempts
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!wrappedAsset) {
      throw new Error("Failed to get wrapped asset after multiple attempts");
    }

    return {
      success: true,
      wrappedToken: {
        chain: destinationChain,
        address: wrappedAsset,
      },
      attestationTxid: txid,
    };
  } catch (e) {
    console.error("Error creating wrapped token:", e);
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};
