import { getNetworkDetails, requestAccess, signTransaction } from '@stellar/freighter-api';
import {
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { getAppConfig } from './api';
import {
  ConfirmedTransaction,
  resumeSubmittedTransaction,
  sendAndConfirmTransaction,
} from './freighter';
import { SorobanRefundMetadata } from '../types/campaign';
import { GoalVaultContract } from '../generated';

function stringifyErrorDetails(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'Unknown Soroban RPC error.';
  }
}

function getSimulationErrorMessage(simulation: unknown): string {
  const raw = simulation as { error?: unknown };
  return `Soroban simulation failed: ${stringifyErrorDetails(raw.error ?? simulation)}`;
}

export async function submitRefundTransaction(
  campaignId: string,
  contributor: string,
): Promise<SorobanRefundMetadata> {
  const config = await getAppConfig();
  const { contractId, networkPassphrase, rpcUrl } = config.soroban;

  if (!contractId || !networkPassphrase || !rpcUrl) {
    throw new Error(
      'Soroban refund configuration is incomplete. Set the contract, network, and RPC settings on the backend.',
    );
  }

  const walletAddress = await requestAccess();
  if (!walletAddress) {
    throw new Error('Freighter did not return a wallet address for this refund.');
  }

  if (walletAddress !== contributor) {
    throw new Error(
      'The connected Freighter account must match the contributor address entered for the refund.',
    );
  }

  const networkDetails = await getNetworkDetails().catch(() => null);
  if (networkDetails?.networkPassphrase && networkDetails.networkPassphrase !== networkPassphrase) {
    throw new Error(
      'Freighter is connected to a different Stellar network than the configured Soroban refund flow.',
    );
  }

  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith('http://'),
  });

  const sourceAccount = await server.getAccount(walletAddress);
  const contract = new Contract(contractId);

  let transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'refund',
        nativeToScVal(BigInt(campaignId), { type: 'u64' }),
        new Address(contributor).toScVal(),
      ),
    )
    .setTimeout(300)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(getSimulationErrorMessage(simulation));
  }

  transaction = rpc.assembleTransaction(transaction, simulation).build();

  const signedXdr = await signTransaction(transaction.toXDR(), {
    accountToSign: walletAddress,
    networkPassphrase,
  });

  const signedTransaction = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
  const confirmed = await sendAndConfirmTransaction(server, signedTransaction);

  return toRefundReceipt(confirmed, { contractId, networkPassphrase, rpcUrl, walletAddress });
}

function toRefundReceipt(
  confirmed: ConfirmedTransaction,
  context: { contractId: string; networkPassphrase: string; rpcUrl: string; walletAddress: string },
): SorobanRefundMetadata {
  return {
    txHash: confirmed.transactionHash,
    ...context,
    ledger: confirmed.ledger,
    createdAt: confirmed.confirmedAt,
    latestLedger: confirmed.latestLedger,
  };
}

/**
 * Resumes a refund transaction from a previous retryable attempt without
 * signing a new one. See `resumeSubmittedTransaction`.
 */
export async function resumeRefundTransaction(
  submittedTransaction: string,
  contributor: string,
): Promise<SorobanRefundMetadata> {
  const config = await getAppConfig();
  const { contractId, networkPassphrase, rpcUrl } = config.soroban;

  if (!contractId || !networkPassphrase || !rpcUrl) {
    throw new Error(
      'Soroban refund configuration is incomplete. Set the contract, network, and RPC settings on the backend.',
    );
  }

  const confirmed = await resumeSubmittedTransaction(
    rpcUrl,
    networkPassphrase,
    submittedTransaction,
  );
  return toRefundReceipt(confirmed, {
    contractId,
    networkPassphrase,
    rpcUrl,
    walletAddress: contributor,
  });
}

export const executeSorobanRefund = submitRefundTransaction;

/**
 * Typed contract client instance for interacting with the Soroban GoalVaultContract
 */
export const contractClient = new GoalVaultContract();
